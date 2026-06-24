import { afterEach, describe, expect, test } from "vitest";

import { cli, startServer, type TestServer } from "./harness";

// The default `session create` blocks until the device is active (lock-acquire
// semantics). --no-wait and --fail-if-busy opt out.
describe("blocking create (default lease UX)", () => {
  let s: TestServer;
  afterEach(() => s.stop());

  test("BL1 create on a free slot returns active", async () => {
    s = await startServer({ maxByPlatform: { android: 1, ios: 1 } });
    const r = await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    expect(r.json).toMatchObject({ status: "active" });
  });

  test("BL2 --fail-if-busy returns pool_full when full", async () => {
    s = await startServer({ maxByPlatform: { android: 1, ios: 1 } });
    await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    const r = await cli(s.server, ["session", "create", "--fail-if-busy", "--template", "pixel6-api35"]);
    expect(r.err?.code).toBe("pool_full");
  });

  test("BL3 blocking create resolves to active once a slot frees", async () => {
    s = await startServer({ maxByPlatform: { android: 1, ios: 1 } });
    const occupier = await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);

    // This call blocks (pool full) — don't await yet.
    const blocked = cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    // Free the slot; the blocked create should promote and resolve active.
    await cli(s.server, ["session", "release", occupier.json?.sessionId as string]);

    const r = await blocked;
    expect(r.exitCode).toBe(0);
    expect(r.json).toMatchObject({ status: "active" });
  });

  test("BL4 --no-wait returns queued immediately when full", async () => {
    s = await startServer({ maxByPlatform: { android: 1, ios: 1 } });
    await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    const r = await cli(s.server, ["session", "create", "--no-wait", "--template", "pixel6-api35"]);
    expect(r.json).toMatchObject({ status: "queued" });
  });

  test("BL5 fake sessions expose no device access", async () => {
    s = await startServer();
    const created = await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    const r = await cli(s.server, ["session", "access", created.json?.sessionId as string]);
    expect(r.err?.code).toBe("access_unavailable");
  });
});
