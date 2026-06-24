import { afterEach, describe, expect, test } from "vitest";

import { cli, startServer, tmpProject, type TestServer } from "./harness";

// `build create` streams logs to stderr and prints the final result object to
// stdout once the build completes (fake runner here).
async function build(server: string, args: string[]) {
  const r = await cli(server, ["build", "create", ...args]);
  return r;
}

describe("build", () => {
  let s: TestServer;
  afterEach(() => s.stop());

  test("B1 fresh build completes → status done, cacheHit false, has artifacts", async () => {
    s = await startServer();
    const p = tmpProject();
    const r = await build(s.server, ["--platform", "android", "--path", p]);
    expect(r.json).toMatchObject({ status: "done", cacheHit: false });
    expect(r.json?.buildId).toBeTruthy();
    expect((r.json as any).artifacts).toContain("apk");
  });

  test("B1b raw build logs go to stderr, clean JSON to stdout", async () => {
    s = await startServer();
    const p = tmpProject();
    const r = await build(s.server, ["--platform", "android", "--path", p]);
    // stdout is exactly one JSON object…
    expect(r.lines.length).toBe(1);
    // …and the human-readable build log is on stderr, not wrapped in JSON.
    expect(r.stderr).toContain("Building android project");
    expect(r.stderr).not.toContain('"type"');
  });

  test("B2 cached build → done, cacheHit true", async () => {
    s = await startServer();
    const p = tmpProject();
    await build(s.server, ["--platform", "android", "--path", p, "--cache-key", "feat"]);
    const second = await build(s.server, ["--platform", "android", "--path", p, "--cache-key", "feat"]);
    expect(second.json).toMatchObject({ status: "done", cacheHit: true });
  });

  test("B3 --force rebuilds despite cache", async () => {
    s = await startServer();
    const p = tmpProject();
    await build(s.server, ["--platform", "android", "--path", p, "--cache-key", "feat"]);
    const forced = await build(s.server, [
      "--platform", "android", "--path", p, "--cache-key", "feat", "--force",
    ]);
    expect(forced.json).toMatchObject({ cacheHit: false });
  });

  test("B4 different cache key → miss", async () => {
    s = await startServer();
    const p = tmpProject();
    await build(s.server, ["--platform", "android", "--path", p, "--cache-key", "a"]);
    const other = await build(s.server, ["--platform", "android", "--path", p, "--cache-key", "b"]);
    expect(other.json).toMatchObject({ cacheHit: false });
  });

  test("B5 shared cache (no key) hits on second build", async () => {
    s = await startServer();
    const p = tmpProject();
    await build(s.server, ["--platform", "android", "--path", p]);
    const second = await build(s.server, ["--platform", "android", "--path", p]);
    expect(second.json).toMatchObject({ cacheHit: true });
  });

  test("B6 build logs replays stdout then a terminal exit event", async () => {
    s = await startServer();
    const p = tmpProject();
    const created = await build(s.server, ["--platform", "android", "--path", p]);
    const logs = await cli(s.server, ["build", "logs", created.json?.buildId as string]);
    const last = logs.lines.at(-1) as any;
    expect(last.type).toBe("exit");
    expect(last).toHaveProperty("exitCode");
    expect(logs.lines.some((l: any) => l.type === "stdout")).toBe(true);
  });

  test("B7 artifact downloads bytes", async () => {
    s = await startServer();
    const p = tmpProject();
    const created = await build(s.server, ["--platform", "android", "--path", p]);
    const r = await cli(s.server, ["build", "artifact", created.json?.buildId as string, "apk", "-o", tmpProject() + "/out.apk"]);
    expect((r.json?.bytes as number) > 0).toBe(true);
    expect(r.json?.name).toBe("apk");
  });

  test("B8 unknown artifact name → artifact_not_found", async () => {
    s = await startServer();
    const p = tmpProject();
    const created = await build(s.server, ["--platform", "android", "--path", p]);
    const r = await cli(s.server, ["build", "artifact", created.json?.buildId as string, "nope", "-o", tmpProject() + "/x"]);
    expect(r.err?.code).toBe("artifact_not_found");
  });

  test("B9 unknown build id → build_not_found", async () => {
    s = await startServer();
    const r = await cli(s.server, ["build", "artifact", "b_nope", "apk", "-o", tmpProject() + "/x"]);
    expect(r.err?.code).toBe("build_not_found");
  });

  test("B10 failed build → status failed, artifact errors build_failed", async () => {
    s = await startServer();
    const p = tmpProject({ fail: true });
    const created = await build(s.server, ["--platform", "android", "--path", p]);
    expect(created.json).toMatchObject({ status: "failed" });
    const r = await cli(s.server, ["build", "artifact", created.json?.buildId as string, "apk", "-o", tmpProject() + "/x"]);
    expect(r.err?.code).toBe("build_failed");
  });

  test("B11 invalid platform → invalid_argument", async () => {
    s = await startServer();
    const p = tmpProject();
    const r = await build(s.server, ["--platform", "windows", "--path", p]);
    expect(r.err?.code).toBe("invalid_argument");
  });

  test("B12 nonexistent path → project_not_found", async () => {
    s = await startServer();
    const r = await build(s.server, ["--platform", "android", "--path", "/no/such/dir/xyz"]);
    expect(r.err?.code).toBe("project_not_found");
  });
});
