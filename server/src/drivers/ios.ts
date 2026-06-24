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
import { run } from "./sdk";
import {
  availableRuntimeIds,
  listDevices,
  resolveDeviceType,
  resolveRuntime,
  simctl,
} from "./simctl";

interface IosInstance {
  udid: string;
  name: string;
  templateSlug: string;
}

// iOS verbs that don't translate to a simulator (no adb-style reverse / touch
// injection via simctl). Reported as unsupported_on_platform.
const UNSUPPORTED_VERBS: ReadonlySet<DeviceVerb> = new Set(["forward", "input"]);

// Drives iOS simulators via `xcrun simctl`. Each lease creates a brand-new
// simulator of the template's device-type + runtime (native isolation, no
// cloning), boots it, and deletes it on release. Our sims are tagged by name
// prefix so reconciliation finds orphans across crashes without a state file —
// simctl itself is the source of truth.
export class IosDriver implements DeviceDriver {
  private readonly instances = new Map<string, IosInstance>();
  private readonly tagPrefix: string;
  private counter = 0;

  constructor(tagPrefix: string) {
    this.tagPrefix = tagPrefix;
  }

  supports(platform: Platform, verb: DeviceVerb): boolean {
    if (platform === "ios" && UNSUPPORTED_VERBS.has(verb)) return false;
    return true;
  }

  async listAvailableRefs(): Promise<string[]> {
    return availableRuntimeIds();
  }

  async lease(template: TemplateConfig): Promise<DeviceHandle> {
    const [deviceTypeRaw, runtimeRaw] = template.ref.split("|");
    if (!deviceTypeRaw || !runtimeRaw) {
      throw new AppError(
        "template_not_found",
        `iOS template ref must be "<deviceType>|<runtime>": got '${template.ref}'`,
      );
    }
    const deviceType = await resolveDeviceType(deviceTypeRaw.trim());
    const runtime = await resolveRuntime(runtimeRaw.trim());

    this.counter += 1;
    const name = `${this.tagPrefix}${template.slug}-${this.counter}`;
    const created = await simctl(["create", name, deviceType, runtime]);
    if (created.code !== 0) {
      throw new AppError("template_not_found", created.stderr || "simctl create failed");
    }
    const udid = created.stdout.trim();

    await simctl(["boot", udid]);
    await simctl(["bootstatus", udid, "-b"]);

    this.instances.set(udid, { udid, name, templateSlug: template.slug });
    return { instanceId: udid, platform: "ios", templateSlug: template.slug, serial: udid };
  }

  async reset(handle: DeviceHandle, mode: ResetMode): Promise<void> {
    const instance = this.require(handle);
    await simctl(["shutdown", instance.udid]);
    if (mode !== "reboot") {
      // snapshot + wipe: erase restores the pristine factory image.
      await simctl(["erase", instance.udid]);
    }
    await simctl(["boot", instance.udid]);
    await simctl(["bootstatus", instance.udid, "-b"]);
  }

  async destroy(handle: DeviceHandle): Promise<void> {
    const instance = this.instances.get(handle.instanceId);
    if (!instance) return; // idempotent
    await simctl(["shutdown", instance.udid]);
    await simctl(["delete", instance.udid]);
    this.instances.delete(handle.instanceId);
  }

  async shell(
    handle: DeviceHandle,
    command: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const instance = this.require(handle);
    const result = await simctl(["spawn", instance.udid, "/bin/sh", "-c", command]);
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code };
  }

  async install(handle: DeviceHandle, fileName: string, bytes: Buffer): Promise<InstallResult> {
    const instance = this.require(handle);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agtbx-ios-install-"));
    try {
      const upload = path.join(dir, fileName);
      fs.writeFileSync(upload, bytes);

      let appPath: string;
      if (/\.(ipa|zip)$/i.test(fileName)) {
        await run("unzip", ["-o", "-q", upload, "-d", dir], { timeoutMs: 60_000 });
        appPath = this.findApp(dir);
      } else {
        throw new AppError("install_failed", `Expected a .ipa/.zip bundle, got: ${fileName}`);
      }

      const result = await simctl(["install", instance.udid, appPath], 120_000);
      if (result.code !== 0) {
        throw new AppError("install_failed", result.stderr || "simctl install failed");
      }
      return { installed: true, package: await this.bundleId(appPath) };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async forward(): Promise<void> {
    throw new AppError("unsupported_on_platform", "forward is not supported on iOS");
  }

  async screenshot(handle: DeviceHandle): Promise<Buffer> {
    const instance = this.require(handle);
    const tmp = path.join(os.tmpdir(), `agtbx-ios-shot-${instance.udid}.png`);
    const result = await simctl(["io", instance.udid, "screenshot", tmp], 30_000);
    if (result.code !== 0) {
      throw new AppError("install_failed", result.stderr || "screenshot failed");
    }
    const bytes = fs.readFileSync(tmp);
    fs.rmSync(tmp, { force: true });
    return bytes;
  }

  async *logs(handle: DeviceHandle, signal: AbortSignal): AsyncIterable<LogEvent> {
    const instance = this.require(handle);
    const child = spawn("xcrun", ["simctl", "spawn", instance.udid, "log", "stream", "--style", "compact"]);
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
          queue.push({ ts: new Date().toISOString(), level: "I", tag: "oslog", message: line });
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
      while (queue.length > 0) yield queue.shift() as LogEvent;
    }
    child.kill("SIGKILL");
  }

  async input(): Promise<void> {
    throw new AppError("unsupported_on_platform", "input is not supported on iOS");
  }

  async discoverInstances(): Promise<DiscoveredInstance[]> {
    const devices = await listDevices();
    return devices
      .filter((d) => d.name.startsWith(this.tagPrefix))
      .map((d) => ({ ref: d.name, tagged: true }));
  }

  async destroyByRef(ref: string): Promise<void> {
    const devices = await listDevices();
    const match = devices.find((d) => d.name === ref);
    if (!match) return;
    await simctl(["shutdown", match.udid]);
    await simctl(["delete", match.udid]);
    for (const [id, instance] of this.instances) {
      if (instance.name === ref) this.instances.delete(id);
    }
  }

  deviceAccess(handle: DeviceHandle): DeviceAccess | null {
    const instance = this.instances.get(handle.instanceId);
    if (!instance) return null;
    // Hand back the UDID; the agent drives it with its own simctl/xcodebuild.
    return { kind: "simctl", udid: instance.udid };
  }

  instanceCount(): number {
    return this.instances.size;
  }

  // --- internals ----------------------------------------------------------

  private findApp(dir: string): string {
    // Prefer Payload/<App>.app (ipa layout), else any *.app at the top level.
    const payload = path.join(dir, "Payload");
    const roots = [payload, dir].filter((p) => fs.existsSync(p));
    for (const root of roots) {
      const entry = fs.readdirSync(root).find((name) => name.endsWith(".app"));
      if (entry) return path.join(root, entry);
    }
    throw new AppError("install_failed", "No .app bundle found in archive");
  }

  private async bundleId(appPath: string): Promise<string> {
    const plist = path.join(appPath, "Info.plist");
    const result = await run(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleIdentifier", plist],
      { timeoutMs: 10_000 },
    );
    return result.stdout.trim() || "unknown";
  }

  private require(handle: DeviceHandle): IosInstance {
    const instance = this.instances.get(handle.instanceId);
    if (!instance) {
      throw new AppError("session_not_found", `No live simulator for instance ${handle.instanceId}`);
    }
    return instance;
  }
}
