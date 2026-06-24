import http from "node:http";

import { afterEach, describe, expect, test } from "vitest";

import { run } from "../../client/src/cli";
import { startServer, type TestServer } from "./harness";

// Spin up a raw HTTP stub with a custom handler, returning its base URL.
async function stub(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("client contract & errors", () => {
  let s: TestServer | null = null;
  afterEach(() => s?.stop());

  test("E1 error → JSON on stderr, empty stdout, nonzero exit", async () => {
    s = await startServer();
    const r = await run(["session", "get", "s_nope", "--server", s.server]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(JSON.parse(r.stderr).error.code).toBe("session_not_found");
  });

  test("E2 success → exactly one JSON object on stdout, exit 0", async () => {
    s = await startServer();
    const r = await run(["health", "--server", s.server]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    const lines = r.stdout.trim().split("\n");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!).ok).toBe(true);
  });

  test("E3 unknown command → unknown_command", async () => {
    const r = await run(["frobnicate", "things"]);
    expect(r.exitCode).not.toBe(0);
    expect(JSON.parse(r.stderr).error.code).toBe("unknown_command");
  });

  test("E4 missing required flag → invalid_argument", async () => {
    const r = await run(["build", "create"]);
    expect(JSON.parse(r.stderr).error.code).toBe("invalid_argument");
  });

  test("E5 --server > env > default precedence", async () => {
    s = await startServer();
    const original = process.env.TOOLBOX_SERVER;
    try {
      // Flag beats a bogus env value.
      process.env.TOOLBOX_SERVER = "http://127.0.0.1:1";
      const viaFlag = await run(["health", "--server", s.server]);
      expect(viaFlag.exitCode).toBe(0);

      // Env used when no flag present.
      process.env.TOOLBOX_SERVER = s.server;
      const viaEnv = await run(["health"]);
      expect(viaEnv.exitCode).toBe(0);
    } finally {
      if (original === undefined) delete process.env.TOOLBOX_SERVER;
      else process.env.TOOLBOX_SERVER = original;
    }
  });

  test("E6 malformed server response → bad_server_response", async () => {
    const stubServer = await stub((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("this is not json");
    });
    try {
      const r = await run(["health", "--server", stubServer.url]);
      expect(JSON.parse(r.stderr).error.code).toBe("bad_server_response");
    } finally {
      await stubServer.close();
    }
  });

  test("E7 --timeout honored", async () => {
    const stubServer = await stub((_req, res) => {
      // Never responds within the timeout window.
      setTimeout(() => res.end("{}"), 5000).unref();
    });
    try {
      const r = await run(["health", "--server", stubServer.url, "--timeout", "150"]);
      expect(r.exitCode).not.toBe(0);
      expect(JSON.parse(r.stderr).error.code).toBe("timeout");
    } finally {
      await stubServer.close();
    }
  });

  test("E8 stream closed mid-stream → stream_closed after whole lines", async () => {
    const stubServer = await stub((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ status: "queued", position: 1 })}\n`);
      // Drop the connection mid-stream.
      setTimeout(() => res.socket?.destroy(), 30);
    });
    try {
      const r = await run(["session", "wait", "s_x", "--server", stubServer.url]);
      expect(r.exitCode).not.toBe(0);
      expect(JSON.parse(r.stderr).error.code).toBe("stream_closed");
      // The one complete line was still emitted.
      expect(r.stdout.trim().split("\n").length).toBeGreaterThanOrEqual(1);
    } finally {
      await stubServer.close();
    }
  });
});
