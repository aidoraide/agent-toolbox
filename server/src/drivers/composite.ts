import { AppError } from "../errors.js";
import type {
  DeviceAccess,
  DeviceDriver,
  DeviceHandle,
  DeviceVerb,
  DiscoveredInstance,
  InputSpec,
  InstallResult,
  LogEvent,
  Platform,
  ResetMode,
  ShellResult,
  TemplateConfig,
} from "./driver.js";

/**
 * Runs multiple platform drivers behind one DeviceDriver, routing every call to
 * the driver for the relevant platform. Lets a single broker process lease both
 * Android emulators and iOS simulators — route by template.platform (lease) or
 * handle.platform (everything else). The SessionManager already keeps per-
 * platform queues + limits, so it works unchanged on top of this.
 */
export class CompositeDriver implements DeviceDriver {
  constructor(
    private readonly drivers: Partial<Record<Platform, DeviceDriver>>,
  ) {}

  private driverFor(platform: Platform): DeviceDriver {
    const driver = this.drivers[platform];
    if (!driver) {
      throw new AppError(
        "unsupported_on_platform",
        `No driver registered for platform "${platform}"`,
      );
    }
    return driver;
  }

  private all(): DeviceDriver[] {
    return Object.values(this.drivers).filter(
      (d): d is DeviceDriver => d != null,
    );
  }

  supports(platform: Platform, verb: DeviceVerb): boolean {
    return this.drivers[platform]?.supports(platform, verb) ?? false;
  }

  async listAvailableRefs(): Promise<string[]> {
    const lists = await Promise.all(this.all().map((d) => d.listAvailableRefs()));
    return lists.flat();
  }

  lease(template: TemplateConfig): Promise<DeviceHandle> {
    return this.driverFor(template.platform).lease(template);
  }

  reset(handle: DeviceHandle, mode: ResetMode): Promise<void> {
    return this.driverFor(handle.platform).reset(handle, mode);
  }

  destroy(handle: DeviceHandle): Promise<void> {
    return this.driverFor(handle.platform).destroy(handle);
  }

  shell(handle: DeviceHandle, command: string): Promise<ShellResult> {
    return this.driverFor(handle.platform).shell(handle, command);
  }

  install(
    handle: DeviceHandle,
    fileName: string,
    bytes: Buffer,
  ): Promise<InstallResult> {
    return this.driverFor(handle.platform).install(handle, fileName, bytes);
  }

  forward(handle: DeviceHandle, remote: number, local: number): Promise<void> {
    return this.driverFor(handle.platform).forward(handle, remote, local);
  }

  screenshot(handle: DeviceHandle): Promise<Buffer> {
    return this.driverFor(handle.platform).screenshot(handle);
  }

  logs(handle: DeviceHandle, signal: AbortSignal): AsyncIterable<LogEvent> {
    return this.driverFor(handle.platform).logs(handle, signal);
  }

  input(handle: DeviceHandle, spec: InputSpec): Promise<void> {
    return this.driverFor(handle.platform).input(handle, spec);
  }

  async discoverInstances(): Promise<DiscoveredInstance[]> {
    const lists = await Promise.all(this.all().map((d) => d.discoverInstances()));
    return lists.flat();
  }

  async destroyByRef(ref: string): Promise<void> {
    // Refs don't carry their platform, so ask every driver. Each acts only on
    // refs it owns (Android: "agtbx-<port>"; iOS: "agtbx-<slug>-<n>") and is a
    // no-op otherwise, so calling all of them is safe.
    for (const driver of this.all()) {
      await driver.destroyByRef(ref);
    }
  }

  deviceAccess(handle: DeviceHandle): DeviceAccess | null {
    return this.driverFor(handle.platform).deviceAccess(handle);
  }

  instanceCount(): number {
    return this.all().reduce((sum, d) => sum + d.instanceCount(), 0);
  }
}
