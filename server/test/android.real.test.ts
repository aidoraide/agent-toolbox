import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { adbPath, listAvds } from "../src/drivers/sdk";
import { advanceClock, cli, startServer, type TestServer } from "./harness";
import { buildFixtureApk } from "./fixtures";

// Gated: only runs under `npm run test:real:android` (RUN_REAL_ANDROID=1). Boots
// real emulators, so it is never part of the default fast suite.
const RUN = process.env.RUN_REAL_ANDROID === "1";
const suite = RUN ? describe : describe.skip;

const AVD = process.env.AGTBX_TEST_AVD ?? "Medium_Phone_API_36.1";
const TEMPLATE = { slug: "medium", platform: "android" as const, name: "Medium", version: 1, ref: AVD };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function installed(server: string, id: string, pkg: string): Promise<boolean> {
  const r = await cli(server, ["device", "shell", id, `pm list packages ${pkg}`]);
  return ((r.json?.stdout as string) ?? "").includes(pkg);
}

// Drain a single NDJSON line from the (infinite) logcat stream, then abort.
async function firstLogLine(server: string, id: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
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

suite("real android — shared emulator", () => {
  let s: TestServer;
  let id: string;
  const fixture = buildFixtureApk();

  beforeAll(async () => {
    s = await startServer({ driver: "android", templates: [TEMPLATE], maxByPlatform: { android: 1, ios: 0 } });
    const r = await cli(s.server, ["session", "create", "--template", "medium"]);
    id = r.json?.sessionId as string;
    expect(r.json?.status).toBe("active");
  });

  afterAll(async () => {
    if (id) await cli(s.server, ["session", "release", id]);
    await s?.stop();
  });

  test("S18 lease yields an active real device", () => {
    expect(id).toBeTruthy();
  });

  test("T3/CT1 configured template ref exists in the real AVD inventory", async () => {
    const avds = await listAvds();
    expect(avds).toContain(AVD);
  });

  test("D1/CT3 shell round-trip returns real getprop", async () => {
    const r = await cli(s.server, ["device", "shell", id, "getprop ro.build.version.sdk"]);
    expect(r.json?.exitCode).toBe(0);
    expect((r.json?.stdout as string).trim()).toMatch(/^\d+$/);
  });

  test("D5/CT4 install a real APK reports the package", async () => {
    const r = await cli(s.server, ["device", "install", id, fixture.apkPath]);
    expect(r.json).toMatchObject({ installed: true, package: fixture.packageName });
    expect(await installed(s.server, id, fixture.packageName)).toBe(true);
    await cli(s.server, ["device", "shell", id, `pm uninstall ${fixture.packageName}`]);
  });

  test("D9 screenshot is a valid PNG on disk", async () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agtbx-shot-")), "shot.png");
    const r = await cli(s.server, ["device", "screenshot", id, "-o", out]);
    expect((r.json?.bytes as number) > 1000).toBe(true);
    const head = fs.readFileSync(out).subarray(0, 8);
    expect(head.equals(PNG_SIGNATURE)).toBe(true);
  });

  test("D8 forward (adb reverse) succeeds", async () => {
    const r = await cli(s.server, ["device", "forward", id, "--remote", "3001", "--local", "3001"]);
    expect(r.json).toMatchObject({ remote: 3001, local: 3001 });
  });

  test("D11 input tap succeeds", async () => {
    const r = await cli(s.server, ["device", "input", id, "tap", "100", "200"]);
    expect(r.json).toMatchObject({ ok: true });
  });

  test("ADB lease exposes adb server + serial; an adb client drives the device", async () => {
    const adbInfo = await cli(s.server, ["session", "access", id]);
    const access = adbInfo.json as { kind: string; host: string; port: number; serial: string };
    expect(access.kind).toBe("adb");
    expect(access.serial).toMatch(/^emulator-\d+$/);
    expect(access.port).toBeGreaterThan(0);

    // Point an adb client at the broker's adb server and address the device by
    // serial — exactly how Detox/Appium/Gradle attach.
    const { execFileSync } = await import("node:child_process");
    const ADB = adbPath();
    const env = { ...process.env, ADB_SERVER_SOCKET: `tcp:${access.host}:${access.port}` };
    const sdk = execFileSync(ADB, ["-s", access.serial, "shell", "getprop", "ro.build.version.sdk"], {
      env,
      timeout: 15_000,
    })
      .toString()
      .trim();
    expect(sdk).toMatch(/^\d+$/);
  });

  test("D10 logcat streams at least one line", async () => {
    expect(await firstLogLine(s.server, id)).toBe(true);
  });

  test("RS2/CT5 wipe clears installed state", async () => {
    await cli(s.server, ["device", "install", id, fixture.apkPath]);
    expect(await installed(s.server, id, fixture.packageName)).toBe(true);
    await cli(s.server, ["session", "reset", id, "--mode", "wipe"]);
    expect(await installed(s.server, id, fixture.packageName)).toBe(false);
  });

  test("RS3 reboot preserves installed state", async () => {
    await cli(s.server, ["device", "install", id, fixture.apkPath]);
    await cli(s.server, ["session", "reset", id, "--mode", "reboot"]);
    expect(await installed(s.server, id, fixture.packageName)).toBe(true);
    await cli(s.server, ["device", "shell", id, `pm uninstall ${fixture.packageName}`]);
  });

  test("RS4 snapshot restores pristine (cleared) state", async () => {
    await cli(s.server, ["device", "install", id, fixture.apkPath]);
    await cli(s.server, ["session", "reset", id, "--mode", "snapshot"]);
    expect(await installed(s.server, id, fixture.packageName)).toBe(false);
  });

  test("R7 expired session is reaped and the emulator is killed", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "agtbx-r7-"));
    const s2 = await startServer({
      driver: "android",
      templates: [TEMPLATE],
      maxByPlatform: { android: 1, ios: 0 },
      ttlMs: 1000,
      cacheDir,
    });
    try {
      await cli(s2.server, ["session", "create", "--template", "medium"]);
      const persisted = JSON.parse(
        fs.readFileSync(path.join(cacheDir, "android-instances.json"), "utf8"),
      ) as { port: number }[];
      const serial = `emulator-${persisted[0]!.port}`;

      await advanceClock(s2.server, 5000); // fire the reaper → real adb emu kill

      // Reaping a real device is eventually-consistent: the session is removed
      // only after `adb emu kill` completes, so poll until the list drains.
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

      const { execFileSync } = await import("node:child_process");
      const { adbPath } = await import("../src/drivers/sdk");
      const devices = execFileSync(adbPath(), ["devices"]).toString();
      expect(devices).not.toContain(serial);
    } finally {
      await s2.stop();
    }
  });
});

suite("real android — crash recovery (reconciliation)", () => {
  test("CL4 orphaned emulator from a crashed run is reaped on restart", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "agtbx-cache-"));
    // Server A leases (boots) but never releases — simulate a crash by closing
    // the HTTP server while the emulator keeps running and the state file holds
    // the port.
    const a = await startServer({
      driver: "android",
      templates: [TEMPLATE],
      maxByPlatform: { android: 1, ios: 0 },
      cacheDir,
    });
    await cli(a.server, ["session", "create", "--template", "medium"]);
    const statePath = path.join(cacheDir, "android-instances.json");
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as { port: number }[];
    expect(persisted.length).toBe(1);
    const orphanSerial = `emulator-${persisted[0]!.port}`;
    await a.stop(); // emulator stays alive, state file retains the orphan

    // Server B boots against the same cache dir → reconcile kills the orphan.
    const b = await startServer({
      driver: "android",
      templates: [TEMPLATE],
      maxByPlatform: { android: 1, ios: 0 },
      cacheDir,
    });
    try {
      await new Promise((res) => setTimeout(res, 4000));
      const { execFileSync } = await import("node:child_process");
      const { adbPath } = await import("../src/drivers/sdk");
      const devices = execFileSync(adbPath(), ["devices"]).toString();
      expect(devices).not.toContain(orphanSerial);
      const remaining = JSON.parse(fs.readFileSync(statePath, "utf8")) as unknown[];
      expect(remaining.length).toBe(0);
    } finally {
      await b.stop();
    }
  });
});

// Boots a pool of real emulators (POOL at once) under contention from many
// agents. Gated separately (RUN_REAL_ANDROID_CONCURRENCY=1) since it runs
// several emulators simultaneously.
const concurrencySuite = RUN && process.env.RUN_REAL_ANDROID_CONCURRENCY === "1" ? describe : describe.skip;

const POOL = Number(process.env.AGTBX_TEST_POOL ?? 3);
const AGENTS = Number(process.env.AGTBX_TEST_AGENTS ?? 10);

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// One agent's full lifecycle: wait for its slot, prove the device it was handed
// is its own (write a unique token, read it back), then release.
async function driveAgent(
  server: string,
  created: { sessionId: string; status: string },
  i: number,
): Promise<{ i: number; token: string; read: string; ok: boolean }> {
  const id = created.sessionId;
  if (created.status === "queued") {
    await cli(server, ["session", "wait", id]); // blocks until promoted to active
  }
  const token = `agtbx_${i}_${Date.now()}`;
  await cli(server, ["device", "shell", id, `setprop debug.agtbx.token ${token}`]);
  // Give any mis-routing a window to surface before we read back.
  await sleep(1500);
  const r = await cli(server, ["device", "shell", id, "getprop debug.agtbx.token"]);
  const read = ((r.json?.stdout as string) ?? "").trim();
  await cli(server, ["session", "release", id]);
  return { i, token, read, ok: read === token };
}

concurrencySuite(`real android — ${AGENTS} agents / ${POOL} emulators`, () => {
  test(
    "agents queue correctly and each is routed to its own isolated device",
    async () => {
      const s = await startServer({
        driver: "android",
        templates: [TEMPLATE],
        maxByPlatform: { android: POOL, ios: 0 },
      });

      let peakActive = 0;
      let polling = true;
      const poller = (async () => {
        while (polling) {
          const c = await cli(s.server, ["capacity"]);
          peakActive = Math.max(peakActive, (c.json as any).android.active as number);
          await sleep(400);
        }
      })();

      try {
        // Phase 1 — fire all leases at once. The first POOL boot and return
        // active; the rest return queued immediately.
        const creates = await Promise.all(
          Array.from({ length: AGENTS }, () =>
            cli(s.server, ["session", "create", "--no-wait", "--template", "medium"]),
          ),
        );
        const statuses = creates.map((r) => r.json?.status);
        expect(statuses.filter((x) => x === "active").length).toBe(POOL);
        expect(statuses.filter((x) => x === "queued").length).toBe(AGENTS - POOL);

        // All sessions are distinct.
        const ids = creates.map((r) => r.json?.sessionId as string);
        expect(new Set(ids).size).toBe(AGENTS);

        // Phase 2 — drive every agent to completion concurrently. Queued agents
        // wait, get promoted as slots free, do their isolation check, release.
        const results = await Promise.all(
          creates.map((c, i) => driveAgent(s.server, c.json as { sessionId: string; status: string }, i)),
        );

        // Correctness: every agent read back exactly the token it wrote on its
        // own device — no cross-talk, no mismatched routing.
        for (const r of results) {
          expect(r.read).toBe(r.token);
        }
        expect(results.every((r) => r.ok)).toBe(true);
        // Tokens were all unique, so this also proves no two agents collided.
        expect(new Set(results.map((r) => r.token)).size).toBe(AGENTS);

        // The cap was never exceeded, and the pool was fully utilized.
        expect(peakActive).toBeLessThanOrEqual(POOL);
        expect(peakActive).toBe(POOL);

        // Everything drained — no leaked slots.
        const cap = await cli(s.server, ["capacity"]);
        expect((cap.json as any).android).toMatchObject({ active: 0, queued: 0 });

        // No leaked emulators.
        const { execFileSync } = await import("node:child_process");
        const devices = execFileSync(adbPath(), ["devices"]).toString();
        expect(devices).not.toMatch(/emulator-\d+\s+device/);
      } finally {
        polling = false;
        await poller;
        await s.stop();
      }
    },
    900_000,
  );
});
