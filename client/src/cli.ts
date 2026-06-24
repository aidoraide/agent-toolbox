import {
  ClientFail,
  downloadFile,
  requestJson,
  resolveServer,
  streamLines,
  uploadFile,
} from "./http";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set(["force"]);

function parseArgs(tokens: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (token === "-o") {
      flags.output = tokens[++i] ?? "";
      continue;
    }
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = tokens[i + 1];
      if (!BOOLEAN_FLAGS.has(body) && next !== undefined && !next.startsWith("-")) {
        flags[body] = next;
        i += 1;
      } else {
        flags[body] = true;
      }
      continue;
    }
    positionals.push(token);
  }
  return { positionals, flags };
}

function requireFlag(flags: ParsedArgs["flags"], name: string): string {
  const value = flags[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new ClientFail("invalid_argument", `Missing required flag: --${name}`);
  }
  return value;
}

function requirePositional(positionals: string[], index: number, label: string): string {
  const value = positionals[index];
  if (value === undefined) {
    throw new ClientFail("invalid_argument", `Missing required argument: ${label}`);
  }
  return value;
}

function intFlag(flags: ParsedArgs["flags"], name: string): number {
  const raw = requireFlag(flags, name);
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new ClientFail("invalid_argument", `--${name} must be an integer`);
  }
  return value;
}

export async function run(argv: string[]): Promise<RunResult> {
  const { positionals, flags } = parseArgs(argv);
  const out: string[] = [];
  const emit = (obj: unknown) => out.push(JSON.stringify(obj));
  const flush = () => (out.length ? `${out.join("\n")}\n` : "");

  const server = resolveServer(typeof flags.server === "string" ? flags.server : undefined);
  // Default is generous because `session create` blocks until the device boots
  // (a cold emulator can take 60-90s). Override with --timeout for tighter ops.
  const timeoutMs =
    typeof flags.timeout === "string" ? Number(flags.timeout) : 120_000;

  try {
    await dispatch({ positionals, flags, server, timeoutMs, emit });
    return { stdout: flush(), stderr: "", exitCode: 0 };
  } catch (err) {
    const code = err instanceof ClientFail ? err.code : "internal_error";
    const message = err instanceof Error ? err.message : String(err);
    return {
      stdout: flush(),
      stderr: `${JSON.stringify({ error: { code, message } })}\n`,
      exitCode: 1,
    };
  }
}

interface Ctx {
  positionals: string[];
  flags: ParsedArgs["flags"];
  server: string;
  timeoutMs: number;
  emit: (obj: unknown) => void;
}

async function dispatch(ctx: Ctx): Promise<void> {
  const { positionals } = ctx;
  const group = positionals[0];
  const verb = positionals[1];
  const rest = positionals.slice(2);

  switch (group) {
    case "health":
      ctx.emit(await requestJson(ctx.server, "GET", "/health", { timeoutMs: ctx.timeoutMs }));
      return;
    case "capacity":
      ctx.emit(await requestJson(ctx.server, "GET", "/capacity", { timeoutMs: ctx.timeoutMs }));
      return;
    case "templates":
      if (verb !== "list") break;
      ctx.emit(await requestJson(ctx.server, "GET", "/templates", { timeoutMs: ctx.timeoutMs }));
      return;
    case "session":
      return dispatchSession(ctx, verb, rest);
    case "device":
      return dispatchDevice(ctx, verb, rest);
    case "build":
      return dispatchBuild(ctx, verb, rest);
    default:
      break;
  }
  throw new ClientFail("unknown_command", `Unknown command: ${[group, verb].filter(Boolean).join(" ")}`);
}

async function dispatchSession(ctx: Ctx, verb: string | undefined, rest: string[]): Promise<void> {
  const { server, timeoutMs, flags, emit } = ctx;
  switch (verb) {
    case "create": {
      const body: Record<string, unknown> = { template: requireFlag(flags, "template") };
      if (flags.ttl !== undefined) body.ttl = intFlag(flags, "ttl");
      emit(await requestJson(server, "POST", "/sessions", { body, timeoutMs }));
      return;
    }
    case "wait": {
      const id = requirePositional(rest, 0, "sessionId");
      await streamLines(server, "GET", `/sessions/${id}/wait`, timeoutMs, emit);
      return;
    }
    case "list":
      emit(await requestJson(server, "GET", "/sessions", { timeoutMs }));
      return;
    case "get": {
      const id = requirePositional(rest, 0, "sessionId");
      emit(await requestJson(server, "GET", `/sessions/${id}`, { timeoutMs }));
      return;
    }
    case "reset": {
      const id = requirePositional(rest, 0, "sessionId");
      const mode = typeof flags.mode === "string" ? flags.mode : "snapshot";
      emit(await requestJson(server, "POST", `/sessions/${id}/reset`, { body: { mode }, timeoutMs }));
      return;
    }
    case "heartbeat": {
      const id = requirePositional(rest, 0, "sessionId");
      emit(await requestJson(server, "POST", `/sessions/${id}/heartbeat`, { timeoutMs }));
      return;
    }
    case "release": {
      const id = requirePositional(rest, 0, "sessionId");
      emit(await requestJson(server, "DELETE", `/sessions/${id}`, { timeoutMs }));
      return;
    }
    default:
      throw new ClientFail("unknown_command", `Unknown command: session ${verb ?? ""}`);
  }
}

async function dispatchDevice(ctx: Ctx, verb: string | undefined, rest: string[]): Promise<void> {
  const { server, timeoutMs, flags, emit } = ctx;
  const id = requirePositional(rest, 0, "sessionId");
  switch (verb) {
    case "shell": {
      const command = requirePositional(rest, 1, "command");
      emit(await requestJson(server, "POST", `/sessions/${id}/shell`, { body: { command }, timeoutMs }));
      return;
    }
    case "install": {
      const file = requirePositional(rest, 1, "file");
      emit(await uploadFile(server, `/sessions/${id}/install`, file, timeoutMs));
      return;
    }
    case "forward": {
      const remote = intFlag(flags, "remote");
      const local = intFlag(flags, "local");
      emit(await requestJson(server, "POST", `/sessions/${id}/forward`, { body: { remote, local }, timeoutMs }));
      return;
    }
    case "screenshot": {
      const outPath = typeof flags.output === "string" && flags.output ? flags.output : "screenshot.png";
      const bytes = await downloadFile(server, `/sessions/${id}/screenshot`, outPath, timeoutMs);
      emit({ path: outPath, bytes });
      return;
    }
    case "logs":
      await streamLines(server, "GET", `/sessions/${id}/logs`, timeoutMs, emit);
      return;
    case "input": {
      const type = requirePositional(rest, 1, "input type");
      let body: Record<string, unknown>;
      if (type === "tap") {
        body = { type, x: Number(requirePositional(rest, 2, "x")), y: Number(requirePositional(rest, 3, "y")) };
      } else if (type === "swipe") {
        body = {
          type,
          x1: Number(requirePositional(rest, 2, "x1")),
          y1: Number(requirePositional(rest, 3, "y1")),
          x2: Number(requirePositional(rest, 4, "x2")),
          y2: Number(requirePositional(rest, 5, "y2")),
        };
      } else {
        throw new ClientFail("invalid_argument", `Unknown input type: ${type}`);
      }
      emit(await requestJson(server, "POST", `/sessions/${id}/input`, { body, timeoutMs }));
      return;
    }
    default:
      throw new ClientFail("unknown_command", `Unknown command: device ${verb ?? ""}`);
  }
}

async function dispatchBuild(ctx: Ctx, verb: string | undefined, rest: string[]): Promise<void> {
  const { server, timeoutMs, flags, emit } = ctx;
  switch (verb) {
    case "create": {
      const body: Record<string, unknown> = {
        platform: requireFlag(flags, "platform"),
        projectPath: requireFlag(flags, "path"),
      };
      if (typeof flags["cache-key"] === "string") body.cacheKey = flags["cache-key"];
      if (flags.force === true) body.force = true;
      emit(await requestJson(server, "POST", "/builds", { body, timeoutMs }));
      return;
    }
    case "logs": {
      const id = requirePositional(rest, 0, "buildId");
      await streamLines(server, "GET", `/builds/${id}/logs`, timeoutMs, emit);
      return;
    }
    case "artifact": {
      const id = requirePositional(rest, 0, "buildId");
      const name = requirePositional(rest, 1, "artifact name");
      const outPath = typeof flags.output === "string" && flags.output ? flags.output : name;
      const bytes = await downloadFile(server, `/builds/${id}/artifact/${name}`, outPath, timeoutMs);
      emit({ path: outPath, bytes, name });
      return;
    }
    default:
      throw new ClientFail("unknown_command", `Unknown command: build ${verb ?? ""}`);
  }
}
