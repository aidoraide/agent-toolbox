import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Resolve the Android SDK toolchain from the environment, falling back to the
// macOS default location. Tools are referenced by absolute path because the SDK
// is rarely fully on PATH.
export function sdkRoot(): string {
  const fromEnv = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const fallback = path.join(os.homedir(), "Library", "Android", "sdk");
  return fallback;
}

export function adbPath(): string {
  return path.join(sdkRoot(), "platform-tools", "adb");
}

export function emulatorPath(): string {
  return path.join(sdkRoot(), "emulator", "emulator");
}

// Resolve a tool from the highest-versioned build-tools dir (aapt2, zipalign,
// apksigner). Returns null if not installed.
export function buildToolPath(name: string): string | null {
  const buildTools = path.join(sdkRoot(), "build-tools");
  if (!fs.existsSync(buildTools)) return null;
  const versions = fs
    .readdirSync(buildTools)
    .filter((entry) => /^\d/.test(entry))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = path.join(buildTools, version, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function aapt2Path(): string | null {
  return buildToolPath("aapt2");
}

// Newest installed platform's android.jar (for linking a fixture APK).
export function androidJar(): string | null {
  const platforms = path.join(sdkRoot(), "platforms");
  if (!fs.existsSync(platforms)) return null;
  const versions = fs
    .readdirSync(platforms)
    .filter((entry) => entry.startsWith("android-"))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = path.join(platforms, version, "android.jar");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function run(
  file: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      timeout: opts.timeoutMs ?? 60_000,
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

// Binary-safe exec: collects stdout as raw bytes (never utf8-decoded), needed
// for screencap and other binary output that execFile would corrupt.
export function runBinary(file: string, args: string[], timeoutMs = 30_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args);
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${file} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
  });
}

export async function adb(serial: string | null, args: string[], timeoutMs?: number): Promise<ExecResult> {
  const full = serial ? ["-s", serial, ...args] : args;
  return run(adbPath(), full, { timeoutMs });
}

export async function listAvds(): Promise<string[]> {
  const result = await run(emulatorPath(), ["-list-avds"], { timeoutMs: 15_000 });
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("INFO"));
}
