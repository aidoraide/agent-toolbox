# mandarinvocab ↔ agent-toolbox integration

Living record of how the mandarinvocab dockerized dev/test envs use the
agent-toolbox broker for e2e, and **every port / connection / env change** made
to wire it up. Keep this current as the integration evolves.

## Topology

```
Mac host
  ├─ agent-toolbox broker server   0.0.0.0:4500   (ONE shared instance, driver=android)
  │     ├─ leases Android emulators (shared, capped/queued pool)
  │     └─ serves prebuilt APKs from its registry
  ├─ per-feature Metro (Expo)      127.0.0.1:19xxx
  └─ per-feature mac-bridge        127.0.0.1:132xx   (unchanged, still used for non-broker bits)

Container (per feature, via `dev <feature>`)
  └─ toolbox client ── HTTP ──> host.docker.internal:4500   (broker)
        ├─ session create  → lease emulator
        ├─ adb connect host.docker.internal:<adbProxyPort>  (broker per-lease adbd proxy, 0.0.0.0)
        ├─ build list/artifact → pull prebuilt main APK + test APK
        └─ adb reverse: Metro (EXPO_PORT) + test server (3001)
```

## Key decisions

- **Broker is a single shared instance** on `0.0.0.0:4500` — NOT per-feature (unlike
  mac-bridge). Every container points at `host.docker.internal:4500`.
- **The device pool is global** — features share the capped/queued emulator pool.
- **One prebuilt main APK serves all features.** The Expo dev-client APK loads the
  feature's JS bundle from that feature's Metro at runtime, so only JS differs —
  no per-feature APK rebuild. Sandbox e2e pulls the cached main build from the
  broker registry.
- **Container reaches the leased emulator** via a per-lease `0.0.0.0` adbd proxy
  (mirrors mandarinvocab's `manage-emulator` proxy). The container's own adb server
  connects to it — separate adb server, no same-server transport conflict.

## Changelog (ports / connections / env)

### Added (agent-toolbox repo)
- **Broker server**: `0.0.0.0:4500` on the Mac (fixed, shared). Containers reach
  it at `host.docker.internal:4500`. Started with
  `TOOLBOX_DRIVER=android TOOLBOX_HOST=0.0.0.0 TOOLBOX_PORT=4500 TOOLBOX_MAX_ANDROID=3
   TOOLBOX_TEMPLATES='[{"slug":"android","platform":"android","name":"Android","version":1,"ref":"Medium_Phone_API_36.1"}]'`.
- **Per-lease adb proxy**: AndroidDriver opens a `0.0.0.0` TCP proxy →
  `127.0.0.1:(consolePort+1)` per lease; `deviceAccess.connectPort` exposes it.
- **`build import`**: register prebuilt artifact files as a registry build (used
  to seed the cached main APK as `b_1`, `metadata.branch=main`).
- **`TOOLBOX_TEMPLATES`** env to point templates at real local AVDs.

### Added (testing-sandbox worktree — the only mandarinvocab changes)
- **Vendored client**: `nextapp/tools/toolbox.cjs` (bundled single file; container
  runs `node /app/nextapp/tools/toolbox.cjs`). No npm install / bind-mount needed.
- **`nextapp/src/scripts/detox/run-android-test.ts`** rewritten to use the broker:
  - APK: `ensureBrokerApks()` pulls the `branch=main` build from the registry if
    the worktree doesn't already have it.
  - Emulator: `brokerLease()` (`session create --template android`) → serial +
    `connectPort`. Replaces mac-bridge `manage-emulator`.
  - Metro reverse: `brokerForward(sid, 8081, EXPO_PORT)` → broker runs
    `adb reverse tcp:8081 tcp:<EXPO_PORT>` on the MAC (device:8081 → Mac Metro).
  - Container adb: `adb connect host.docker.internal:<connectPort>` from the
    container's own adb server; detox `DETOX_ADB_NAME=host.docker.internal:<connectPort>`.
  - Test-server reverse (device:3001 → container:3001) stays container-side.
  - `brokerRelease(sid)` in `finally`.
- **No env/compose change needed**: `TOOLBOX_SERVER` defaults to
  `http://host.docker.internal:4500` in the script. `host.docker.internal` already
  resolves (existing `extra_hosts`). EXPO_PORT already in container env (19011).

### Verified
- Container → broker `health`/`build list` over `host.docker.internal:4500`. ✓
- Broker lease boots emulator; container adb reaches it via the proxy. ✓
- Full e2e provisioning chain (lease → forward → adb connect → db → detox prepare). ✓

### Gotchas found while wiring the real app
- **Emulator GPU**: the broker booted with `-gpu swiftshader_indirect` (software).
  Fine for headless instrumented unit tests, but the real React Native / Expo app
  never renders / its bridge never becomes "ready" under software GPU → detox
  `device.launchApp()` times out ("can't connect to the test app"). Fixed: boot
  with `-gpu auto` (host Metal, offscreen) — matches `manage-emulator`. Override
  via `TOOLBOX_EMULATOR_GPU`.
- Template must point at a real local AVD (`Medium_Phone_API_36.1`); both it and
  the mandarinvocab feature AVDs are API 36.1 `google_apis_playstore`.
- The dev-client loads JS from `10.0.2.2:<EXPO_PORT>` directly (Mac Metro), set
  via `seedReactNativeDevServerHost()`'s `debug_http_host` pref — so the broker's
  8081 `device forward` is belt-and-suspenders, not the primary path.

## Phase 4 — every `dev <feature>` works out of the box

Once two things are true, **every** `dev <feature>` env gets working broker e2e
with zero per-feature setup (the rewritten `run-android-test.ts` defaults
`TOOLBOX_SERVER` to `host.docker.internal:4500` and uses the vendored client):

1. **Broker always running + main build seeded** — DONE (in this repo):
   - `scripts/broker.sh` starts the broker (0.0.0.0:4500, android, max 3) and
     seeds the cached main APK into the registry once (idempotent; registry
     persists to disk).
   - `scripts/com.agenttoolbox.broker.plist` — launchd agent to keep it alive at
     login. Install:
     ```
     cp scripts/com.agenttoolbox.broker.plist ~/Library/LaunchAgents/
     launchctl load ~/Library/LaunchAgents/com.agenttoolbox.broker.plist
     ```

2. **The e2e changes live in `main`** — NEEDS YOU (I'm scoped to the worktree +
   this repo, can't touch `~/code/mandarinvocab`):
   - Merge the `testing-sandbox` branch's two files to main:
     `nextapp/src/scripts/detox/run-android-test.ts` (broker flow) and
     `nextapp/tools/toolbox.cjs` (vendored client).
   - After that, every `dev <feature>` worktree branches from main → inherits
     them → e2e runs on the broker, reusing the cached main build (the Expo
     dev-client just loads each feature's JS bundle from its own Metro).
   - Nothing else per-feature: no compose/env/port changes (the broker URL is a
     fixed default; `host.docker.internal` + `EXPO_PORT` already exist per env).

   Optional polish for main (your call): keep `toolbox.cjs` fresh by building the
   client (`agent-toolbox/client && npm run build`) and copying `dist/index.cjs`
   into `nextapp/tools/toolbox.cjs` when the client changes.

## Unchanged / coexisting
- mac-bridge (per-feature 132xx) — still present; broker path no longer calls it.
- The broker's `connectPort` proxy replaces `manage-emulator`'s `+10001` proxy.
- Per-feature ports: nextapp 13000, nextappTest 13100, macBridge 13200,
  emulator 5554, expo 19000 (dev/src/shared.ts) — untouched.
