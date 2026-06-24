import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { advanceClock, cli, startServer, tmpFile, type TestServer } from "./harness";

async function createActive(server: string, template = "pixel6-api35"): Promise<string> {
  const r = await cli(server, ["session", "create", "--no-wait", "--template", template]);
  return r.json?.sessionId as string;
}

describe("device proxy", () => {
  let s: TestServer;
  afterEach(() => s.stop());

  test("D1 shell round-trip", async () => {
    s = await startServer();
    const id = await createActive(s.server);
    const r = await cli(s.server, ["device", "shell", id, "getprop ro.build.version.sdk"]);
    expect(r.json).toMatchObject({ exitCode: 0 });
    expect((r.json?.stdout as string).trim()).toBe("35");
  });

  test("D2 shell on unknown session → session_not_found", async () => {
    s = await startServer();
    const r = await cli(s.server, ["device", "shell", "s_nope", "echo hi"]);
    expect(r.err?.code).toBe("session_not_found");
  });

  test("D3 shell on queued session → session_not_active", async () => {
    s = await startServer({ maxByPlatform: { android: 1, ios: 1 } });
    await createActive(s.server);
    const queued = await cli(s.server, ["session", "create", "--no-wait", "--template", "pixel6-api35"]);
    const r = await cli(s.server, ["device", "shell", queued.json?.sessionId as string, "echo hi"]);
    expect(r.err?.code).toBe("session_not_active");
  });

  test("D4 shell on released session → error", async () => {
    s = await startServer();
    const id = await createActive(s.server);
    await cli(s.server, ["session", "release", id]);
    const r = await cli(s.server, ["device", "shell", id, "echo hi"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.err?.code).toBe("session_not_found");
  });

  test("D5 install returns package", async () => {
    s = await startServer();
    const id = await createActive(s.server);
    const r = await cli(s.server, ["device", "install", id, tmpFile("app-debug.apk", "bytes")]);
    expect(r.json).toMatchObject({ installed: true });
    expect(r.json?.package).toBeTruthy();
  });

  test("D6 install missing local file → client invalid_argument", async () => {
    s = await startServer();
    const id = await createActive(s.server);
    const missing = path.join(os.tmpdir(), "definitely-not-here-123.apk");
    const r = await cli(s.server, ["device", "install", id, missing]);
    expect(r.err?.code).toBe("invalid_argument");
  });

  test("D7 install non-package file → install_failed", async () => {
    s = await startServer();
    const id = await createActive(s.server);
    const r = await cli(s.server, ["device", "install", id, tmpFile("notes.txt", "hello")]);
    expect(r.err?.code).toBe("install_failed");
  });

  test("D8 forward echoes mapping", async () => {
    s = await startServer();
    const id = await createActive(s.server);
    const r = await cli(s.server, ["device", "forward", id, "--remote", "3001", "--local", "3001"]);
    expect(r.json).toMatchObject({ remote: 3001, local: 3001 });
  });

  test("D9 screenshot writes a file with bytes", async () => {
    s = await startServer();
    const id = await createActive(s.server);
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "shot-")), "shot.png");
    const r = await cli(s.server, ["device", "screenshot", id, "-o", out]);
    expect((r.json?.bytes as number) > 0).toBe(true);
    expect(fs.existsSync(out)).toBe(true);
  });

  test("D10 logs streams at least one event", async () => {
    s = await startServer();
    const id = await createActive(s.server);
    const r = await cli(s.server, ["device", "logs", id]);
    expect(r.lines.length).toBeGreaterThan(0);
  });

  test("D11 input tap → ok", async () => {
    s = await startServer();
    const id = await createActive(s.server);
    const r = await cli(s.server, ["device", "input", id, "tap", "100", "200"]);
    expect(r.json).toMatchObject({ ok: true });
  });

  test("D12 device call refreshes TTL", async () => {
    s = await startServer({ ttlMs: 1000 });
    const id = await createActive(s.server);
    await advanceClock(s.server, 500);
    await cli(s.server, ["device", "input", id, "tap", "1", "2"]);
    await advanceClock(s.server, 700);
    const r = await cli(s.server, ["session", "get", id]);
    expect(r.json).toMatchObject({ status: "active" });
  });

  test("D13 android-only verb on iOS → unsupported_on_platform", async () => {
    s = await startServer({ maxByPlatform: { android: 2, ios: 2 } });
    const id = await createActive(s.server, "iphone15-ios17");
    const r = await cli(s.server, ["device", "input", id, "tap", "1", "2"]);
    expect(r.err?.code).toBe("unsupported_on_platform");
  });
});
