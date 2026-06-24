---
name: agent-toolbox
description: Lease Android emulators / iOS simulators and run builds via the agent-toolbox device broker. Use when an agent needs a virtual device to install an app, run a shell/adb command, take a screenshot, stream logs, or build an APK/IPA — all over a simple JSON CLI, no local adb/Xcode required.
---

# agent-toolbox client (`toolbox`)

One broker runs per machine and manages a capped pool of virtual devices. You
lease a disposable clone of a base template, drive it through proxied commands,
then release it. Every command prints **one JSON object** to stdout (NDJSON for
streams); errors print `{"error":{"code","message"}}` to stderr with a nonzero
exit.

## Setup

Point the client at the broker (default `http://localhost:4500`):

- `--server <url>` flag (highest precedence), or
- `TOOLBOX_SERVER` env var, or
- `~/.config/agent-toolbox/config.json` → `{"server":"..."}`

Run: `npx tsx <client>/src/index.ts <command>` (or the `toolbox` bin once linked).

## Core loop

```bash
# 1. See what base devices exist
toolbox templates list

# 2. Lease one (returns active, or queued if the pool is full)
toolbox session create --template pixel6-api35
#   → {"sessionId":"s_1","status":"active","template":"pixel6-api35","templateVersion":1}
#   → {"sessionId":"s_1","status":"queued","position":2}   (pool full)

# 3. If queued, block until a slot frees (streams position updates, then active)
toolbox session wait s_1

# 4. Drive the device — all proxied, no local adb/idb needed
toolbox device install s_1 ./app-debug.apk
toolbox device shell s_1 'am start -n com.example/.MainActivity'
toolbox device forward s_1 --remote 3001 --local 3001
toolbox device screenshot s_1 -o shot.png
toolbox device logs s_1                       # NDJSON stream
toolbox device input s_1 tap 100 200

# 5. Clean slate without losing your slot
toolbox session reset s_1 --mode snapshot     # snapshot|wipe|reboot

# 6. Done — free the slot for the next agent
toolbox session release s_1
```

## Builds

Independent of sessions. Artifacts stream as bytes — download then `device install`.

```bash
toolbox build create --platform android --path /repo --cache-key feat-x --force
#   → {"buildId":"b_1","status":"running","cacheHit":false}
toolbox build logs b_1                         # stream stdout + terminal exit event
toolbox build artifact b_1 apk      -o app.apk
toolbox build artifact b_1 test-apk -o test.apk
```

- `--cache-key` namespaces the artifact cache (e.g. per feature).
- `--force` rebuilds and overwrites that key's cache.
- No `--cache-key` → shared cache. Artifact names: `apk`, `test-apk` (android);
  `app`, `ipa` (ios).

## Capacity & queueing

The pool is capped per platform. `create` never fails when full — it returns
`status:"queued"` with a `position`; `session wait` blocks until you're active.

```bash
toolbox capacity
#   → {"android":{"max":5,"active":3,"queued":8},"ios":{"max":2,"active":2,"queued":1}}
```

Reset vs release:
- `session reset` — clean state, **keeps your slot** (no re-queue). Default
  `snapshot` is sub-second. Prefer this between back-to-back tests.
- `session release` — destroys the clone, **frees the slot**, advances the queue.
  Use when fully done. Idempotent.

## Sessions expire

A leased session has a TTL. Any device call refreshes it; for long idle holds,
`toolbox session heartbeat s_1`. If you vanish, the broker reaps the session and
reclaims the slot automatically.

## Error codes

`invalid_argument`, `template_not_found`, `session_not_found`,
`session_not_active`, `unsupported_on_platform`, `install_failed`,
`artifact_not_found`, `build_not_found`, `build_failed`, `project_not_found`.
Client-side: `server_unreachable`, `unknown_command`, `bad_server_response`,
`timeout`, `stream_closed`.

## Command → endpoint reference

See `SPEC.md` for the full CLI surface and the REST endpoint each command maps to.
