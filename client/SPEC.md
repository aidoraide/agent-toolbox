# agent-toolbox client — CLI interface spec

The client (`toolbox`) is a thin, typed shell over the broker's REST API. Agents
are the primary users, so the design rules are:

- **JSON only.** Every command prints exactly one JSON object to stdout (or NDJSON
  for streams). No human-readable mode, no `--json` flag, no tables.
- **Session IDs are the only handle.** Agents never see or use adb/idb host:port.
  Device access is proxied through the server (`toolbox device ...`), so a remote
  or cloud agent needs no Android/iOS tooling and no network route to a device.
- **Errors are JSON.** Failures print `{ "error": { "code", "message" } }` to
  stderr and exit nonzero. Success exits 0.

This file doubles as the server contract: each command lists the REST endpoint it
calls.

---

## Global

```
toolbox <group> <verb> [args] [flags]
```

**Config resolution (highest first):**
- `--server <url>` flag
- `TOOLBOX_SERVER` env var
- `~/.config/agent-toolbox/config.json` → `{ "server": "http://..." }`
- default `http://localhost:4500`

**Common flags:** `--server <url>`, `--timeout <ms>`

**Output shape:**
- single result → one JSON object on stdout
- stream (logs, wait) → NDJSON, one event object per line
- error → `{ "error": { "code": "...", "message": "..." } }` on stderr, exit ≠ 0

---

## health & capacity

```
toolbox health
→ GET /health
{ "ok": true, "service": "agent-toolbox", "version": "0.1.0" }

toolbox capacity
→ GET /capacity
{
  "android": { "max": 5, "active": 3, "queued": 8 },
  "ios":     { "max": 2, "active": 2, "queued": 1 }
}
```

---

## templates — immutable base devices

```
toolbox templates list
→ GET /templates
{
  "templates": [
    { "slug": "pixel6-api35",  "platform": "android", "name": "Pixel 6 · API 35", "version": 3 },
    { "slug": "iphone15-ios17", "platform": "ios",    "name": "iPhone 15 · iOS 17.5", "version": 1 }
  ]
}
```

`version` bumps when a base is rebuilt; it is echoed in the lease so a debugging
agent can tell which base its clone came from.

---

## session — lease a disposable clone of a template

A session holds a slot. It is `queued` until a slot frees, then `active`. The
device is a fresh clone of the template; the base is never touched.

```
toolbox session create --template pixel6-api35 [--ttl <ms>]
→ POST /sessions   { template, ttl? }
# slot free:
{ "sessionId": "s_abc", "status": "active",
  "template": "pixel6-api35", "templateVersion": 3 }
# slots full:
{ "sessionId": "s_abc", "status": "queued", "position": 2 }
```

```
toolbox session wait s_abc
→ GET /sessions/s_abc/wait   (SSE → NDJSON)
{ "status": "queued", "position": 1 }
{ "status": "active", "sessionId": "s_abc", "templateVersion": 3 }
```
Blocks (streaming position updates) until the session is `active`, then exits 0.
Already-active sessions return immediately.

```
toolbox session list
→ GET /sessions
{ "sessions": [
    { "sessionId": "s_abc", "status": "active", "template": "pixel6-api35",
      "leasedAt": "...", "expiresAt": "..." }
] }

toolbox session get s_abc
→ GET /sessions/s_abc
{ "sessionId": "s_abc", "status": "active", "template": "pixel6-api35",
  "templateVersion": 3, "leasedAt": "...", "expiresAt": "..." }
```

```
toolbox session reset s_abc [--mode snapshot|wipe|reboot]
→ POST /sessions/s_abc/reset   { mode }
{ "sessionId": "s_abc", "status": "active", "mode": "snapshot" }
```
- `snapshot` (default) — restore the post-boot snapshot. Sub-second. Keeps slot.
- `wipe` — factory reset (`-wipe-data` / `simctl erase`). Keeps slot.
- `reboot` — soft restart, preserves installed state. Keeps slot.

```
toolbox session heartbeat s_abc
→ POST /sessions/s_abc/heartbeat
{ "sessionId": "s_abc", "expiresAt": "..." }
```
Pushes back the TTL. Any device call also counts as a heartbeat; this is the
explicit keepalive for long idle holds.

```
toolbox session release s_abc
→ DELETE /sessions/s_abc
{ "sessionId": "s_abc", "released": true }
```
Destroys the clone, frees the slot, advances the queue. Idempotent — releasing an
already-gone session still returns `{ "released": true }`. Cancels a queued
session too (leaves the queue).

**Full reset = release + create.** Guarantees a brand-new clone at the cost of
re-queuing. Use `reset` to stay in your slot.

---

## device — proxied access to a leased device

All device interaction is proxied: the server runs adb/idb, the agent only needs
the session ID. Works identically for local and remote/cloud agents.

```
toolbox device shell s_abc 'getprop ro.build.version.sdk'
→ POST /sessions/s_abc/shell   { command }
{ "stdout": "35\n", "stderr": "", "exitCode": 0 }

toolbox device install s_abc ./app-debug.apk
→ POST /sessions/s_abc/install   (multipart: file)
{ "installed": true, "package": "com.example.app" }

toolbox device forward s_abc --remote 3001 --local 3001
→ POST /sessions/s_abc/forward   { remote, local }
{ "remote": 3001, "local": 3001 }
# adb reverse / equivalent so the device can reach the agent's test server

toolbox device screenshot s_abc -o shot.png
→ GET /sessions/s_abc/screenshot   (image/png bytes → file)
{ "path": "shot.png", "bytes": 184213 }

toolbox device logs s_abc
→ GET /sessions/s_abc/logs   (SSE → NDJSON)
{ "ts": "...", "level": "I", "tag": "...", "message": "..." }

toolbox device input s_abc tap 100 200
toolbox device input s_abc swipe 100 200 100 600
→ POST /sessions/s_abc/input   { type, ... }
{ "ok": true }
```

> Open question: iOS install/shell map to `idb install` / `idb` subcommands rather
> than literal adb shell. The CLI surface stays identical; the server dispatches by
> the session's platform. Android-specific verbs (`input`, `forward`) may be no-ops
> or platform-mapped on iOS — flagged per-verb during implementation.

---

## build — compile and serve artifacts as bytes

Builds are independent of sessions. Artifacts are streamed as bytes, so a remote
agent downloads then `device install`s without any shared filesystem.

```
toolbox build create --platform android --path /repo/app [--cache-key feat-x] [--force]
→ POST /builds   { platform, projectPath, cacheKey?, force? }
{ "buildId": "b_123", "status": "running", "cacheHit": false }
# if cached and not --force:
{ "buildId": "b_123", "status": "done", "cacheHit": true }

toolbox build logs b_123
→ GET /builds/b_123/logs   (NDJSON)
{ "type": "stdout", "data": "..." }
{ "type": "exit", "exitCode": 0, "ok": true, "durationMs": 412000 }

toolbox build artifact b_123 apk -o app-debug.apk
→ GET /builds/b_123/artifact/apk   (octet-stream → file)
{ "path": "app-debug.apk", "bytes": 88412160, "name": "apk" }
# artifact names: apk | test-apk | app | ipa  (per platform)
```

`cacheKey` namespaces cached artifacts (e.g. per feature). `--force` rebuilds and
overwrites that key's cache. No cache key → shared cache.

---

## End-to-end agent flow

```
# 1. build (or reuse cache)
toolbox build create --platform android --path /repo --cache-key feat-x --force
toolbox build logs b_123                      # stream to completion
toolbox build artifact b_123 apk      -o app.apk
toolbox build artifact b_123 test-apk -o test.apk

# 2. lease a device (may queue)
toolbox session create --template pixel6-api35     # → s_abc, maybe queued
toolbox session wait s_abc                          # block until active

# 3. drive it — proxied, no local adb
toolbox device install s_abc ./app.apk
toolbox device forward s_abc --remote 3001 --local 3001
toolbox device shell   s_abc 'am start -n com.example/.MainActivity'
toolbox device screenshot s_abc -o shot.png

# 4. reset for the next test without losing the slot
toolbox session reset s_abc --mode snapshot

# 5. done — free the slot
toolbox session release s_abc
```

---

## REST endpoint summary

| CLI | Method | Path |
|---|---|---|
| `health` | GET | `/health` |
| `capacity` | GET | `/capacity` |
| `templates list` | GET | `/templates` |
| `session create` | POST | `/sessions` |
| `session wait` | GET (SSE) | `/sessions/:id/wait` |
| `session list` | GET | `/sessions` |
| `session get` | GET | `/sessions/:id` |
| `session reset` | POST | `/sessions/:id/reset` |
| `session heartbeat` | POST | `/sessions/:id/heartbeat` |
| `session release` | DELETE | `/sessions/:id` |
| `device shell` | POST | `/sessions/:id/shell` |
| `device install` | POST | `/sessions/:id/install` |
| `device forward` | POST | `/sessions/:id/forward` |
| `device screenshot` | GET | `/sessions/:id/screenshot` |
| `device logs` | GET (SSE) | `/sessions/:id/logs` |
| `device input` | POST | `/sessions/:id/input` |
| `build create` | POST | `/builds` |
| `build logs` | GET (NDJSON) | `/builds/:id/logs` |
| `build artifact` | GET | `/builds/:id/artifact/:name` |
