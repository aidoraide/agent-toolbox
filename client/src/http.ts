import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Client-side failures carry a stable `code` just like server errors, so the
// emitted JSON is uniform regardless of where the failure originated.
export class ClientFail extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function resolveServer(flagServer?: string): string {
  if (flagServer) return flagServer;
  if (process.env.TOOLBOX_SERVER) return process.env.TOOLBOX_SERVER;
  try {
    const configPath = path.join(os.homedir(), ".config", "agent-toolbox", "config.json");
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8")) as { server?: string };
    if (cfg.server) return cfg.server;
  } catch {
    // no config file — fall through to default
  }
  return "http://localhost:4500";
}

async function readError(res: Response, text: string): Promise<never> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ClientFail("bad_server_response", text.slice(0, 500) || `HTTP ${res.status}`);
  }
  const err = (parsed as { error?: { code?: string; message?: string } }).error;
  throw new ClientFail(err?.code ?? "bad_server_response", err?.message ?? `HTTP ${res.status}`);
}

async function doFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if ((err as Error).name === "TimeoutError") {
      throw new ClientFail("timeout", `Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw new ClientFail("server_unreachable", `Cannot reach server at ${url}`);
  }
}

export async function requestJson(
  server: string,
  method: string,
  pathname: string,
  opts: { body?: unknown; timeoutMs: number },
): Promise<unknown> {
  const init: RequestInit = { method };
  if (opts.body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }
  const res = await doFetch(server + pathname, init, opts.timeoutMs);
  const text = await res.text();
  if (!res.ok) await readError(res, text);
  try {
    return JSON.parse(text);
  } catch {
    throw new ClientFail("bad_server_response", text.slice(0, 500));
  }
}

export async function streamLines(
  server: string,
  method: string,
  pathname: string,
  timeoutMs: number,
  onLine: (value: unknown) => void,
): Promise<void> {
  const res = await doFetch(server + pathname, { method }, timeoutMs);
  if (!res.ok) {
    const text = await res.text();
    await readError(res, text);
  }
  if (!res.body) throw new ClientFail("stream_closed", "No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) onLine(JSON.parse(line));
        newlineIndex = buffer.indexOf("\n");
      }
    }
  } catch (err) {
    if (err instanceof ClientFail) throw err;
    throw new ClientFail("stream_closed", `Stream interrupted: ${(err as Error).message}`);
  }
}

export async function downloadFile(
  server: string,
  pathname: string,
  outPath: string,
  timeoutMs: number,
): Promise<number> {
  const res = await doFetch(server + pathname, { method: "GET" }, timeoutMs);
  if (!res.ok) {
    const text = await res.text();
    await readError(res, text);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, bytes);
  return bytes.length;
}

export async function uploadFile(
  server: string,
  pathname: string,
  filePath: string,
  timeoutMs: number,
): Promise<unknown> {
  if (!fs.existsSync(filePath)) {
    throw new ClientFail("invalid_argument", `Local file not found: ${filePath}`);
  }
  const bytes = fs.readFileSync(filePath);
  const form = new FormData();
  form.append("file", new Blob([bytes]), path.basename(filePath));
  const res = await doFetch(server + pathname, { method: "POST", body: form }, timeoutMs);
  const text = await res.text();
  if (!res.ok) await readError(res, text);
  try {
    return JSON.parse(text);
  } catch {
    throw new ClientFail("bad_server_response", text.slice(0, 500));
  }
}
