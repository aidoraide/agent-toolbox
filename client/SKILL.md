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
toolbox session adb s_1
#   → {"host":"127.0.0.1","port":5037,"serial":"emulator-5554"}

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

The broker builds on the Mac (Gradle / xcodebuild) so a container that can't —
especially for iOS — can delegate and pull the artifact bytes. Independent of
sessions.

**Every `build create` compiles fresh — there is no behind-the-scenes caching.**
To reuse a previous build, `build list` the registry and pick one yourself. It
runs to completion: **raw build logs stream to stderr**, the **result object
prints to stdout** — watch/keep the logs *and* capture clean JSON, no parsing
tension.

```bash
# Tag the build with anything useful; logs → stderr (live), result → stdout
RESULT=$(toolbox build create --platform android --path /repo \
  --meta feature=launcher --meta commit=$(git rev-parse --short HEAD) --meta branch=$(git branch --show-current) \
  2>build.log)
#   stdout → {"buildId":"b_1","platform":"android","status":"done","exitCode":0,"ok":true,
#             "durationMs":21204,"artifacts":["apk","test-apk"],
#             "metadata":{"feature":"launcher","commit":"a1b2c3","branch":"main"}}
BUILD_ID=$(jq -r .buildId <<<"$RESULT")

toolbox build artifact "$BUILD_ID" apk      -o app.apk     # android: apk / test-apk
toolbox build artifact "$BUILD_ID" app      -o App.zip     # ios: zipped .app (unzip → simctl install)
```

- `status` is `"done"` or `"failed"` (the build ran — `build create` exits 0; a
  *toolbox* error like bad args or unreachable server exits nonzero).
- `--meta key=value` (repeatable) tags the build; purely a label, doesn't affect
  the build.
- `toolbox build logs <id>` re-streams a build you started elsewhere (NDJSON).

### Browse the registry (reuse is your call)

The registry persists to disk (survives restarts). List everything built, newest
first, then decide if an existing build is good enough to reuse instead of
rebuilding:

```bash
toolbox build list
#   → { "builds": [ { "buildId","platform","status","createdAt","durationMs",
#         "artifacts":["apk","test-apk"],
#         "metadata":{"feature":"launcher","commit":"a1b2c3","branch":"main"} }, ... ] }
```

Pick a build (e.g. by matching `metadata.commit`) and pull its artifact with
`build artifact <buildId> <name> -o`. Artifact names: `apk`, `test-apk`
(android); `app`, `ipa` (ios).

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
