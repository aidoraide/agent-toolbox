---
name: agent-toolbox
description: Lease Android emulators / iOS simulators and build or upload apps via the agent-toolbox device broker. Use when an agent needs a virtual device to install an app, run a shell/adb command, take a screenshot, stream logs, or get an APK/.app built — all over a simple JSON CLI, no local adb/Xcode required.
---

# agent-toolbox client (`toolbox`)

One broker runs per machine and manages a capped pool of virtual devices. You
lease a disposable clone of a base template, drive it through proxied commands,
then release it. Every command prints **one JSON object** to stdout (NDJSON for
streams); errors print `{"error":{"code","message"}}` to stderr with a nonzero
exit.

> **Building reliable e2e infra on top of this?** See the companion skill
> [`skills/reliable-e2e/SKILL.md`](skills/reliable-e2e/SKILL.md) — repo-agnostic
> best practices (device readiness, storage, GPU, bundle warmth, launch retry,
> state isolation, build reuse, diagnostics) for tests that pass *every* time.

## Install

The client is a self-contained bundled CLI (`toolbox`). From the `client/` package:

```bash
npm install && npm run build   # produces dist/index.cjs (node, no tsx needed)
npm link                       # puts `toolbox` on PATH
# or install into a project:  npm install /path/to/agent-toolbox/client
# or run the bundle directly:  node dist/index.cjs <command>
```

## Setup

Point the client at the broker (default `http://localhost:4500`):

- `--server <url>` flag (highest precedence), or
- `TOOLBOX_SERVER` env var, or
- `~/.config/agent-toolbox/config.json` → `{"server":"..."}`

If the broker requires a token, set `TOOLBOX_TOKEN` (or add `"token"` to that
config file). The client sends it automatically.

## Core loop

```bash
# 1. See what base devices exist
toolbox templates list

# 2. Lease one. BLOCKS by default until the device is active (lock-acquire).
toolbox session create --template pixel6-api35
#   → {"sessionId":"s_1","status":"active","template":"pixel6-api35",
#      "adb":{"host":"127.0.0.1","port":5037,"serial":"emulator-5554"}}
#   --no-wait      → returns immediately {"status":"queued","position":2}
#   --fail-if-busy → errors with code "pool_full" instead of queuing

# 3. If you used --no-wait and got queued, block until active when you're ready
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

## Driving the device with real adb tools (Detox, Appium, Gradle, Flutter)

For anything that speaks adb, don't use the proxy verbs — attach your real
toolchain to the broker's adb server and address the device by serial:

```bash
toolbox session access s_1
#   → {"kind":"adb","host":"127.0.0.1","port":5037,"serial":"emulator-5554","connectPort":...}

export ADB_SERVER_SOCKET=tcp:127.0.0.1:5037
adb -s emulator-5554 install ./app-debug.apk
adb -s emulator-5554 reverse tcp:3001 tcp:3001     # device → your test server
npx detox test --device-name emulator-5554          # Detox/Appium/Gradle work unchanged
```

One shared adb server, many clients, routed by serial — exactly what adb is built
for. The pool cap still holds: adb can't create devices, only `session create`
can. (Maestro/dadb talks straight to the device daemon and isn't supported on a
shared device yet — that needs a future exclusive-lease mode.)

The proxy verbs (`device shell/install/screenshot/logs/...`) remain for agents
that have no local adb at all.

## Builds

Everything goes through one command. Upload source and the broker builds it, or
upload a finished app and the broker stores it. Either way you get a build ID.

```bash
# Source: zip it, upload it, get a build
git archive -o app.zip HEAD
toolbox build upload --platform android --source app.zip    # or --platform ios

# Finished app: upload it as is
toolbox build upload --platform android --artifact apk=app.apk --artifact test-apk=test.apk
toolbox build upload --platform ios --artifact app=App.tgz

# Either way: {"buildId":"b_1","status":"done","artifacts":["apk","test-apk"],...}
toolbox build artifact b_1 apk -o app.apk
```

Artifact names: `apk`, `test-apk` (android); `app`, `ipa` (ios).

With `--source`:
- The broker finds the Expo or native project in the zip. If it finds more than
  one, it asks you to pick with `--app-dir path/in/zip`.
- Expo apps get `npm ci` and `expo prebuild` first, including any parent folders
  and local `file:` dependencies with a lockfile. Keep those in the zip, and leave
  out `node_modules`.
- Every upload compiles fresh. Logs stream to stderr and the result prints to
  stdout. If the stream drops, the build keeps going: reattach with
  `toolbox build logs <id>`.
- A failed compile prints `"status":"failed"` and exits 0. Only toolbox errors
  (bad args, server unreachable) exit nonzero.

Add `--meta key=value` (repeatable) to tag a build. `toolbox build list` shows
every build, newest first, so you can reuse one instead of rebuilding.

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

`unauthorized`, `invalid_argument`, `template_not_found`, `session_not_found`,
`session_not_active`, `unsupported_on_platform`, `install_failed`,
`artifact_not_found`, `build_not_found`, `build_failed`, `project_not_found`.
Client-side: `server_unreachable`, `unknown_command`, `bad_server_response`,
`timeout`, `stream_closed`.

## Command → endpoint reference

See `SPEC.md` for the full CLI surface and the REST endpoint each command maps to.
