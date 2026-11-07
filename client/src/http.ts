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

function readConfigFile(): { server?: string; token?: string } {
  try {
    const configPath = path.join(os.homedir(), ".config", "agent-toolbox", "config.json");
    return JSON.parse(fs.readFileSync(configPath, "utf8")) as { server?: string; token?: string };
  } catch {
    return {}; // no config file
  }
}

export function resolveServer(flagServer?: string): string {
  if (flagServer) return flagServer;
  if (process.env.TOOLBOX_SERVER) return process.env.TOOLBOX_SERVER;
  return readConfigFile().server || "http://localhost:4500";
}

function resolveToken(): string | undefined {
  return process.env.TOOLBOX_TOKEN || readConfigFile().token || undefined;
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

async function doFetch(url: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
  // No timeout by default — this is a local server and leases/streams are
  // legitimately long-running (a queued create can block for minutes). A timeout
  // is opt-in via --timeout for callers that want to bail early.
  const signal = timeoutMs && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  const token = resolveToken();
  const headers = { ...(init.headers as Record<string, string>), ...(token && { authorization: `Bearer ${token}` }) };
  try {
    return await fetch(url, { ...init, headers, signal });
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
  opts: { body?: unknown; timeoutMs?: number },
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
  timeoutMs: number | undefined,
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
  timeoutMs?: number,
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
  timeoutMs?: number,
): Promise<unknown> {
  return uploadForm(server, pathname, {}, { file: filePath }, timeoutMs);
}

// Multipart POST: text fields first, then one local file per field name.
export async function uploadForm(
  server: string,
  pathname: string,
  fields: Record<string, string>,
  files: Record<string, string>,
  timeoutMs?: number,
): Promise<unknown> {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  for (const [name, filePath] of Object.entries(files)) {
    if (!fs.existsSync(filePath)) {
      throw new ClientFail("invalid_argument", `Local file not found: ${filePath}`);
    }
    form.append(name, new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
  }
  const res = await doFetch(server + pathname, { method: "POST", body: form }, timeoutMs);
  const text = await res.text();
  if (!res.ok) await readError(res, text);
  try {
    return JSON.parse(text);
  } catch {
    throw new ClientFail("bad_server_response", text.slice(0, 500));
  }
}
