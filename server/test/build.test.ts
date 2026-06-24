import { afterEach, describe, expect, test } from "vitest";

import { cli, startServer, tmpProject, type TestServer } from "./harness";

// Build completes asynchronously; draining its log stream guarantees completion
// (and population of the cache) before the next assertion.
async function buildAndWait(
  server: string,
  args: string[],
): Promise<{ buildId: string; cacheHit: boolean; status: string }> {
  const r = await cli(server, ["build", "create", ...args]);
  const buildId = r.json?.buildId as string;
  await cli(server, ["build", "logs", buildId]);
  return {
    buildId,
    cacheHit: r.json?.cacheHit as boolean,
    status: r.json?.status as string,
  };
}

describe("build", () => {
  let s: TestServer;
  afterEach(() => s.stop());

  test("B1 fresh build → running, cacheHit false", async () => {
    s = await startServer();
    const p = tmpProject();
    const r = await cli(s.server, ["build", "create", "--platform", "android", "--path", p]);
    expect(r.json).toMatchObject({ status: "running", cacheHit: false });
    expect(r.json?.buildId).toBeTruthy();
  });

  test("B2 cached build → done, cacheHit true", async () => {
    s = await startServer();
    const p = tmpProject();
    await buildAndWait(s.server, ["--platform", "android", "--path", p, "--cache-key", "feat"]);
    const second = await cli(s.server, [
      "build", "create", "--platform", "android", "--path", p, "--cache-key", "feat",
    ]);
    expect(second.json).toMatchObject({ status: "done", cacheHit: true });
  });

  test("B3 --force rebuilds despite cache", async () => {
    s = await startServer();
    const p = tmpProject();
    await buildAndWait(s.server, ["--platform", "android", "--path", p, "--cache-key", "feat"]);
    const forced = await cli(s.server, [
      "build", "create", "--platform", "android", "--path", p, "--cache-key", "feat", "--force",
    ]);
    expect(forced.json).toMatchObject({ cacheHit: false });
  });

  test("B4 different cache key → miss", async () => {
    s = await startServer();
    const p = tmpProject();
    await buildAndWait(s.server, ["--platform", "android", "--path", p, "--cache-key", "a"]);
    const other = await cli(s.server, [
      "build", "create", "--platform", "android", "--path", p, "--cache-key", "b",
    ]);
    expect(other.json).toMatchObject({ cacheHit: false });
  });

  test("B5 shared cache (no key) hits on second build", async () => {
    s = await startServer();
    const p = tmpProject();
    await buildAndWait(s.server, ["--platform", "android", "--path", p]);
    const second = await cli(s.server, ["build", "create", "--platform", "android", "--path", p]);
    expect(second.json).toMatchObject({ cacheHit: true });
  });

  test("B6 logs stream stdout then a terminal exit event", async () => {
    s = await startServer();
    const p = tmpProject();
    const created = await cli(s.server, ["build", "create", "--platform", "android", "--path", p]);
    const logs = await cli(s.server, ["build", "logs", created.json?.buildId as string]);
    const last = logs.lines.at(-1) as any;
    expect(last.type).toBe("exit");
    expect(last).toHaveProperty("exitCode");
    expect(last).toHaveProperty("ok");
    expect(last).toHaveProperty("durationMs");
    expect(logs.lines.some((l: any) => l.type === "stdout")).toBe(true);
  });

  test("B7 artifact downloads bytes", async () => {
    s = await startServer();
    const p = tmpProject();
    const { buildId } = await buildAndWait(s.server, ["--platform", "android", "--path", p]);
    const r = await cli(s.server, ["build", "artifact", buildId, "apk", "-o", tmpProject() + "/out.apk"]);
    expect((r.json?.bytes as number) > 0).toBe(true);
    expect(r.json?.name).toBe("apk");
  });

  test("B8 unknown artifact name → artifact_not_found", async () => {
    s = await startServer();
    const p = tmpProject();
    const { buildId } = await buildAndWait(s.server, ["--platform", "android", "--path", p]);
    const r = await cli(s.server, ["build", "artifact", buildId, "nope", "-o", tmpProject() + "/x"]);
    expect(r.err?.code).toBe("artifact_not_found");
  });

  test("B9 unknown build id → build_not_found", async () => {
    s = await startServer();
    const r = await cli(s.server, ["build", "artifact", "b_nope", "apk", "-o", tmpProject() + "/x"]);
    expect(r.err?.code).toBe("build_not_found");
  });

  test("B10 artifact of failed build → build_failed", async () => {
    s = await startServer();
    const p = tmpProject({ fail: true });
    const { buildId } = await buildAndWait(s.server, ["--platform", "android", "--path", p]);
    const r = await cli(s.server, ["build", "artifact", buildId, "apk", "-o", tmpProject() + "/x"]);
    expect(r.err?.code).toBe("build_failed");
  });

  test("B11 invalid platform → invalid_argument", async () => {
    s = await startServer();
    const p = tmpProject();
    const r = await cli(s.server, ["build", "create", "--platform", "windows", "--path", p]);
    expect(r.err?.code).toBe("invalid_argument");
  });

  test("B12 nonexistent path → project_not_found", async () => {
    s = await startServer();
    const r = await cli(s.server, [
      "build", "create", "--platform", "android", "--path", "/no/such/dir/xyz",
    ]);
    expect(r.err?.code).toBe("project_not_found");
  });
});
