import { afterEach, describe, expect, test } from "vitest";

import { advanceClock, cli, driverState, startServer, type TestServer } from "./harness";

describe("resource cleanup & reconciliation", () => {
  let s: TestServer;
  afterEach(() => s.stop());

  test("CL1 release destroys the underlying clone", async () => {
    s = await startServer();
    const a = await cli(s.server, ["session", "create", "--no-wait", "--template", "pixel6-api35"]);
    expect((await driverState(s.server)).instanceCount).toBe(1);
    await cli(s.server, ["session", "release", a.json?.sessionId as string]);
    expect((await driverState(s.server)).instanceCount).toBe(0);
  });

  test("CL2 reaped session destroys its clone", async () => {
    s = await startServer({ ttlMs: 1000 });
    await cli(s.server, ["session", "create", "--no-wait", "--template", "pixel6-api35"]);
    await advanceClock(s.server, 2000);
    expect((await driverState(s.server)).instanceCount).toBe(0);
  });

  test("CL3/CL5 reconciliation destroys tagged orphans, keeps untagged", async () => {
    s = await startServer({
      seedInstances: [
        { ref: "agtbx-orphan-1", tagged: true },
        { ref: "user-personal-avd", tagged: false },
      ],
    });
    const state = await driverState(s.server);
    const refs = state.instances.map((i) => i.ref);
    expect(refs).not.toContain("agtbx-orphan-1");
    expect(refs).toContain("user-personal-avd");
  });

  test("CL6 full lifecycle leaves zero live instances", async () => {
    s = await startServer({ maxByPlatform: { android: 3, ios: 2 } });
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await cli(s.server, ["session", "create", "--no-wait", "--template", "pixel6-api35"]);
      ids.push(r.json?.sessionId as string);
    }
    for (const id of ids) {
      await cli(s.server, ["session", "release", id]);
    }
    expect((await driverState(s.server)).instanceCount).toBe(0);
  });
});
