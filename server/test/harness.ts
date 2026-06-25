import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildApp } from "../src/app";
import { defaultConfig, type ServerConfig } from "../src/config";
import { run as clientRun } from "../../client/src/cli";

export interface TestServer {
  server: string;
  stop: () => Promise<void>;
}

// Start a real server (FakeDriver, ManualClock) on an ephemeral port. Every test
// gets a fresh isolated instance.
export async function startServer(
  overrides: Partial<ServerConfig> = {},
): Promise<TestServer> {
  // Isolate persisted state (build registry, driver state) per server.
  const cacheDir = overrides.cacheDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "agtbx-cache-"));
  const config = defaultConfig({ testMode: true, cacheDir, ...overrides });
  const { app } = await buildApp(config);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    server: `http://127.0.0.1:${port}`,
    stop: () => app.close(),
  };
}

export interface CliOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
  // Last JSON object printed to stdout (single-result commands).
  json: Record<string, unknown> | null;
  // Every JSON object printed to stdout (streaming commands).
  lines: Record<string, unknown>[];
  // Parsed error object from stderr, if any.
  err: { code: string; message: string } | null;
}

// Drive the real client against the server. `--server` takes precedence over any
// env/config, so tests are hermetic.
export async function cli(server: string, args: string[]): Promise<CliOutcome> {
  const result = await clientRun([...args, "--server", server]);
  const outLines = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  // stderr may carry raw build logs followed by a trailing error JSON line. Only
  // treat the last line as an error if it parses as our error envelope.
  let errObj: { code: string; message: string } | null = null;
  const lastErrLine = result.stderr.trim().split("\n").pop();
  if (lastErrLine?.startsWith("{")) {
    try {
      errObj = (JSON.parse(lastErrLine) as { error?: { code: string; message: string } }).error ?? null;
    } catch {
      errObj = null;
    }
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    json: outLines.length ? (outLines[outLines.length - 1] as Record<string, unknown>) : null,
    lines: outLines,
    err: errObj,
  };
}

// Raw helpers for the test-only endpoints (not exposed as CLI commands).
export async function advanceClock(server: string, ms: number): Promise<void> {
  const res = await fetch(`${server}/_test/advance-clock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ms }),
  });
  if (!res.ok) throw new Error(`advance-clock failed: ${res.status}`);
}

export async function driverState(
  server: string,
): Promise<{ instanceCount: number; instances: { ref: string; tagged: boolean }[] }> {
  const res = await fetch(`${server}/_test/driver-state`);
  return res.json() as Promise<{
    instanceCount: number;
    instances: { ref: string; tagged: boolean }[];
  }>;
}

// Create a throwaway file (e.g. a fake APK) for upload tests.
export function tmpFile(name: string, contents = "x"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agtbx-test-"));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, contents);
  return filePath;
}

// Create a throwaway project directory for build tests.
export function tmpProject(opts: { fail?: boolean } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agtbx-proj-"));
  if (opts.fail) fs.writeFileSync(path.join(dir, "fail.marker"), "1");
  return dir;
}
