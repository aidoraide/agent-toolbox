import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AppError } from "../errors";
import {
  type DeviceAccess,
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
import { openProxy, type Proxy } from "../util/tunnel";

interface AndroidInstance {
  instanceId: string;
  ref: string;
  port: number;
  serial: string;
  avd: string;
  templateSlug: string;
  // 0.0.0.0 TCP proxy to this emulator's adb daemon, for container/remote
  // `adb connect`.
  adbProxy: Proxy | null;
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
  // Ports reserved and mid-boot — recorded in the state file BEFORE booting so a
  // server crash during boot is still recoverable by the next run's reconcile.
  private readonly pendingPorts = new Map<number, { ref: string; avd: string }>();
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

    // Record intent-to-boot in the state file before launching, so a crash
    // mid-boot leaves a trail the next run's reconcile can clean up.
    this.pendingPorts.set(port, { ref, avd: template.ref });
    this.persist();

    let adbProxy: Proxy | null = null;
    try {
      this.bootEmulator(template.ref, port);
      await this.waitForBoot(serial);
      await this.disableAnimations(serial);
      // Expose the emulator's adb daemon (console port + 1) on a host-reachable
      // 0.0.0.0 port so a container can `adb connect host.docker.internal:<port>`.
      adbProxy = await openProxy({ host: "127.0.0.1", port: port + 1 });
    } catch (err) {
      // Free the reservation and kill any half-booted emulator.
      adbProxy?.close();
      await adb(serial, ["emu", "kill"]).catch(() => undefined);
      this.reservedPorts.delete(port);
      this.pendingPorts.delete(port);
      this.persist();
      throw err;
    }

    const instance: AndroidInstance = {
      instanceId,
      ref,
      port,
      serial,
      avd: template.ref,
      templateSlug: template.slug,
      adbProxy,
    };
    this.pendingPorts.delete(port);
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
    instance.adbProxy?.close();
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

  deviceAccess(handle: DeviceHandle): DeviceAccess | null {
    const instance = this.instances.get(handle.instanceId);
    if (!instance) return null;
    // The broker's adb server (default 5037) already owns this emulator. Agents
    // point ADB_SERVER_SOCKET here and use `adb -s <serial>`.
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT ?? 5037);
    return {
      kind: "adb",
      host: "127.0.0.1",
      port,
      serial: instance.serial,
      connectPort: instance.adbProxy?.port ?? 0,
    };
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
        // Host GPU (Metal on macOS), offscreen. Software rendering
        // (swiftshader) is fine for headless instrumented tests but a real
        // React Native / Expo app needs a real GPU to render and init its
        // bridge, or it never becomes "ready" for the test runner. Override
        // with TOOLBOX_EMULATOR_GPU if needed.
        "-gpu", process.env.TOOLBOX_EMULATOR_GPU ?? "auto",
        // Give /data enough room for a real app. AVDs without an explicit
        // disk.dataPartition.size fall back to a small default that can't hold a
        // large APK plus its dex/ART extraction — the install fails with "not
        // enough space" (and a near-full /data also makes launches crash). Match
        // what production-grade AVDs set (6G). Override with
        // TOOLBOX_EMULATOR_PARTITION_MB.
        "-partition-size", process.env.TOOLBOX_EMULATOR_PARTITION_MB ?? "6144",
        // Unique marker in the process args so cleanup can identify OUR
        // emulators precisely — never the user's own.
        "-prop", "agtbx.managed=1",
      ],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
  }

  // UI test frameworks (Espresso/UiAutomator) require animations off, or they
  // flake/fail. Safe default for a device-testing broker.
  private async disableAnimations(serial: string): Promise<void> {
    for (const key of ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"]) {
      await adb(serial, ["shell", "settings", "put", "global", key, "0"]).catch(() => undefined);
    }
  }

  private async waitForBoot(serial: string): Promise<void> {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    await adb(serial, ["wait-for-device"], BOOT_TIMEOUT_MS);

    // HARD requirement: framework boot complete. This is the only condition that
    // may fail the lease (same as before) — a device that never reaches it is
    // genuinely broken.
    await this.waitForProp(serial, "sys.boot_completed", "1", deadline);

    // BEST-EFFORT settle: `sys.boot_completed` fires while services are still
    // coming up and (on a cold boot) system apps are still crashing/restarting,
    // which makes the first app install+launch flaky. Wait for a couple of
    // "system has settled" signals to converge — but NEVER fail the lease if a
    // probe doesn't, so a readiness check can only HELP, never break leasing.
    // The test harness retries launches as the real backstop.
    await this.settleAfterBoot(serial);
  }

  private async waitForProp(
    serial: string,
    prop: string,
    expected: string,
    deadline: number,
  ): Promise<void> {
    while (Date.now() < deadline) {
      const result = await adb(serial, ["shell", "getprop", prop], 10_000).catch(
        () => null,
      );
      if (result && result.stdout.trim() === expected) return;
      await sleep(2000);
    }
    throw new AppError(
      "install_failed",
      `Emulator ${serial} did not reach ${prop}=${expected} in time`,
    );
  }

  private async settleAfterBoot(serial: string): Promise<void> {
    const softDeadline = Date.now() + 90_000;

    // dev.bootcomplete is set slightly after sys.boot_completed.
    await this.pollBestEffort(softDeadline, async () => {
      const r = await adb(serial, ["shell", "getprop", "dev.bootcomplete"], 10_000).catch(
        () => null,
      );
      return r != null && r.stdout.trim() === "1";
    });

    // Package manager can resolve the framework package — a cheap proxy for "pm
    // finished its own startup and can service an install + immediate launch".
    await this.pollBestEffort(softDeadline, async () => {
      const r = await adb(serial, ["shell", "pm", "path", "android"], 10_000).catch(
        () => null,
      );
      return r != null && r.stdout.includes("package:");
    });

    // Brief final settle for late-starting services (Play Services, etc.).
    await sleep(3000);
  }

  // Poll `probe` until it returns true or the soft deadline passes; returns
  // either way. For readiness signals that should improve reliability without
  // ever being able to fail the lease.
  private async pollBestEffort(
    deadline: number,
    probe: () => Promise<boolean>,
  ): Promise<void> {
    while (Date.now() < deadline) {
      if (await probe().catch(() => false)) return;
      await sleep(2000);
    }
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
    const data: PersistedInstance[] = [
      ...[...this.instances.values()].map((i) => ({ ref: i.ref, port: i.port, avd: i.avd })),
      ...[...this.pendingPorts.entries()].map(([port, v]) => ({ ref: v.ref, port, avd: v.avd })),
    ];
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
