// The device backend abstraction. Everything above this line (sessions, queue,
// cleanup, routes) is platform-agnostic and tested against FakeDriver; the real
// Android/iOS drivers implement this same contract and are validated by the
// [both] driver-contract suite.

export type Platform = "android" | "ios";
export type ResetMode = "snapshot" | "wipe" | "reboot";
export type DeviceVerb =
  | "shell"
  | "install"
  | "forward"
  | "screenshot"
  | "logs"
  | "input";

export interface TemplateConfig {
  slug: string;
  platform: Platform;
  name: string;
  version: number;
  // Driver-specific base reference (e.g. an AVD name or "runtime|deviceType").
  ref: string;
}

export interface DeviceHandle {
  // Driver-local instance id (the clone), distinct from the public sessionId.
  instanceId: string;
  platform: Platform;
  templateSlug: string;
  // Internal transport address (adb serial / sim udid). Never surfaced to agents.
  serial: string;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface InstallResult {
  installed: boolean;
  package: string;
}

export interface LogEvent {
  ts: string;
  level: string;
  tag: string;
  message: string;
}

export type InputSpec =
  | { type: "tap"; x: number; y: number }
  | { type: "swipe"; x1: number; y1: number; x2: number; y2: number };

// A pre-existing instance discovered on the host during reconciliation.
export interface DiscoveredInstance {
  ref: string;
  tagged: boolean;
}

export interface DeviceDriver {
  // Capability matrix — used to reject e.g. android-only `input` on iOS with a
  // clear `unsupported_on_platform` error rather than a silent pass.
  supports(platform: Platform, verb: DeviceVerb): boolean;

  // Cross-check the configured template refs against what actually exists on the
  // host (real drivers enumerate `emulator -list-avds` / `simctl list`).
  listAvailableRefs(): Promise<string[]>;

  lease(template: TemplateConfig): Promise<DeviceHandle>;
  reset(handle: DeviceHandle, mode: ResetMode): Promise<void>;
  destroy(handle: DeviceHandle): Promise<void>;

  shell(handle: DeviceHandle, command: string): Promise<ShellResult>;
  install(
    handle: DeviceHandle,
    fileName: string,
    bytes: Buffer,
  ): Promise<InstallResult>;
  forward(handle: DeviceHandle, remote: number, local: number): Promise<void>;
  screenshot(handle: DeviceHandle): Promise<Buffer>;
  logs(handle: DeviceHandle, signal: AbortSignal): AsyncIterable<LogEvent>;
  input(handle: DeviceHandle, spec: InputSpec): Promise<void>;

  // Reconciliation: enumerate instances on the host so the manager can destroy
  // tagged orphans (ours, from a crashed run) while leaving untagged devices
  // (the user's own AVDs/sims) untouched.
  discoverInstances(): Promise<DiscoveredInstance[]>;
  destroyByRef(ref: string): Promise<void>;

  // How to reach this device over adb, if it has an adb interface (Android does;
  // iOS sims / the fake driver don't). Returns the broker's adb SERVER endpoint
  // plus the device serial — agents point ADB_SERVER_SOCKET at host:port and
  // address the device with `adb -s <serial>`. One shared server, many clients,
  // routed by serial (the model adb is built for); Detox/Appium/Gradle/Flutter
  // all work this way unchanged.
  adbAccess(handle: DeviceHandle): { host: string; port: number; serial: string } | null;

  // Test introspection: live clone count, for leak assertions.
  instanceCount(): number;
}
