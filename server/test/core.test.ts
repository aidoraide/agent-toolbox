import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { cli, startServer, type TestServer } from "./harness";

describe("health & capacity", () => {
  let s: TestServer;
  afterEach(() => s?.stop());

  test("H1 health ok", async () => {
    s = await startServer();
    const r = await cli(s.server, ["health"]);
    expect(r.exitCode).toBe(0);
    expect(r.json).toMatchObject({ ok: true, service: "agent-toolbox" });
  });

  test("H2 down server → server_unreachable", async () => {
    const r = await cli("http://127.0.0.1:1", ["health"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.err?.code).toBe("server_unreachable");
    expect(r.stdout).toBe("");
  });

  test("C1 fresh capacity reflects config maxes, zero active", async () => {
    s = await startServer({ maxByPlatform: { android: 5, ios: 2 } });
    const r = await cli(s.server, ["capacity"]);
    expect(r.json).toMatchObject({
      android: { max: 5, active: 0, queued: 0 },
      ios: { max: 2, active: 0, queued: 0 },
    });
  });

  test("C2 active count rises with creates", async () => {
    s = await startServer({ maxByPlatform: { android: 5, ios: 2 } });
    await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    const r = await cli(s.server, ["capacity"]);
    expect((r.json as any).android.active).toBe(2);
  });

  test("C3 android full does not affect ios (independent caps)", async () => {
    s = await startServer({ maxByPlatform: { android: 1, ios: 2 } });
    await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    await cli(s.server, ["session", "create", "--template", "pixel6-api35"]); // queued
    const r = await cli(s.server, ["capacity"]);
    expect((r.json as any).android).toMatchObject({ active: 1, queued: 1 });
    expect((r.json as any).ios).toMatchObject({ active: 0, queued: 0 });
  });
});

describe("templates", () => {
  let s: TestServer;
  afterEach(() => s?.stop());

  test("T1 list returns configured templates", async () => {
    s = await startServer();
    const r = await cli(s.server, ["templates", "list"]);
    const templates = (r.json as any).templates as any[];
    expect(templates.length).toBeGreaterThan(0);
    expect(templates[0]).toHaveProperty("slug");
    expect(templates[0]).toHaveProperty("platform");
    expect(templates[0]).toHaveProperty("version");
  });

  test("T2 empty template set → empty array, exit 0", async () => {
    s = await startServer({ templates: [] });
    const r = await cli(s.server, ["templates", "list"]);
    expect(r.exitCode).toBe(0);
    expect((r.json as any).templates).toEqual([]);
  });

  test("T4 lease echoes template version", async () => {
    s = await startServer();
    const r = await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    expect(r.json).toMatchObject({ templateVersion: 1 });
  });
});

describe("session lifecycle & queue", () => {
  let s: TestServer;
  beforeEach(async () => {
    s = await startServer({ maxByPlatform: { android: 2, ios: 1 } });
  });
  afterEach(() => s.stop());

  test("S1 create with free slot → active", async () => {
    const r = await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    expect(r.json).toMatchObject({ status: "active", template: "pixel6-api35" });
    expect(r.json?.sessionId).toBeTruthy();
  });

  test("S2 create when full → queued with position", async () => {
    await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    const r = await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    expect(r.json).toMatchObject({ status: "queued" });
    expect(typeof r.json?.position).toBe("number");
  });

  test("S3 queue ordering sequential", async () => {
    await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    const a = await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    const b = await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    const c = await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    expect((a.json as any).position).toBe(1);
    expect((b.json as any).position).toBe(2);
    expect((c.json as any).position).toBe(3);
  });

  test("S4 wait on active returns immediately", async () => {
    const created = await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    const id = created.json?.sessionId as string;
    const r = await cli(s.server, ["session", "wait", id]);
    expect(r.exitCode).toBe(0);
    expect(r.lines.at(-1)).toMatchObject({ status: "active", sessionId: id });
  });

  test("S5 wait on queued blocks then activates", async () => {
    await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    const occupier = await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    const queued = await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    const id = queued.json?.sessionId as string;

    const waitPromise = cli(s.server, ["session", "wait", id]);
    await cli(s.server, ["session", "release", occupier.json?.sessionId as string]);
    const r = await waitPromise;
    expect(r.lines[0]).toMatchObject({ status: "queued" });
    expect(r.lines.at(-1)).toMatchObject({ status: "active", sessionId: id });
  });

  test("S6 releasing active advances queue", async () => {
    const a = await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    const queued = await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    await cli(s.server, ["session", "release", a.json?.sessionId as string]);
    const r = await cli(s.server, ["session", "get", queued.json?.sessionId as string]);
    expect(r.json).toMatchObject({ status: "active" });
  });

  test("S7 releasing queued shifts positions", async () => {
    await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    const x = await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    const y = await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    await cli(s.server, ["session", "release", x.json?.sessionId as string]);
    const r = await cli(s.server, ["session", "get", y.json?.sessionId as string]);
    expect((r.json as any).position).toBe(1);
  });

  test("S8 release is idempotent", async () => {
    const a = await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    const id = a.json?.sessionId as string;
    const r1 = await cli(s.server, ["session", "release", id]);
    const r2 = await cli(s.server, ["session", "release", id]);
    expect(r1.json).toMatchObject({ released: true });
    expect(r2.json).toMatchObject({ released: true });
    expect(r2.exitCode).toBe(0);
  });

  test("S9 release unknown id is idempotent", async () => {
    const r = await cli(s.server, ["session", "release", "s_nope"]);
    expect(r.exitCode).toBe(0);
    expect(r.json).toMatchObject({ released: true });
  });

  test("S10 get unknown → session_not_found", async () => {
    const r = await cli(s.server, ["session", "get", "s_nope"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.err?.code).toBe("session_not_found");
  });

  test("S11 list returns active and queued", async () => {
    await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
    const r = await cli(s.server, ["session", "list"]);
    expect((r.json as any).sessions.length).toBe(3);
  });

  test("S12 unknown template → template_not_found", async () => {
    const r = await cli(s.server, ["session", "create", "--template", "nope"]);
    expect(r.err?.code).toBe("template_not_found");
  });

  test("S13 missing --template → invalid_argument", async () => {
    const r = await cli(s.server, ["session", "create"]);
    expect(r.err?.code).toBe("invalid_argument");
  });

  test("S14 session ids are unique", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const r = await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
      ids.add(r.json?.sessionId as string);
    }
    expect(ids.size).toBe(5);
  });

  test("S15 concurrency: 20 creates against max 5 → exactly 5 active", async () => {
    await s.stop();
    s = await startServer({ maxByPlatform: { android: 5, ios: 2 } });
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        cli(s.server, ["session", "create", "--template", "pixel6-api35"]),
      ),
    );
    const active = results.filter((r) => r.json?.status === "active").length;
    const queued = results.filter((r) => r.json?.status === "queued").length;
    expect(active).toBe(5);
    expect(queued).toBe(15);
  });

  test("S17 churn leaves no leak", async () => {
    for (let i = 0; i < 30; i += 1) {
      const r = await cli(s.server, ["session", "create", "--template", "pixel6-api35"]);
      await cli(s.server, ["session", "release", r.json?.sessionId as string]);
    }
    const cap = await cli(s.server, ["capacity"]);
    expect((cap.json as any).android).toMatchObject({ active: 0, queued: 0 });
  });
});
