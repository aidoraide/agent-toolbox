import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { cli, startServer, type TestServer } from "./harness";

// The whole pipeline end to end: build on the Mac → lease a device → install →
// launch/run → verify. Gated + needs the sample apps fetched (samples/fetch.sh).
const here = path.dirname(fileURLToPath(import.meta.url));
const samples = path.resolve(here, "../../samples");
// AndroidJunitRunnerSample: plain AndroidJUnitRunner (no Hilt) with on-device
// instrumented *unit* tests (CalculatorTest) — no Espresso input injection, so
// it runs cleanly on bleeding-edge API levels (36) under raw `am instrument`.
const ANDROID_SAMPLE = path.join(samples, "android/testing-samples/runner/AndroidJunitRunnerSample");
const IOS_SAMPLE = path.join(samples, "ios/simple-swiftui/SimpleToDo");

const ANDROID_AVD = process.env.AGTBX_TEST_AVD ?? "Medium_Phone_API_36.1";
const IOS_DEVICE = process.env.AGTBX_TEST_IOS_DEVICE ?? "iPhone 16";
const IOS_RUNTIME = process.env.AGTBX_TEST_IOS_RUNTIME ?? "iOS 18.3";

const APP_ID = "com.example.android.testing.androidjunitrunnersample";
const TEST_CLASS = "com.example.android.testing.androidjunitrunnersample.CalculatorTest";

const androidReady = process.env.RUN_REAL_ANDROID === "1" && fs.existsSync(ANDROID_SAMPLE);
const iosReady = process.env.RUN_REAL_IOS === "1" && fs.existsSync(IOS_SAMPLE);

function tmp(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agtbx-flow-")), name);
}

(androidReady ? describe : describe.skip)("FULL FLOW — android: build → lease → install → run → instrument", () => {
  let s: TestServer;
  let sid: string;
  const apk = tmp("app-debug.apk");
  const testApk = tmp("app-debug-androidTest.apk");

  beforeAll(async () => {
    s = await startServer({
      driver: "android",
      templates: [{ slug: "medium", platform: "android", name: "M", version: 1, ref: ANDROID_AVD }],
      maxByPlatform: { android: 1, ios: 0 },
    });
  }, 600_000);

  afterAll(async () => {
    if (sid) await cli(s.server, ["session", "release", sid]);
    await s?.stop();
  }, 120_000);

  test("BUILD produces app + test APKs", async () => {
    const r = await cli(s.server, ["build", "create", "--platform", "android", "--path", ANDROID_SAMPLE]);
    expect(r.json).toMatchObject({ status: "done" });
    expect((r.json as any).artifacts).toEqual(expect.arrayContaining(["apk", "test-apk"]));
    const id = r.json?.buildId as string;
    await cli(s.server, ["build", "artifact", id, "apk", "-o", apk]);
    await cli(s.server, ["build", "artifact", id, "test-apk", "-o", testApk]);
    expect(fs.statSync(apk).size).toBeGreaterThan(0);
    expect(fs.statSync(testApk).size).toBeGreaterThan(0);
  }, 600_000);

  test("LEASE an emulator", async () => {
    const r = await cli(s.server, ["session", "create", "--template", "medium"]);
    sid = r.json?.sessionId as string;
    expect(r.json?.status).toBe("active");
  }, 300_000);

  test("INSTALL app + test APKs", async () => {
    const app = await cli(s.server, ["device", "install", sid, apk]);
    expect(app.json).toMatchObject({ installed: true });
    const test = await cli(s.server, ["device", "install", sid, testApk]);
    expect(test.json).toMatchObject({ installed: true });
  }, 120_000);

  test("RUN the app (launch + process alive)", async () => {
    await cli(s.server, ["device", "shell", sid, `monkey -p ${APP_ID} -c android.intent.category.LAUNCHER 1`]);
    let pid = "";
    for (let i = 0; i < 15; i += 1) {
      await new Promise((res) => setTimeout(res, 1000));
      const r = await cli(s.server, ["device", "shell", sid, `pidof ${APP_ID}`]);
      pid = ((r.json?.stdout as string) ?? "").trim();
      if (pid) break;
    }
    expect(pid).not.toBe("");
  }, 120_000);

  test("INSTRUMENT — run the TaskDao instrumented test, assert it passes", async () => {
    const list = await cli(s.server, ["device", "shell", sid, "pm list instrumentation"]);
    const line = ((list.json?.stdout as string) ?? "")
      .split("\n")
      .find((l) => l.includes(`${APP_ID}.test/`));
    expect(line).toBeTruthy();
    const component = (line as string).replace(/^instrumentation:/, "").replace(/\s*\(target=.*$/, "").trim();

    // Instrumentation needs to start the target process itself — force-stop the
    // copy our RUN step launched.
    await cli(s.server, ["device", "shell", sid, `am force-stop ${APP_ID}`]);

    const run = await cli(s.server, [
      "device", "shell", sid,
      `am instrument -w -e class ${TEST_CLASS} ${component}`,
    ]);
    const out = (run.json?.stdout as string) ?? "";
    if (!out.includes("OK (")) {
      // Surface the on-device crash for diagnosis.
      const crash = await cli(s.server, ["device", "shell", sid, "logcat -d -t 120 *:E"]);
      // eslint-disable-next-line no-console
      console.error("INSTRUMENT OUT:\n", out, "\nLOGCAT:\n", (crash.json?.stdout as string)?.slice(-2000));
    }
    expect(out).toContain("OK (");
    expect(out).not.toContain("FAILURES!!!");
  }, 300_000);
});

(iosReady ? describe : describe.skip)("FULL FLOW — ios: build → lease → install → run", () => {
  let s: TestServer;
  let sid: string;
  let udid: string;
  let bundleId: string;
  const appZip = tmp("app.zip");

  beforeAll(async () => {
    s = await startServer({
      driver: "ios",
      templates: [{ slug: "iphone", platform: "ios", name: "iPhone", version: 1, ref: `${IOS_DEVICE}|${IOS_RUNTIME}` }],
      maxByPlatform: { android: 0, ios: 1 },
    });
  }, 600_000);

  afterAll(async () => {
    if (sid) await cli(s.server, ["session", "release", sid]);
    await s?.stop();
  }, 120_000);

  test("BUILD produces the .app", async () => {
    const r = await cli(s.server, ["build", "create", "--platform", "ios", "--path", IOS_SAMPLE]);
    expect(r.json).toMatchObject({ status: "done" });
    expect((r.json as any).artifacts).toContain("app");
    await cli(s.server, ["build", "artifact", r.json?.buildId as string, "app", "-o", appZip]);
    expect(fs.statSync(appZip).size).toBeGreaterThan(0);
  }, 600_000);

  test("LEASE a simulator", async () => {
    const r = await cli(s.server, ["session", "create", "--template", "iphone"]);
    sid = r.json?.sessionId as string;
    expect(r.json?.status).toBe("active");
    const access = (await cli(s.server, ["session", "access", sid])).json as { udid: string };
    udid = access.udid;
    expect(udid).toMatch(/^[0-9A-F-]{36}$/i);
  }, 300_000);

  test("INSTALL the .app", async () => {
    const r = await cli(s.server, ["device", "install", sid, appZip]);
    expect(r.json).toMatchObject({ installed: true });
    bundleId = r.json?.package as string;
    expect(bundleId).toBeTruthy();
  }, 120_000);

  test("RUN the app (simctl launch returns a pid)", async () => {
    // The agent drives its leased sim with its own simctl via the UDID handle.
    const out = execFileSync("xcrun", ["simctl", "launch", udid, bundleId], { encoding: "utf8" }).trim();
    // Format: "<bundleId>: <pid>"
    expect(out).toContain(bundleId);
    const pid = out.split(":").pop()?.trim() ?? "";
    expect(Number(pid)).toBeGreaterThan(0);
  }, 120_000);
});
