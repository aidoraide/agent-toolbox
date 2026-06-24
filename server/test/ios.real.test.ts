import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { availableRuntimeIds, listDevices, resolveRuntime, simctl } from "../src/drivers/simctl";
import { advanceClock, cli, startServer, type TestServer } from "./harness";
import { buildFixtureIpa } from "./fixtures";

// Gated: only runs under `npm run test:real:ios` (RUN_REAL_IOS=1). Boots real
// simulators, so it is never part of the default fast suite.
const RUN = process.env.RUN_REAL_IOS === "1";
const suite = RUN ? describe : describe.skip;

const DEVICE = process.env.AGTBX_TEST_IOS_DEVICE ?? "iPhone 16";
const RUNTIME = process.env.AGTBX_TEST_IOS_RUNTIME ?? "iOS 18.3";
const TEMPLATE = {
  slug: "iphone",
  platform: "ios" as const,
  name: "iPhone",
  version: 1,
  ref: `${DEVICE}|${RUNTIME}`,
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function bootedAgtbxUdid(): Promise<string> {
  const devices = await listDevices();
  const match = devices.find((d) => d.name.startsWith("agtbx-") && d.state === "Booted");
  if (!match) throw new Error("no booted agtbx simulator found");
  return match.udid;
}

async function iosInstalled(bundleId: string): Promise<boolean> {
  const udid = await bootedAgtbxUdid();
  const result = await simctl(["get_app_container", udid, bundleId]);
  return result.code === 0;
}

// After a reboot, installd/SpringBoard re-register apps slightly after the
// device reports "booted", so poll briefly for the expected presence.
async function waitIosInstalled(bundleId: string, want: boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await iosInstalled(bundleId)) === want) return want;
    await new Promise((res) => setTimeout(res, 1000));
  }
  return iosInstalled(bundleId);
}

async function firstLogLine(server: string, id: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const res = await fetch(`${server}/sessions/${id}/logs`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes("\n")) return true;
    }
    return buf.includes("\n");
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

suite("real ios — shared simulator", () => {
  let s: TestServer;
  let id: string;
  const fixture = buildFixtureIpa();

  beforeAll(async () => {
    s = await startServer({ driver: "ios", templates: [TEMPLATE], maxByPlatform: { android: 0, ios: 1 } });
    const r = await cli(s.server, ["session", "create", "--template", "iphone"]);
    id = r.json?.sessionId as string;
    expect(r.json?.status).toBe("active");
  });

  afterAll(async () => {
    if (id) await cli(s.server, ["session", "release", id]);
    await s?.stop();
  });

  test("S18 lease yields an active real simulator", () => {
    expect(id).toBeTruthy();
  });

  test("T3/CT1 configured runtime is available", async () => {
    const runtimeId = await resolveRuntime(RUNTIME);
    expect(await availableRuntimeIds()).toContain(runtimeId);
  });

  test("D1/CT3 shell round-trip via simctl spawn", async () => {
    const r = await cli(s.server, ["device", "shell", id, "echo hello-ios"]);
    expect(r.json?.exitCode).toBe(0);
    expect((r.json?.stdout as string).trim()).toBe("hello-ios");
  });

  test("D5/CT4 install a real .ipa reports the bundle id", async () => {
    const r = await cli(s.server, ["device", "install", id, fixture.ipaPath]);
    expect(r.json).toMatchObject({ installed: true, package: fixture.bundleId });
    expect(await iosInstalled(fixture.bundleId)).toBe(true);
    await simctl(["uninstall", await bootedAgtbxUdid(), fixture.bundleId]);
  });

  test("D9 screenshot is a valid PNG on disk", async () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agtbx-ios-shot-")), "shot.png");
    const r = await cli(s.server, ["device", "screenshot", id, "-o", out]);
    expect((r.json?.bytes as number) > 1000).toBe(true);
    expect(fs.readFileSync(out).subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });

  test("D10 oslog streams at least one line", async () => {
    expect(await firstLogLine(s.server, id)).toBe(true);
  });

  test("ACCESS lease exposes the simulator UDID; simctl drives it", async () => {
    const info = await cli(s.server, ["session", "access", id]);
    const access = info.json as { kind: string; udid: string };
    expect(access.kind).toBe("simctl");
    expect(access.udid).toMatch(/^[0-9A-F-]{36}$/i);
    // The agent's own simctl can drive the leased sim by UDID.
    const state = await simctl(["spawn", access.udid, "/bin/sh", "-c", "echo via-udid"]);
    expect(state.stdout.trim()).toBe("via-udid");
  });

  test("D13 forward is unsupported on iOS", async () => {
    const r = await cli(s.server, ["device", "forward", id, "--remote", "3001", "--local", "3001"]);
    expect(r.err?.code).toBe("unsupported_on_platform");
  });

  test("D13 input is unsupported on iOS", async () => {
    const r = await cli(s.server, ["device", "input", id, "tap", "10", "20"]);
    expect(r.err?.code).toBe("unsupported_on_platform");
  });

  test("RS2/CT5 wipe (erase) clears installed state", async () => {
    await cli(s.server, ["device", "install", id, fixture.ipaPath]);
    expect(await iosInstalled(fixture.bundleId)).toBe(true);
    await cli(s.server, ["session", "reset", id, "--mode", "wipe"]);
    expect(await iosInstalled(fixture.bundleId)).toBe(false);
  });

  test("RS3 reboot preserves installed state", async () => {
    await cli(s.server, ["device", "install", id, fixture.ipaPath]);
    await cli(s.server, ["session", "reset", id, "--mode", "reboot"]);
    expect(await waitIosInstalled(fixture.bundleId, true)).toBe(true);
    await simctl(["uninstall", await bootedAgtbxUdid(), fixture.bundleId]);
  });

  test("RS4 snapshot restores pristine (cleared) state", async () => {
    await cli(s.server, ["device", "install", id, fixture.ipaPath]);
    await cli(s.server, ["session", "reset", id, "--mode", "snapshot"]);
    expect(await iosInstalled(fixture.bundleId)).toBe(false);
  });

  test("R7 expired session is reaped and the simulator is deleted", async () => {
    const s2 = await startServer({
      driver: "ios",
      templates: [TEMPLATE],
      maxByPlatform: { android: 0, ios: 1 },
      ttlMs: 1000,
    });
    try {
      await cli(s2.server, ["session", "create", "--template", "iphone"]);
      const before = (await listDevices()).filter((d) => d.name.startsWith("agtbx-")).map((d) => d.name);

      await advanceClock(s2.server, 5000); // fire the reaper → simctl delete

      let reaped = false;
      for (let i = 0; i < 40; i += 1) {
        const list = await cli(s2.server, ["session", "list"]);
        if ((list.json as any).sessions.length === 0) {
          reaped = true;
          break;
        }
        await new Promise((res) => setTimeout(res, 1000));
      }
      expect(reaped).toBe(true);

      const after = (await listDevices()).filter((d) => d.name.startsWith("agtbx-")).map((d) => d.name);
      // The freshly-reaped sim is gone (after ⊆ before, strictly fewer).
      expect(after.length).toBeLessThan(before.length);
    } finally {
      await s2.stop();
    }
  });
});

suite("real ios — crash recovery (reconciliation)", () => {
  test("CL4 orphaned simulator from a crashed run is deleted on restart", async () => {
    const a = await startServer({ driver: "ios", templates: [TEMPLATE], maxByPlatform: { android: 0, ios: 1 } });
    const created = await cli(a.server, ["session", "create", "--template", "iphone"]);
    expect(created.json?.status).toBe("active");
    const orphanNames = (await listDevices()).filter((d) => d.name.startsWith("agtbx-")).map((d) => d.name);
    expect(orphanNames.length).toBeGreaterThan(0);
    await a.stop(); // sim persists in simctl, never released

    const b = await startServer({ driver: "ios", templates: [TEMPLATE], maxByPlatform: { android: 0, ios: 1 } });
    try {
      const remaining = (await listDevices()).filter((d) => d.name.startsWith("agtbx-")).map((d) => d.name);
      for (const name of orphanNames) {
        expect(remaining).not.toContain(name);
      }
    } finally {
      await b.stop();
    }
  });
});
