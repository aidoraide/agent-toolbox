// Typed programmatic client for the agent-toolbox broker.
//
// The CLI (index.ts) is for shells; this is for TypeScript callers — `createClient`
// returns typed methods for the broker's HTTP API. Kept SELF-CONTAINED (no internal
// imports) so the emitted `.d.ts` is a single file consumers can vendor.

import fs from "node:fs";

export type Platform = "android" | "ios";

export type DeviceAccess =
  | { kind: "adb"; host: string; port: number; serial: string; connectPort: number }
  | { kind: "simctl"; udid: string };

export interface Session {
  sessionId: string;
  status: string;
  platform: Platform;
  template: string;
  templateVersion?: number;
  leasedAt?: string;
  expiresAt?: string;
  access?: DeviceAccess;
}

export interface BuildSummary {
  buildId: string;
  platform: Platform;
  status: string;
  metadata: Record<string, string>;
  artifacts: string[];
}

export interface HostExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface InstallResult {
  installed: boolean;
  package?: string;
}

/** A file to stage host-side for a host-exec run (referenced in argv as {{file:field}}). */
export interface HostExecFile {
  field: string;
  filename: string;
  content: string;
}

export interface CreateSessionInput {
  template: string;
  ttl?: number;
  wait?: boolean;
  failIfBusy?: boolean;
}

export interface ToolboxClientOptions {
  /** Broker base URL. Defaults to $TOOLBOX_SERVER, else http://localhost:4500. */
  server?: string;
  /** Per-request timeout (ms). Omitted = no timeout (leases can block for minutes). */
  timeoutMs?: number;
}

/** A broker error carrying the server's stable `code`. */
export class ToolboxError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ToolboxError";
    this.code = code;
    this.status = status;
  }
}

export interface ToolboxClient {
  /** Lease a device. With `wait` (default true) resolves once active. */
  createSession(input: CreateSessionInput): Promise<Session>;
  releaseSession(id: string): Promise<{ sessionId: string; released: boolean }>;
  getAccess(id: string): Promise<DeviceAccess>;
  listBuilds(): Promise<BuildSummary[]>;
  /** Download a build artifact to `outPath`; returns the byte count written. */
  downloadArtifact(buildId: string, name: string, outPath: string): Promise<number>;
  /** Install a registry build's artifact on the leased device (no upload round-trip). */
  installBuild(id: string, build: string, artifact?: string): Promise<InstallResult>;
  /** Run a host command against the leased device; argv may use {{udid}}/{{home}}/{{file:NAME}}. */
  hostExec(
    id: string,
    spec: { argv: string[]; timeoutMs?: number },
    files?: HostExecFile[],
  ): Promise<HostExecResult>;
  forward(id: string, remote: number, local: number): Promise<{ remote: number; local: number }>;
}

export function createClient(options: ToolboxClientOptions = {}): ToolboxClient {
  const base = (
    options.server ??
    process.env.TOOLBOX_SERVER ??
    "http://localhost:4500"
  ).replace(/\/$/, "");
  const defaultTimeout = options.timeoutMs;

  async function send(
    method: string,
    pathname: string,
    init: RequestInit = {},
    timeoutMs = defaultTimeout,
  ): Promise<Response> {
    const signal =
      timeoutMs && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    let res: Response;
    try {
      res = await fetch(base + pathname, { ...init, signal });
    } catch (err) {
      if ((err as Error).name === "TimeoutError") {
        throw new ToolboxError("timeout", `Request to ${pathname} timed out`, 0);
      }
      throw new ToolboxError("server_unreachable", `Cannot reach broker at ${base}`, 0);
    }
    if (!res.ok) {
      const text = await res.text();
      let code = "bad_server_response";
      let message = text.slice(0, 500) || `HTTP ${res.status}`;
      try {
        const e = (JSON.parse(text) as { error?: { code?: string; message?: string } }).error;
        if (e?.code) code = e.code;
        if (e?.message) message = e.message;
      } catch {
        // non-JSON error body
      }
      throw new ToolboxError(code, message, res.status);
    }
    return res;
  }

  async function json<T>(
    method: string,
    pathname: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const res = await send(method, pathname, init, timeoutMs);
    return (await res.json()) as T;
  }

  return {
    createSession: (input) =>
      json<Session>("POST", "/sessions", {
        template: input.template,
        ttl: input.ttl,
        wait: input.wait ?? true,
        failIfBusy: input.failIfBusy ?? false,
      }),

    releaseSession: (id) =>
      json<{ sessionId: string; released: boolean }>(
        "DELETE",
        `/sessions/${encodeURIComponent(id)}`,
      ),

    getAccess: (id) =>
      json<DeviceAccess>("GET", `/sessions/${encodeURIComponent(id)}/access`),

    listBuilds: async () =>
      (await json<{ builds: BuildSummary[] }>("GET", "/builds")).builds ?? [],

    downloadArtifact: async (buildId, name, outPath) => {
      const res = await send(
        "GET",
        `/builds/${encodeURIComponent(buildId)}/artifact/${encodeURIComponent(name)}`,
      );
      const bytes = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(outPath, bytes);
      return bytes.length;
    },

    installBuild: (id, build, artifact) => {
      const q = new URLSearchParams({ build });
      if (artifact) q.set("artifact", artifact);
      return json<InstallResult>(
        "POST",
        `/sessions/${encodeURIComponent(id)}/install?${q.toString()}`,
      );
    },

    hostExec: async (id, spec, files = []) => {
      const form = new FormData();
      form.append("spec", JSON.stringify(spec));
      for (const f of files) {
        form.append(f.field, new Blob([f.content]), f.filename);
      }
      const res = await send(
        "POST",
        `/sessions/${encodeURIComponent(id)}/host-exec`,
        { method: "POST", body: form },
        spec.timeoutMs ? spec.timeoutMs + 30_000 : undefined,
      );
      return (await res.json()) as HostExecResult;
    },

    forward: (id, remote, local) =>
      json<{ remote: number; local: number }>(
        "POST",
        `/sessions/${encodeURIComponent(id)}/forward`,
        { remote, local },
      ),
  };
}
