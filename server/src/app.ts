import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";

import { BuildManager, FakeBuildRunner } from "./builds";
import { RealBuildRunner } from "./builds-real";
import { ManualClock, SystemClock, type Clock } from "./clock";
import type { ServerConfig } from "./config";
import { AndroidDriver } from "./drivers/android";
import { FakeDriver } from "./drivers/fake";
import { IosDriver } from "./drivers/ios";
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
  cacheKey: z.string().min(1).optional(),
  force: z.boolean().optional(),
  // Arbitrary client tags (feature, git commit, branch, ...).
  metadata: z.record(z.string()).optional(),
});
const advanceClockSchema = z.object({ ms: z.number().int().nonnegative() });

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
    config.driver === "android"
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
    const file = await request.file();
    if (!file) {
      throw new AppError("invalid_argument", "Missing file upload");
    }
    const bytes = await file.toBuffer();
    const { handle } = sessions.resolveForVerb(id, "install");
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

  // --- builds -------------------------------------------------------------
  app.post("/builds", async (request) => {
    const body = parse(buildSchema, request.body);
    return builds.create(body);
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
