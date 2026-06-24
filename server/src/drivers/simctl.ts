import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function simctl(args: string[], timeoutMs = 180_000): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync("xcrun", ["simctl", ...args], {
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? "",
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

async function simctlJson(args: string[]): Promise<unknown> {
  const result = await simctl([...args, "-j"]);
  return JSON.parse(result.stdout);
}

export async function resolveDeviceType(nameOrId: string): Promise<string> {
  if (nameOrId.includes("SimDeviceType")) return nameOrId;
  const data = (await simctlJson(["list", "devicetypes"])) as {
    devicetypes: { name: string; identifier: string }[];
  };
  const match = data.devicetypes.find((d) => d.name === nameOrId || d.identifier === nameOrId);
  if (!match) throw new Error(`Unknown device type: ${nameOrId}`);
  return match.identifier;
}

export async function resolveRuntime(nameOrId: string): Promise<string> {
  if (nameOrId.includes("SimRuntime")) return nameOrId;
  const data = (await simctlJson(["list", "runtimes"])) as {
    runtimes: { name: string; identifier: string; version: string; isAvailable: boolean }[];
  };
  const match = data.runtimes.find(
    (r) => r.isAvailable && (r.identifier === nameOrId || r.name === nameOrId || r.version === nameOrId),
  );
  if (!match) throw new Error(`Unknown or unavailable runtime: ${nameOrId}`);
  return match.identifier;
}

export async function availableRuntimeIds(): Promise<string[]> {
  const data = (await simctlJson(["list", "runtimes"])) as {
    runtimes: { identifier: string; isAvailable: boolean }[];
  };
  return data.runtimes.filter((r) => r.isAvailable).map((r) => r.identifier);
}

// All simulator devices keyed by runtime, flattened with their name + udid.
export async function listDevices(): Promise<{ name: string; udid: string; state: string }[]> {
  const data = (await simctlJson(["list", "devices"])) as {
    devices: Record<string, { name: string; udid: string; state: string }[]>;
  };
  const out: { name: string; udid: string; state: string }[] = [];
  for (const list of Object.values(data.devices)) {
    for (const device of list) out.push({ name: device.name, udid: device.udid, state: device.state });
  }
  return out;
}
