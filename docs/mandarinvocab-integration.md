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

### Added
- **Broker server**: `0.0.0.0:4500` on the Mac (fixed, shared). Reached from
  containers at `host.docker.internal:4500`.

### Pending (to be filled as implemented)
- `TOOLBOX_SERVER` env → container (via dev/src/compose.ts + docker-compose.yml).
- Broker per-lease adbd proxy port (`deviceAccess.connectPort`).
- toolbox client install into the container.
- Sandbox `run-android-test.ts` rewrite to the broker flow.

## Unchanged / coexisting (for now)
- mac-bridge (per-feature 132xx) — still present; broker is additive.
- `ADB_SERVER_SOCKET: tcp:host.docker.internal:5037` — existing; broker flow uses
  its own `adb connect <proxy>` instead.
- Per-feature ports: nextapp 13000, nextappTest 13100, macBridge 13200,
  emulator 5554, expo 19000 (from dev/src/shared.ts).
