import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";

import { BuildManager, FakeBuildRunner } from "./builds";
import { RealBuildRunner } from "./builds-real";
import { ManualClock, SystemClock, type Clock } from "./clock";
import type { ServerConfig } from "./config";
import { AndroidDriver } from "./drivers/android";
import { CompositeDriver } from "./drivers/composite";
import { FakeDriver } from "./drivers/fake";
import { IosDriver } from "./drivers/ios";
import { run } from "./drivers/sdk";
import type { DeviceDriver, InputSpec, ResetMode } from "./drivers/driver";
import { AppError, errorBody } from "./errors";
import { reconcile } from "./reconcile";
import { SessionManager } from "./sessions";

const VERSION = "0.1.0";

const createSessionSchema = z.object({
  template: z.string().min(1),
  ttl: z.number().int().positive().optional(),
  // Default (applied in the handler): block until active. false → return queued.
  wait: z.boolean().optional(),
  // If the pool is full, fail with pool_full instead of queuing.
  failIfBusy: z.boolean().optional(),
});
const resetSchema = z.object({
  mode: z.enum(["snapshot", "wipe", "reboot"]).default("snapshot"),
});
const shellSchema = z.object({ command: z.string().min(1) });
const forwardSchema = z.object({
  remote: z.number().int().positive(),
  local: z.number().int().positive(),
});
const inputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tap"), x: z.number(), y: z.number() }),
  z.object({
    type: z.literal("swipe"),
    x1: z.number(),
    y1: z.number(),
    x2: z.number(),
    y2: z.number(),
  }),
]);
const buildSchema = z.object({
  platform: z.string().min(1),
  projectPath: z.string().min(1),
  // Arbitrary client tags (feature, git commit, branch, ...).
  metadata: z.record(z.string()).optional(),
});

const importBuildSchema = z.object({
  platform: z.string().min(1),
  artifacts: z.record(z.string().min(1)),
  metadata: z.record(z.string()).optional(),
});
const advanceClockSchema = z.object({ ms: z.number().int().nonnegative() });

// A generic host command run against a leased device. An off-host client (e.g. a
// container that can't reach an iOS sim directly) asks the broker to run a host
// command with the device's id substituted in; the broker stays agnostic to
// whatever tool that is. argv placeholders: {{udid}}/{{serial}} -> the device id;
// {{home}} -> the broker's home dir (build absolute tool paths with it, so a
// client needn't rely on the broker's PATH); {{file:NAME}} -> the staged path of
// an uploaded file named NAME.
const hostExecSchema = z.object({
  argv: z.array(z.string().min(1)).min(1),
  timeoutMs: z.number().int().positive().max(900_000).optional(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AppError("invalid_argument", result.error.issues[0]?.message ?? "Invalid request");
  }
  return result.data;
}

async function streamNdjson(
  request: FastifyRequest,
  reply: FastifyReply,
  source: AsyncIterable<unknown>,
): Promise<void> {
  const controller = new AbortController();
  request.raw.on("close", () => controller.abort());
  reply.hijack();
  reply.raw.writeHead(200, { "content-type": "application/x-ndjson" });
  try {
    for await (const event of source) {
      if (controller.signal.aborted) break;
      reply.raw.write(`${JSON.stringify(event)}\n`);
    }
  } finally {
    reply.raw.end();
  }
}

export interface BuiltApp {
  app: FastifyInstance;
  driver: DeviceDriver;
  clock: Clock;
}

export async function buildApp(config: ServerConfig): Promise<BuiltApp> {
  const clock: Clock = config.testMode ? new ManualClock() : new SystemClock();
  const driver: DeviceDriver =
    config.driver === "all"
      ? new CompositeDriver({
          android: new AndroidDriver(config.cacheDir, config.tagPrefix),
          ios: new IosDriver(config.tagPrefix),
        })
      : config.driver === "android"
        ? new AndroidDriver(config.cacheDir, config.tagPrefix)
        : config.driver === "ios"
          ? new IosDriver(config.tagPrefix)
          : new FakeDriver(config.tagPrefix, config.seedInstances);

  // Reconcile orphans before anything else can lease.
  await reconcile(driver);

  const sessions = new SessionManager(driver, config, clock);
  // Real toolchain builds (Gradle/xcodebuild) unless we're on the fake driver.
  const buildRunner = config.driver === "fake" ? new FakeBuildRunner() : new RealBuildRunner();
  const builds = new BuildManager(buildRunner, clock, config.cacheDir);

  const app = Fastify({ logger: false });
  await app.register(multipart, { limits: { fileSize: 1024 * 1024 * 1024 } });

  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof AppError) {
      reply.status(err.httpStatus).send(errorBody(err));
      return;
    }
    // Fastify body-parse / validation failures collapse to invalid_argument.
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 400 && status < 500) {
      reply.status(400).send({ error: { code: "invalid_argument", message: err.message } });
      return;
    }
    reply.status(500).send(errorBody(err));
  });

  // --- health & capacity --------------------------------------------------
  app.get("/health", async () => ({ ok: true, service: "agent-toolbox", version: VERSION }));
  app.get("/capacity", async () => sessions.capacity());

  // --- templates ----------------------------------------------------------
  app.get("/templates", async () => ({
    templates: config.templates.map((t) => ({
      slug: t.slug,
      platform: t.platform,
      name: t.name,
      version: t.version,
    })),
  }));

  // --- sessions -----------------------------------------------------------
  app.post("/sessions", async (request) => {
    const { template, ttl, wait, failIfBusy } = parse(createSessionSchema, request.body);
    return sessions.createAndWait(template, ttl, {
      wait: wait ?? true,
      failIfBusy: failIfBusy ?? false,
    });
  });
  app.get("/sessions", async () => ({ sessions: sessions.list() }));
  app.get("/sessions/:id", async (request) => {
    const { id } = request.params as { id: string };
    return sessions.get(id);
  });
  app.delete("/sessions/:id", async (request) => {
    const { id } = request.params as { id: string };
    return sessions.release(id);
  });
  app.post("/sessions/:id/reset", async (request) => {
    const { id } = request.params as { id: string };
    const { mode } = parse(resetSchema, request.body ?? {});
    return sessions.reset(id, mode as ResetMode);
  });
  app.post("/sessions/:id/heartbeat", async (request) => {
    const { id } = request.params as { id: string };
    return sessions.heartbeat(id);
  });
  app.get("/sessions/:id/access", async (request) => {
    const { id } = request.params as { id: string };
    return sessions.getAccess(id);
  });
  app.get("/sessions/:id/wait", async (request, reply) => {
    const { id } = request.params as { id: string };
    // Surfaces session_not_found synchronously before hijacking the stream.
    const controller = new AbortController();
    request.raw.on("close", () => controller.abort());
    const source = sessions.watch(id, controller.signal);
    await streamNdjson(request, reply, source);
  });

  // --- device proxy -------------------------------------------------------
  app.post("/sessions/:id/shell", async (request) => {
    const { id } = request.params as { id: string };
    const { command } = parse(shellSchema, request.body);
    const { handle } = sessions.resolveForVerb(id, "shell");
    return driver.shell(handle, command);
  });
  app.post("/sessions/:id/install", async (request) => {
    const { id } = request.params as { id: string };
    const { handle, platform } = sessions.resolveForVerb(id, "install");
    // Install a registry build the broker already holds (?build=<id>) — no upload
    // round-trip — or an uploaded file. The artifact format is sniffed from its
    // bytes (gzip vs zip), so callers needn't know how it was packed.
    const q = request.query as { build?: string; artifact?: string };
    if (q.build) {
      const artifact = q.artifact ?? (platform === "android" ? "apk" : "app");
      const bytes = await builds.artifact(q.build, artifact);
      const name =
        platform === "android"
          ? "build.apk"
          : bytes[0] === 0x1f && bytes[1] === 0x8b
            ? "build.tgz"
            : "build.zip";
      return driver.install(handle, name, bytes);
    }
    const file = await request.file();
    if (!file) {
      throw new AppError(
        "invalid_argument",
        "Missing file upload or ?build=<id>",
      );
    }
    const bytes = await file.toBuffer();
    return driver.install(handle, file.filename, bytes);
  });
  app.post("/sessions/:id/forward", async (request) => {
    const { id } = request.params as { id: string };
    const { remote, local } = parse(forwardSchema, request.body);
    const { handle } = sessions.resolveForVerb(id, "forward");
    await driver.forward(handle, remote, local);
    return { remote, local };
  });
  app.get("/sessions/:id/screenshot", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { handle } = sessions.resolveForVerb(id, "screenshot");
    const bytes = await driver.screenshot(handle);
    reply.header("content-type", "image/png");
    return reply.send(bytes);
  });
  app.get("/sessions/:id/logs", async (request, reply) => {
    const { id } = request.params as { id: string };
    const controller = new AbortController();
    request.raw.on("close", () => controller.abort());
    const { handle } = sessions.resolveForVerb(id, "logs");
    await streamNdjson(request, reply, driver.logs(handle, controller.signal));
  });
  app.post("/sessions/:id/input", async (request) => {
    const { id } = request.params as { id: string };
    const spec = parse(inputSchema, request.body) as InputSpec;
    const { handle } = sessions.resolveForVerb(id, "input");
    await driver.input(handle, spec);
    return { ok: true };
  });
  // Generic host-exec: run a command on the broker's HOST against the leased
  // device, returning {stdout, stderr, exitCode}. This is how an off-host client
  // (a container) drives a device it can't reach directly — the iOS analogue of
  // the adb-over-TCP tunnel: it tells the broker which host tool to run, and the
  // broker stays tool-agnostic. Multipart: field "spec" (JSON {argv, timeoutMs})
  // plus any files to stage for the run (referenced in argv as {{file:NAME}}).
  app.post("/sessions/:id/host-exec", async (request) => {
    const { id } = request.params as { id: string };
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "agtbx-hostexec-"));
    const staged: Record<string, string> = {};
    let specRaw: string | null = null;
    try {
      for await (const part of request.parts()) {
        if (part.type === "file") {
          const dest = path.join(
            workdir,
            path.basename(part.filename ?? part.fieldname),
          );
          fs.writeFileSync(dest, await part.toBuffer());
          staged[part.fieldname] = dest;
        } else if (part.type === "field" && part.fieldname === "spec") {
          specRaw = String((part as { value: unknown }).value);
        }
      }
      if (specRaw == null) {
        throw new AppError("invalid_argument", "Missing 'spec' field");
      }
      const spec = parse(hostExecSchema, JSON.parse(specRaw));
      const { handle } = sessions.resolveActive(id);
      const deviceId = handle.serial; // adb serial / sim udid
      const home = os.homedir();
      const argv = spec.argv.map((token) =>
        token
          .replace(/\{\{(?:udid|serial)\}\}/g, deviceId)
          .replace(/\{\{home\}\}/g, home)
          .replace(
            /\{\{file:([^}]+)\}\}/g,
            (_m, name: string) => staged[name] ?? "",
          ),
      );
      const [cmd, ...rest] = argv;
      if (cmd === undefined) {
        throw new AppError("invalid_argument", "argv must not be empty");
      }
      const r = await run(cmd, rest, {
        timeoutMs: spec.timeoutMs ?? 300_000,
      });
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code };
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  // --- builds -------------------------------------------------------------
  app.post("/builds", async (request) => {
    const body = parse(buildSchema, request.body);
    return builds.create(body);
  });
  app.post("/builds/import", async (request) => {
    const body = parse(importBuildSchema, request.body);
    return builds.import(body);
  });
  app.get("/builds", async () => ({ builds: builds.list() }));
  app.get("/builds/:id", async (request) => {
    const { id } = request.params as { id: string };
    return builds.summary(id);
  });
  app.get("/builds/:id/logs", async (request, reply) => {
    const { id } = request.params as { id: string };
    const controller = new AbortController();
    request.raw.on("close", () => controller.abort());
    await streamNdjson(request, reply, builds.logs(id, controller.signal));
  });
  app.get("/builds/:id/artifact/:name", async (request, reply) => {
    const { id, name } = request.params as { id: string; name: string };
    const bytes = await builds.artifact(id, name);
    reply.header("content-type", "application/octet-stream");
    return reply.send(bytes);
  });

  // --- test-mode endpoints ------------------------------------------------
  if (config.testMode) {
    app.post("/_test/advance-clock", async (request) => {
      const { ms } = parse(advanceClockSchema, request.body);
      if (!(clock instanceof ManualClock)) {
        throw new AppError("invalid_argument", "Clock is not manual");
      }
      clock.advance(ms);
      // Let any async reap work settle before responding.
      await new Promise((resolve) => setImmediate(resolve));
      return { now: clock.now() };
    });
    app.get("/_test/driver-state", async () => ({
      instanceCount: driver.instanceCount(),
      instances: await driver.discoverInstances(),
    }));
  }

  return { app, driver, clock };
}
