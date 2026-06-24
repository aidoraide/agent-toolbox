import { afterEach, describe, expect, test } from "vitest";

import { cli, startServer, type TestServer } from "./harness";

describe("queue race", () => {
  let s: TestServer;
  afterEach(() => s.stop());

  test("S16 releasing one slot promotes exactly one of two queued", async () => {
    s = await startServer({ maxByPlatform: { android: 1, ios: 1 } });
    const a = await cli(s.server, ["session", "create", "--no-wait", "--template", "pixel6-api35"]);
    const b = await cli(s.server, ["session", "create", "--no-wait", "--template", "pixel6-api35"]);
    const c = await cli(s.server, ["session", "create", "--no-wait", "--template", "pixel6-api35"]);

    await cli(s.server, ["session", "release", a.json?.sessionId as string]);

    const bState = await cli(s.server, ["session", "get", b.json?.sessionId as string]);
    const cState = await cli(s.server, ["session", "get", c.json?.sessionId as string]);
    const activeCount = [bState, cState].filter((r) => r.json?.status === "active").length;
    expect(activeCount).toBe(1);
    // FIFO: the earlier-queued (b) wins; c stays queued at the head.
    expect(bState.json).toMatchObject({ status: "active" });
    expect(cState.json).toMatchObject({ status: "queued", position: 1 });
  });
});
