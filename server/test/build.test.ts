import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { findProjectDir, installDirs } from "../src/builds-real";
import { cli, startServer, tmpFile, tmpProject, tmpSource, type TestServer } from "./harness";

// `build upload --source` streams logs to stderr and prints the final result
// object to stdout once the build completes (fake runner here).
async function build(server: string, args: string[], zip = tmpSource()) {
  return cli(server, ["build", "upload", "--source", zip, ...args]);
}

const ANDROID = ["--platform", "android"];

describe("build upload --source", () => {
  let s: TestServer;
  afterEach(() => s.stop());

  test("B1 fresh build completes → status done, has artifacts", async () => {
    s = await startServer();
    const r = await build(s.server, ANDROID);
    expect(r.json).toMatchObject({ status: "done" });
    expect(r.json?.buildId).toBeTruthy();
    expect((r.json as any).artifacts).toContain("apk");
  });

  test("B1b raw build logs go to stderr, clean JSON to stdout", async () => {
    s = await startServer();
    const r = await build(s.server, ANDROID);
    // stdout is exactly one JSON object…
    expect(r.lines.length).toBe(1);
    // …and the human-readable build log is on stderr, not wrapped in JSON.
    expect(r.stderr).toContain("Building android project");
    expect(r.stderr).not.toContain('"type"');
  });

  test("B5 every upload builds fresh (no behind-the-scenes caching)", async () => {
    s = await startServer();
    const zip = tmpSource();
    const first = await build(s.server, ANDROID, zip);
    const second = await build(s.server, ANDROID, zip);
    // Distinct builds, each compiled — two entries in the registry.
    expect(first.json?.buildId).not.toBe(second.json?.buildId);
    const list = await cli(s.server, ["build", "list"]);
    expect(((list.json as any).builds as any[]).length).toBe(2);
  });

  test("B6 build logs replays stdout then a terminal exit event", async () => {
    s = await startServer();
    const created = await build(s.server, ANDROID);
    const logs = await cli(s.server, ["build", "logs", created.json?.buildId as string]);
    const last = logs.lines.at(-1) as any;
    expect(last.type).toBe("exit");
    expect(last).toHaveProperty("exitCode");
    expect(logs.lines.some((l: any) => l.type === "stdout")).toBe(true);
  });

  test("B7 artifact downloads bytes", async () => {
    s = await startServer();
    const created = await build(s.server, ANDROID);
    const r = await cli(s.server, ["build", "artifact", created.json?.buildId as string, "apk", "-o", tmpProject() + "/out.apk"]);
    expect((r.json?.bytes as number) > 0).toBe(true);
    expect(r.json?.name).toBe("apk");
  });

  test("B8 unknown artifact name → artifact_not_found", async () => {
    s = await startServer();
    const created = await build(s.server, ANDROID);
    const r = await cli(s.server, ["build", "artifact", created.json?.buildId as string, "nope", "-o", tmpProject() + "/x"]);
    expect(r.err?.code).toBe("artifact_not_found");
  });

  test("B8b the registry's own files aren't downloadable as artifacts", async () => {
    s = await startServer();
    const created = await build(s.server, ANDROID);
    const r = await cli(s.server, ["build", "artifact", created.json?.buildId as string, "record.json", "-o", tmpProject() + "/x"]);
    expect(r.err?.code).toBe("artifact_not_found");
  });

  test("B9 unknown build id → build_not_found", async () => {
    s = await startServer();
    const r = await cli(s.server, ["build", "artifact", "b_nope", "apk", "-o", tmpProject() + "/x"]);
    expect(r.err?.code).toBe("build_not_found");
  });

  test("B10 failed build → status failed, artifact errors build_failed", async () => {
    s = await startServer();
    const created = await build(s.server, ANDROID, tmpSource({ fail: true }));
    expect(created.json).toMatchObject({ status: "failed" });
    const r = await cli(s.server, ["build", "artifact", created.json?.buildId as string, "apk", "-o", tmpProject() + "/x"]);
    expect(r.err?.code).toBe("build_failed");
  });

  test("B10b a file that isn't a zip → status failed with the error in the logs", async () => {
    s = await startServer();
    const created = await build(s.server, ANDROID, tmpFile("app.zip", "not a zip"));
    expect(created.json).toMatchObject({ status: "failed" });
    expect(created.stderr).toContain("unzip");
  });

  test("B11 invalid platform → invalid_argument", async () => {
    s = await startServer();
    const r = await build(s.server, ["--platform", "windows"]);
    expect(r.err?.code).toBe("invalid_argument");
  });

  test("B12 nonexistent zip → invalid_argument", async () => {
    s = await startServer();
    const r = await build(s.server, ANDROID, "/no/such/app.zip");
    expect(r.err?.code).toBe("invalid_argument");
  });

  test("B12b --app-dir can't escape the zip", async () => {
    s = await startServer();
    for (const appDir of ["../outside", "/etc", "a/../../b"]) {
      const r = await build(s.server, [...ANDROID, "--app-dir", appDir]);
      expect(r.err?.code).toBe("invalid_argument");
    }
  });

  test("B13 build records client metadata + a build time", async () => {
    s = await startServer();
    const r = await build(s.server, [
      ...ANDROID,
      "--meta", "feature=launcher", "--meta", "commit=abc123", "--meta", "branch=main",
    ]);
    expect(r.json?.metadata).toEqual({ feature: "launcher", commit: "abc123", branch: "main" });
    expect(typeof r.json?.createdAt).toBe("string");
    expect(typeof r.json?.durationMs).toBe("number");
  });

  test("B14 build list registry returns builds newest-first with metadata", async () => {
    s = await startServer();
    await build(s.server, [...ANDROID, "--meta", "feature=a"]);
    await build(s.server, ["--platform", "ios", "--meta", "feature=b"]);
    const r = await cli(s.server, ["build", "list"]);
    const list = (r.json as any).builds as any[];
    expect(list.length).toBe(2);
    expect(list[0]).toHaveProperty("buildId");
    expect(list[0]).toHaveProperty("platform");
    expect(list[0]).toHaveProperty("status");
    expect(list[0]).toHaveProperty("artifacts");
    expect(list[0]).toHaveProperty("metadata");
    expect(list[0]).toHaveProperty("createdAt");
  });

  test("B15 registry survives a server restart (persisted to cacheDir)", async () => {
    const cacheDir = makeCacheDir();
    s = await startServer({ cacheDir });
    const first = await build(s.server, [...ANDROID, "--meta", "feature=persist"]);
    const buildId = first.json?.buildId as string;
    await s.stop();

    // New server, same cacheDir → the build is still in the registry and its
    // artifact is still downloadable.
    s = await startServer({ cacheDir });
    const list = await cli(s.server, ["build", "list"]);
    expect(((list.json as any).builds as any[]).some((b) => b.buildId === buildId)).toBe(true);
    const art = await cli(s.server, ["build", "artifact", buildId, "apk", "-o", tmpProject() + "/out.apk"]);
    expect((art.json?.bytes as number) > 0).toBe(true);
  });
});

describe("build upload --artifact", () => {
  let s: TestServer;
  afterEach(() => s.stop());

  async function upload(args: string[]) {
    return cli(s.server, ["build", "upload", ...args]);
  }

  test("B16 stores finished artifacts, downloadable byte for byte", async () => {
    s = await startServer();
    const r = await upload([
      ...ANDROID,
      "--artifact", `apk=${tmpFile("a.apk", "app-bytes")}`,
      "--artifact", `test-apk=${tmpFile("t.apk", "test-bytes")}`,
      "--meta", "branch=main",
    ]);
    expect(r.json).toMatchObject({ status: "done", metadata: { branch: "main" } });
    expect((r.json as any).artifacts).toEqual(["apk", "test-apk"]);

    const out = tmpProject() + "/out.apk";
    await cli(s.server, ["build", "artifact", r.json?.buildId as string, "test-apk", "-o", out]);
    expect(fs.readFileSync(out, "utf8")).toBe("test-bytes");
  });

  test("B17 iOS artifact names work too", async () => {
    s = await startServer();
    const r = await upload(["--platform", "ios", "--artifact", `app=${tmpFile("App.tgz")}`]);
    expect((r.json as any).artifacts).toEqual(["app"]);
  });

  test("B18 --source and --artifact are mutually exclusive, and one is required", async () => {
    s = await startServer();
    const both = await upload([...ANDROID, "--source", tmpSource(), "--artifact", `apk=${tmpFile("a.apk")}`]);
    expect(both.err?.code).toBe("invalid_argument");
    const neither = await upload(ANDROID);
    expect(neither.err?.code).toBe("invalid_argument");
  });

  test("B19 artifact names are limited to the platform's, so they can't escape the build dir", async () => {
    s = await startServer();
    for (const name of ["../../evil", "app", "record.json"]) {
      const r = await upload([...ANDROID, "--artifact", `${name}=${tmpFile("a.apk")}`]);
      expect(r.err?.code).toBe("invalid_argument");
    }
    const list = await cli(s.server, ["build", "list"]);
    expect((list.json as any).builds).toEqual([]);
  });

  test("B20 missing local artifact → invalid_argument", async () => {
    s = await startServer();
    const r = await upload([...ANDROID, "--artifact", "apk=/no/such/file.apk"]);
    expect(r.err?.code).toBe("invalid_argument");
  });
});

describe("finding the project in a source zip", () => {
  function tree(files: Record<string, string>): string {
    const root = tmpProject();
    fs.rmSync(path.join(root, "README"));
    for (const [file, contents] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), contents);
    }
    return root;
  }
  const EXPO_PKG = JSON.stringify({ dependencies: { expo: "54.0.0" } });

  test("P1 finds a nested Expo app beside its shared code", () => {
    const root = tree({
      "package.json": JSON.stringify({ dependencies: {} }),
      "src/lib/package.json": "{}",
      "expo-app/package.json": EXPO_PKG,
      "expo-app/app.json": "{}",
    });
    expect(findProjectDir(root, "android")).toBe(path.join(root, "expo-app"));
    expect(findProjectDir(root, "ios")).toBe(path.join(root, "expo-app"));
  });

  test("P2 finds a plain native project by platform", () => {
    const root = tree({ "android/gradlew": "", "ios/App.xcodeproj/project.pbxproj": "" });
    expect(findProjectDir(root, "android")).toBe(path.join(root, "android"));
    expect(findProjectDir(root, "ios")).toBe(path.join(root, "ios"));
  });

  test("P3 prefers the shallowest match, ignoring node_modules", () => {
    const root = tree({ "gradlew": "", "sub/gradlew": "", "node_modules/x/gradlew": "" });
    expect(findProjectDir(root, "android")).toBe(root);
  });

  test("P4 two projects at the same depth → asks for --app-dir", () => {
    const root = tree({ "a/gradlew": "", "b/gradlew": "" });
    expect(() => findProjectDir(root, "android")).toThrow(/--app-dir/);
  });

  test("P5 no project → project_not_found", () => {
    expect(() => findProjectDir(tree({ "notes.txt": "" }), "android")).toThrow(/No android project/);
  });

  test("P6 installs parents and local deps with lockfiles, then the app", () => {
    const root = tree({
      "package.json": "{}",
      "package-lock.json": "{}",
      "src/lib/package.json": "{}",
      "src/lib/package-lock.json": "{}",
      "src/no-lock/package.json": "{}",
      "apps/package.json": "{}",
      "apps/app/app.json": "{}",
      "apps/app/package.json": JSON.stringify({
        dependencies: { expo: "54.0.0", lib: "file:../../src/lib", other: "file:../../src/no-lock" },
      }),
    });
    expect(installDirs(root, path.join(root, "apps/app"))).toEqual([
      root,
      path.join(root, "src/lib"),
      path.join(root, "apps/app"),
    ]);
  });
});

function makeCacheDir(): string {
  return tmpFile(".keep").replace(/\/[^/]+$/, "");
}
