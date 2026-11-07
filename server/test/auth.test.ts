import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createClient } from "../../client/src/lib";
import { cli, startServer, tmpFile, tmpSource, type TestServer } from "./harness";

const TOKEN = "s3cret";

describe("TOOLBOX_TOKEN", () => {
  let s: TestServer;
  const original = process.env.TOOLBOX_TOKEN;

  beforeEach(() => {
    delete process.env.TOOLBOX_TOKEN;
  });
  afterEach(async () => {
    await s.stop();
    if (original === undefined) delete process.env.TOOLBOX_TOKEN;
    else process.env.TOOLBOX_TOKEN = original;
  });

  test("A1 no token configured → open access", async () => {
    s = await startServer();
    const r = await cli(s.server, ["capacity"]);
    expect(r.exitCode).toBe(0);
  });

  test("A2 token configured, client has none → unauthorized", async () => {
    s = await startServer({ token: TOKEN });
    const r = await cli(s.server, ["capacity"]);
    expect(r.err?.code).toBe("unauthorized");
  });

  test("A3 wrong token → unauthorized", async () => {
    s = await startServer({ token: TOKEN });
    process.env.TOOLBOX_TOKEN = "wrong";
    const r = await cli(s.server, ["capacity"]);
    expect(r.err?.code).toBe("unauthorized");
  });

  test("A4 CLI sends TOOLBOX_TOKEN on JSON, upload, stream and download calls", async () => {
    s = await startServer({ token: TOKEN });
    process.env.TOOLBOX_TOKEN = TOKEN;
    expect((await cli(s.server, ["capacity"])).exitCode).toBe(0);

    const uploaded = await cli(s.server, [
      "build", "upload", "--platform", "android", "--artifact", `apk=${tmpFile("a.apk", "bytes")}`,
    ]);
    const id = uploaded.json?.buildId as string;
    expect(id).toBeTruthy();

    expect((await cli(s.server, ["build", "logs", id])).exitCode).toBe(0);
    expect((await cli(s.server, ["build", "artifact", id, "apk", "-o", tmpFile("out.apk")])).json?.bytes).toBe(5);
  });

  test("A5 /health stays open so clients can check reachability", async () => {
    s = await startServer({ token: TOKEN });
    expect((await fetch(`${s.server}/health`)).status).toBe(200);
  });

  test("A6 every other route is protected, including unknown ones", async () => {
    s = await startServer({ token: TOKEN });
    for (const [method, route] of [
      ["GET", "/sessions"],
      ["POST", "/sessions/s_1/host-exec"],
      ["POST", "/builds/upload"],
      ["GET", "/builds"],
      ["GET", "/nope"],
    ] as const) {
      expect((await fetch(`${s.server}${route}`, { method })).status).toBe(401);
    }
  });

  test("A7 typed client uses the token option, falling back to TOOLBOX_TOKEN", async () => {
    s = await startServer({ token: TOKEN });
    await expect(createClient({ server: s.server }).listBuilds()).rejects.toMatchObject({ code: "unauthorized" });
    expect(await createClient({ server: s.server, token: TOKEN }).listBuilds()).toEqual([]);
    process.env.TOOLBOX_TOKEN = TOKEN;
    expect(await createClient({ server: s.server }).listBuilds()).toEqual([]);
  });

  test("A8 typed client uploads artifacts", async () => {
    s = await startServer({ token: TOKEN });
    const build = await createClient({ server: s.server, token: TOKEN }).uploadBuild({
      platform: "android",
      artifacts: { apk: tmpFile("a.apk", "bytes") },
      metadata: { branch: "main" },
    });
    expect(build).toMatchObject({ status: "done", artifacts: ["apk"], metadata: { branch: "main" } });
  });

  test("A9 typed client uploads source, follows the logs, resolves when finished", async () => {
    s = await startServer({ token: TOKEN });
    const logs: string[] = [];
    const build = await createClient({ server: s.server, token: TOKEN }).uploadBuild({
      platform: "android",
      source: tmpSource(),
      onLog: (chunk) => logs.push(chunk),
    });
    expect(build.status).toBe("done");
    expect(logs.join("")).toContain("Building android project");
  });
});
