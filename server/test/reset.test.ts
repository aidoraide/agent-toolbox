import { afterEach, describe, expect, test } from "vitest";

import { cli, startServer, type TestServer } from "./harness";

async function createActive(server: string, template = "pixel6-api35"): Promise<string> {
  const r = await cli(server, ["session", "create", "--no-wait", "--template", template]);
  return r.json?.sessionId as string;
}

describe("reset", () => {
  let s: TestServer;
  afterEach(() => s.stop());

  test("RS1 snapshot reset keeps slot, stays active", async () => {
    s = await startServer({ maxByPlatform: { android: 2, ios: 1 } });
    const id = await createActive(s.server);
    const before = await cli(s.server, ["capacity"]);
    const r = await cli(s.server, ["session", "reset", id]);
    expect(r.json).toMatchObject({ sessionId: id, status: "active", mode: "snapshot" });
    const after = await cli(s.server, ["capacity"]);
    expect((after.json as any).android.active).toBe((before.json as any).android.active);
  });

  test("RS2 wipe clears installed state", async () => {
    s = await startServer();
    const id = await createActive(s.server);
    const install = await cli(s.server, ["device", "install", id, makeApk()]);
    const pkg = install.json?.package as string;
    const present = await cli(s.server, ["device", "shell", id, `pm list packages ${pkg}`]);
    expect(present.json?.stdout).toContain(pkg);
    await cli(s.server, ["session", "reset", id, "--mode", "wipe"]);
    const after = await cli(s.server, ["device", "shell", id, `pm list packages ${pkg}`]);
    expect(after.json?.stdout).toBe("");
  });

  test("RS3 reboot preserves installed state", async () => {
    s = await startServer();
    const id = await createActive(s.server);
    const install = await cli(s.server, ["device", "install", id, makeApk()]);
    const pkg = install.json?.package as string;
    await cli(s.server, ["session", "reset", id, "--mode", "reboot"]);
    const after = await cli(s.server, ["device", "shell", id, `pm list packages ${pkg}`]);
    expect(after.json?.stdout).toContain(pkg);
  });

  test("RS4 snapshot restores post-boot (empty) state", async () => {
    s = await startServer();
    const id = await createActive(s.server);
    const install = await cli(s.server, ["device", "install", id, makeApk()]);
    const pkg = install.json?.package as string;
    await cli(s.server, ["session", "reset", id, "--mode", "snapshot"]);
    const after = await cli(s.server, ["device", "shell", id, `pm list packages ${pkg}`]);
    expect(after.json?.stdout).toBe("");
  });

  test("RS5 reset on queued → session_not_active", async () => {
    s = await startServer({ maxByPlatform: { android: 1, ios: 1 } });
    await createActive(s.server);
    const queued = await cli(s.server, ["session", "create", "--no-wait", "--template", "pixel6-api35"]);
    const r = await cli(s.server, ["session", "reset", queued.json?.sessionId as string]);
    expect(r.err?.code).toBe("session_not_active");
  });

  test("RS6 reset on unknown → session_not_found", async () => {
    s = await startServer();
    const r = await cli(s.server, ["session", "reset", "s_nope"]);
    expect(r.err?.code).toBe("session_not_found");
  });

  test("RS7 invalid mode → invalid_argument", async () => {
    s = await startServer();
    const id = await createActive(s.server);
    const r = await cli(s.server, ["session", "reset", id, "--mode", "explode"]);
    expect(r.err?.code).toBe("invalid_argument");
  });

  test("RS8 reset does not change slot count or queue order", async () => {
    s = await startServer({ maxByPlatform: { android: 1, ios: 1 } });
    const a = await createActive(s.server);
    const queued = await cli(s.server, ["session", "create", "--no-wait", "--template", "pixel6-api35"]);
    await cli(s.server, ["session", "reset", a]);
    const cap = await cli(s.server, ["capacity"]);
    expect((cap.json as any).android).toMatchObject({ active: 1, queued: 1 });
    const q = await cli(s.server, ["session", "get", queued.json?.sessionId as string]);
    expect((q.json as any).position).toBe(1);
  });
});

import { tmpFile } from "./harness";
function makeApk(): string {
  return tmpFile("app-debug.apk", "fake-apk-bytes");
}
