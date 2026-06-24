import { afterEach, describe, expect, test } from "vitest";

import { advanceClock, cli, startServer, type TestServer } from "./harness";

// TTL is 1000ms; ManualClock starts at 0. advanceClock drives the reaper.
describe("TTL, heartbeat, reaping", () => {
  let s: TestServer;
  afterEach(() => s.stop());

  test("R1 expired active session is reaped, slot freed", async () => {
    s = await startServer({ maxByPlatform: { android: 1, ios: 1 }, ttlMs: 1000 });
    await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    await advanceClock(s.server, 2000);
    const list = await cli(s.server, ["session", "list"]);
    expect((list.json as any).sessions).toEqual([]);
    const cap = await cli(s.server, ["capacity"]);
    expect((cap.json as any).android).toMatchObject({ active: 0, queued: 0 });
  });

  test("R2 heartbeat extends TTL", async () => {
    s = await startServer({ ttlMs: 1000 });
    const a = await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    const id = a.json?.sessionId as string;
    await advanceClock(s.server, 500);
    await cli(s.server, ["session", "heartbeat", id]);
    await advanceClock(s.server, 700); // now 1200, but extended to ~1500
    const r = await cli(s.server, ["session", "get", id]);
    expect(r.json).toMatchObject({ status: "active" });
  });

  test("R3 a device call counts as a heartbeat", async () => {
    s = await startServer({ ttlMs: 1000 });
    const a = await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    const id = a.json?.sessionId as string;
    await advanceClock(s.server, 500);
    await cli(s.server, ["device", "shell", id, "getprop ro.build.version.sdk"]);
    await advanceClock(s.server, 700);
    const r = await cli(s.server, ["session", "get", id]);
    expect(r.json).toMatchObject({ status: "active" });
  });

  test("R4 reaping an active session advances the queue", async () => {
    s = await startServer({ maxByPlatform: { android: 1, ios: 1 }, ttlMs: 1000 });
    const a = await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    await advanceClock(s.server, 600);
    const b = await cli(s.server, ["session", "create", "--template", "pixel6-api35"]); // exp 1600
    await advanceClock(s.server, 500); // now 1100: a(exp1000) reaped, b survives
    const aGet = await cli(s.server, ["session", "get", a.json?.sessionId as string]);
    expect(aGet.err?.code).toBe("session_not_found");
    const bGet = await cli(s.server, ["session", "get", b.json?.sessionId as string]);
    expect(bGet.json).toMatchObject({ status: "active" });
  });

  test("R5 queued sessions also expire", async () => {
    s = await startServer({ maxByPlatform: { android: 1, ios: 1 }, ttlMs: 1000 });
    const a = await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    const b = await cli(s.server, ["session", "create", "--template", "pixel6-api35"]); // queued
    await advanceClock(s.server, 500);
    await cli(s.server, ["session", "heartbeat", a.json?.sessionId as string]); // a → exp 1500
    await advanceClock(s.server, 600); // now 1100: b(exp1000) reaped, a survives
    const bGet = await cli(s.server, ["session", "get", b.json?.sessionId as string]);
    expect(bGet.err?.code).toBe("session_not_found");
    const cap = await cli(s.server, ["capacity"]);
    expect((cap.json as any).android).toMatchObject({ active: 1, queued: 0 });
  });

  test("R6 --ttl override honored", async () => {
    s = await startServer({ maxByPlatform: { android: 5, ios: 2 }, ttlMs: 1000 });
    const long = await cli(s.server, ["session", "create", "--template", "pixel6-api35", "--ttl", "5000"]);
    const short = await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    await advanceClock(s.server, 2000);
    const longGet = await cli(s.server, ["session", "get", long.json?.sessionId as string]);
    const shortGet = await cli(s.server, ["session", "get", short.json?.sessionId as string]);
    expect(longGet.json).toMatchObject({ status: "active" });
    expect(shortGet.err?.code).toBe("session_not_found");
  });
});
