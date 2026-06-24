import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AppError } from "../errors";
import {
  type DeviceDriver,
  type DeviceHandle,
  type DeviceVerb,
  type DiscoveredInstance,
  type InputSpec,
  type InstallResult,
  type LogEvent,
  type Platform,
  type ResetMode,
  type TemplateConfig,
} from "./driver";
import { aapt2Path, adb, adbPath, emulatorPath, listAvds, run, runBinary } from "./sdk";

interface AndroidInstance {
  instanceId: string;
  ref: string;
  port: number;
  serial: string;
  avd: string;
  templateSlug: string;
}

interface PersistedInstance {
  ref: string;
  port: number;
  avd: string;
}

const BOOT_TIMEOUT_MS = 180_000;
const PORT_RANGE_START = 5554;
const PORT_RANGE_END = 5682; // adb only talks to even ports in this window

// Drives real Android emulators. Isolation comes from booting each lease as a
// `-read-only` instance of the base AVD: every instance gets its own ephemeral
// overlay, so concurrent leases of the same template never collide and nothing
// is written back to the base. We track our own emulator *processes* (by port)
// in a state file so reconciliation can kill orphans from a crashed run without
// touching the user's own running emulators.
export class AndroidDriver implements DeviceDriver {
  private readonly instances = new Map<string, AndroidInstance>();
  private readonly statePath: string;
  private readonly tagPrefix: string;
  private counter = 0;
  // Ports we've handed out (or that external emulators already occupy). Reserved
  // synchronously so concurrent leases never pick the same port.
  private readonly reservedPorts = new Set<number>();
  private externalScan: Promise<void> | null = null;

  constructor(cacheDir: string, tagPrefix: string) {
    this.tagPrefix = tagPrefix;
    this.statePath = path.join(cacheDir, "android-instances.json");
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  supports(_platform: Platform, _verb: DeviceVerb): boolean {
    return true;
  }

  async listAvailableRefs(): Promise<string[]> {
    return listAvds();
  }

  async lease(template: TemplateConfig): Promise<DeviceHandle> {
    const avds = await listAvds();
    if (!avds.includes(template.ref)) {
      throw new AppError(
        "template_not_found",
        `AVD '${template.ref}' for template '${template.slug}' not found. Available: ${avds.join(", ")}`,
      );
    }

    // Seed external/in-use ports once (best-effort), then reserve a port
    // synchronously — no await between picking and reserving, so concurrent
    // leases get distinct ports.
    await this.ensureExternalPorts();
    const port = this.reservePort();
    const serial = `emulator-${port}`;
    this.counter += 1;
    const instanceId = `android-${port}`;
    const ref = `${this.tagPrefix}${port}`;

    try {
      this.bootEmulator(template.ref, port);
      await this.waitForBoot(serial);
    } catch (err) {
      // Free the reservation and kill any half-booted emulator.
      await adb(serial, ["emu", "kill"]).catch(() => undefined);
      this.reservedPorts.delete(port);
      throw err;
    }

    const instance: AndroidInstance = {
      instanceId,
      ref,
      port,
      serial,
      avd: template.ref,
      templateSlug: template.slug,
    };
    this.instances.set(instanceId, instance);
    this.persist();

    return {
      instanceId,
      platform: "android",
      templateSlug: template.slug,
      serial,
    };
  }

  async reset(handle: DeviceHandle, mode: ResetMode): Promise<void> {
    const instance = this.require(handle);
    if (mode === "reboot") {
      await adb(instance.serial, ["reboot"]);
      await this.waitForBoot(instance.serial);
      return;
    }
    // snapshot + wipe: the read-only overlay is ephemeral, so killing and
    // re-booting restores the pristine base image (clears all installs).
    await adb(instance.serial, ["emu", "kill"]);
    await this.waitForGone(instance.serial);
    this.bootEmulator(instance.avd, instance.port);
    await this.waitForBoot(instance.serial);
  }

  async destroy(handle: DeviceHandle): Promise<void> {
    const instance = this.instances.get(handle.instanceId);
    if (!instance) return; // idempotent
    await adb(instance.serial, ["emu", "kill"]);
    await this.waitForGone(instance.serial);
    this.instances.delete(handle.instanceId);
    this.reservedPorts.delete(instance.port);
    this.persist();
  }

  async shell(handle: DeviceHandle, command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const instance = this.require(handle);
    const result = await adb(instance.serial, ["shell", command]);
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code };
  }

  async install(handle: DeviceHandle, fileName: string, bytes: Buffer): Promise<InstallResult> {
    const instance = this.require(handle);
    const tmp = path.join(os.tmpdir(), `agtbx-install-${Date.now()}-${fileName}`);
    fs.writeFileSync(tmp, bytes);
    try {
      const result = await adb(instance.serial, ["install", "-r", "-t", tmp], 120_000);
      if (!/Success/.test(result.stdout) && result.code !== 0) {
        throw new AppError("install_failed", result.stderr || result.stdout || "adb install failed");
      }
      return { installed: true, package: await this.packageName(tmp) };
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  async forward(handle: DeviceHandle, remote: number, local: number): Promise<void> {
    const instance = this.require(handle);
    // `adb reverse` lets the device reach a port on the host (the test server).
    const result = await adb(instance.serial, ["reverse", `tcp:${remote}`, `tcp:${local}`]);
    if (result.code !== 0) {
      throw new AppError("invalid_argument", result.stderr || "adb reverse failed");
    }
  }

  async screenshot(handle: DeviceHandle): Promise<Buffer> {
    const instance = this.require(handle);
    return runBinary(adbPath(), ["-s", instance.serial, "exec-out", "screencap", "-p"], 30_000);
  }

  async *logs(handle: DeviceHandle, signal: AbortSignal): AsyncIterable<LogEvent> {
    const instance = this.require(handle);
    const child = spawn(adbPath(), ["-s", instance.serial, "logcat", "-v", "brief"]);
    signal.addEventListener("abort", () => child.kill("SIGKILL"));

    let buffer = "";
    const queue: LogEvent[] = [];
    let notify: (() => void) | null = null;
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) {
          queue.push({ ts: new Date().toISOString(), level: "I", tag: "logcat", message: line });
          notify?.();
        }
        nl = buffer.indexOf("\n");
      }
    });
    let done = false;
    child.on("close", () => {
      done = true;
      notify?.();
    });

    while (!signal.aborted && !done) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        notify = null;
      }
      while (queue.length > 0) {
        yield queue.shift() as LogEvent;
      }
    }
    child.kill("SIGKILL");
  }

  async input(handle: DeviceHandle, spec: InputSpec): Promise<void> {
    const instance = this.require(handle);
    if (spec.type === "tap") {
      await adb(instance.serial, ["shell", "input", "tap", String(spec.x), String(spec.y)]);
    } else {
      await adb(instance.serial, [
        "shell", "input", "swipe",
        String(spec.x1), String(spec.y1), String(spec.x2), String(spec.y2),
      ]);
    }
  }

  async discoverInstances(): Promise<DiscoveredInstance[]> {
    // Our own instances (live + persisted from a prior run) are tagged orphans
    // to be reaped. We never report the user's other emulators, so they are
    // never touched.
    const persisted = this.readPersisted();
    return persisted.map((p) => ({ ref: p.ref, tagged: true }));
  }

  async destroyByRef(ref: string): Promise<void> {
    const persisted = this.readPersisted();
    const match = persisted.find((p) => p.ref === ref);
    if (!match) return;
    await adb(`emulator-${match.port}`, ["emu", "kill"]);
    this.reservedPorts.delete(match.port);
    for (const [id, instance] of this.instances) {
      if (instance.ref === ref) this.instances.delete(id);
    }
    this.writePersisted(this.readPersisted().filter((p) => p.ref !== ref));
  }

  instanceCount(): number {
    return this.instances.size;
  }

  // --- internals ----------------------------------------------------------

  private bootEmulator(avd: string, port: number): void {
    const child = spawn(
      emulatorPath(),
      [
        "-avd", avd,
        "-read-only",
        "-port", String(port),
        "-no-window",
        "-no-audio",
        "-no-boot-anim",
        "-no-snapshot",
        "-gpu", "swiftshader_indirect",
        // Unique marker in the process args so cleanup can identify OUR
        // emulators precisely — never the user's own.
        "-prop", "agtbx.managed=1",
      ],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
  }

  private async waitForBoot(serial: string): Promise<void> {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    await adb(serial, ["wait-for-device"], BOOT_TIMEOUT_MS);
    while (Date.now() < deadline) {
      const result = await adb(serial, ["shell", "getprop", "sys.boot_completed"], 10_000);
      if (result.stdout.trim() === "1") return;
      await sleep(2000);
    }
    throw new AppError("install_failed", `Emulator ${serial} did not finish booting in time`);
  }

  private async waitForGone(serial: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const result = await adb(null, ["devices"]);
      if (!result.stdout.includes(serial)) return;
      await sleep(500);
    }
  }

  // Seed reservedPorts with any emulator already attached (the user's own, or
  // ours from a prior run). Runs at most once; safe to await concurrently.
  private async ensureExternalPorts(): Promise<void> {
    if (!this.externalScan) {
      this.externalScan = (async () => {
        const devices = (await adb(null, ["devices"])).stdout;
        for (const m of devices.matchAll(/emulator-(\d+)/g)) {
          this.reservedPorts.add(Number(m[1]));
        }
      })();
    }
    await this.externalScan;
  }

  // Synchronous: the caller must not await between this returning and using the
  // port, so concurrent leases can't collide.
  private reservePort(): number {
    for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port += 2) {
      if (!this.reservedPorts.has(port)) {
        this.reservedPorts.add(port);
        return port;
      }
    }
    throw new AppError("invalid_argument", "No free emulator port available");
  }

  private async packageName(apkPath: string): Promise<string> {
    const aapt2 = aapt2Path();
    if (!aapt2) return "unknown";
    const result = await run(aapt2, ["dump", "packagename", apkPath], { timeoutMs: 15_000 });
    return result.stdout.trim() || "unknown";
  }

  private require(handle: DeviceHandle): AndroidInstance {
    const instance = this.instances.get(handle.instanceId);
    if (!instance) {
      throw new AppError("session_not_found", `No live device for instance ${handle.instanceId}`);
    }
    return instance;
  }

  private persist(): void {
    const data: PersistedInstance[] = [...this.instances.values()].map((i) => ({
      ref: i.ref,
      port: i.port,
      avd: i.avd,
    }));
    this.writePersisted(data);
  }

  private readPersisted(): PersistedInstance[] {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, "utf8")) as PersistedInstance[];
    } catch {
      return [];
    }
  }

  private writePersisted(data: PersistedInstance[]): void {
    fs.writeFileSync(this.statePath, JSON.stringify(data));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
