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
  type ShellResult,
  type TemplateConfig,
} from "./driver";
import { AppError } from "../errors";

interface FakeInstance {
  ref: string;
  handle: DeviceHandle;
  installed: Set<string>;
  // State captured right after boot, restored by `snapshot` reset.
  snapshotInstalled: Set<string>;
  tagged: boolean;
}

const PACKAGE_FILE_EXTENSIONS = [".apk", ".app", ".ipa"];

// Verbs that only make sense on Android. Drives the `unsupported_on_platform`
// path for iOS (TEST_SPEC D13).
const ANDROID_ONLY_VERBS: ReadonlySet<DeviceVerb> = new Set(["input", "forward"]);

export class FakeDriver implements DeviceDriver {
  private readonly instances = new Map<string, FakeInstance>();
  // "On-disk" instances that exist independent of live leases — seeded orphans
  // plus everything we lease. Reconciliation reads from here.
  private readonly hostInstances = new Map<string, DiscoveredInstance>();
  private readonly tagPrefix: string;
  private counter = 0;

  constructor(
    tagPrefix: string,
    seed: { ref: string; tagged: boolean }[] = [],
  ) {
    this.tagPrefix = tagPrefix;
    for (const item of seed) {
      this.hostInstances.set(item.ref, { ref: item.ref, tagged: item.tagged });
    }
  }

  supports(platform: Platform, verb: DeviceVerb): boolean {
    if (platform === "ios" && ANDROID_ONLY_VERBS.has(verb)) {
      return false;
    }
    return true;
  }

  async listAvailableRefs(): Promise<string[]> {
    // The fake "host" always has exactly the configured templates available.
    return [];
  }

  async lease(template: TemplateConfig): Promise<DeviceHandle> {
    this.counter += 1;
    const instanceId = `fake-${this.counter}`;
    const ref = `${this.tagPrefix}${template.slug}-${this.counter}`;
    const handle: DeviceHandle = {
      instanceId,
      platform: template.platform,
      templateSlug: template.slug,
      serial:
        template.platform === "android"
          ? `emulator-${5554 + this.counter * 2}`
          : `udid-${instanceId}`,
    };
    const instance: FakeInstance = {
      ref,
      handle,
      installed: new Set(),
      snapshotInstalled: new Set(),
      tagged: true,
    };
    this.instances.set(instanceId, instance);
    this.hostInstances.set(ref, { ref, tagged: true });
    return handle;
  }

  async reset(handle: DeviceHandle, mode: ResetMode): Promise<void> {
    const instance = this.require(handle);
    switch (mode) {
      case "snapshot":
        instance.installed = new Set(instance.snapshotInstalled);
        return;
      case "wipe":
        instance.installed = new Set();
        instance.snapshotInstalled = new Set();
        return;
      case "reboot":
        // Soft restart preserves installed state.
        return;
    }
  }

  async destroy(handle: DeviceHandle): Promise<void> {
    const instance = this.instances.get(handle.instanceId);
    if (!instance) return; // idempotent
    this.instances.delete(handle.instanceId);
    this.hostInstances.delete(instance.ref);
  }

  async shell(handle: DeviceHandle, command: string): Promise<ShellResult> {
    const instance = this.require(handle);
    if (/getprop\s+ro\.build\.version\.sdk/.test(command)) {
      return { stdout: "35\n", stderr: "", exitCode: 0 };
    }
    const pmMatch = command.match(/pm list packages(?:\s+(\S+))?/);
    if (pmMatch) {
      const filter = pmMatch[1];
      const lines = [...instance.installed]
        .filter((pkg) => (filter ? pkg.includes(filter) : true))
        .map((pkg) => `package:${pkg}`);
      return { stdout: lines.length ? `${lines.join("\n")}\n` : "", stderr: "", exitCode: 0 };
    }
    // Default: echo-like behaviour so round-trip tests have deterministic output.
    return { stdout: `${command}\n`, stderr: "", exitCode: 0 };
  }

  async install(
    handle: DeviceHandle,
    fileName: string,
    bytes: Buffer,
  ): Promise<InstallResult> {
    const instance = this.require(handle);
    const lower = fileName.toLowerCase();
    if (!PACKAGE_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      throw new AppError(
        "install_failed",
        `Not an installable package: ${fileName}`,
      );
    }
    if (bytes.length === 0) {
      throw new AppError("install_failed", `Empty package: ${fileName}`);
    }
    const base = fileName
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-zA-Z0-9]+/g, "");
    const pkg = `com.fake.${base || "app"}`;
    instance.installed.add(pkg);
    return { installed: true, package: pkg };
  }

  async forward(
    handle: DeviceHandle,
    _remote: number,
    _local: number,
  ): Promise<void> {
    this.require(handle);
  }

  async screenshot(handle: DeviceHandle): Promise<Buffer> {
    this.require(handle);
    // Minimal PNG signature + filler so callers see bytes > 0.
    return Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
  }

  async *logs(
    handle: DeviceHandle,
    signal: AbortSignal,
  ): AsyncIterable<LogEvent> {
    this.require(handle);
    for (let i = 0; i < 3; i += 1) {
      if (signal.aborted) return;
      yield {
        ts: new Date(0).toISOString(),
        level: "I",
        tag: "FakeDriver",
        message: `log line ${i}`,
      };
    }
  }

  async input(handle: DeviceHandle, _spec: InputSpec): Promise<void> {
    this.require(handle);
  }

  async discoverInstances(): Promise<DiscoveredInstance[]> {
    return [...this.hostInstances.values()];
  }

  async destroyByRef(ref: string): Promise<void> {
    this.hostInstances.delete(ref);
    for (const [id, instance] of this.instances) {
      if (instance.ref === ref) {
        this.instances.delete(id);
      }
    }
  }

  deviceAccess(): DeviceAccess | null {
    return null; // the fake driver has no real device interface
  }

  instanceCount(): number {
    return this.instances.size;
  }

  private require(handle: DeviceHandle): FakeInstance {
    const instance = this.instances.get(handle.instanceId);
    if (!instance) {
      throw new AppError(
        "session_not_found",
        `No live device for instance ${handle.instanceId}`,
      );
    }
    return instance;
  }
}
