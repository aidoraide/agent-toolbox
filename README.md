# agent-toolbox

A self-hosted device broker for AI agents. One instance runs per machine and
manages a capped, queued pool of Android emulators and iOS simulators, plus
builds — all behind a simple JSON REST API and CLI. Agents (local or remote/cloud)
lease a disposable clone of a base template, drive it through proxied commands,
and release it. No adb/Xcode required on the agent side.

## Why

Running 20+ agents that each need an emulator melts a Mac. agent-toolbox:

- **Caps concurrency** per platform and **queues** lease requests (never fails when full).
- **Isolates** each lease as a fresh clone of an immutable base template.
- **Proxies** all device access over HTTP, so cloud agents need zero local tooling.
- **Reaps** abandoned sessions (TTL) and **reconciles** orphaned clones on startup,
  so crashed runs never leak 2GB AVDs — while never touching your own devices.

## Layout

```
server/   # the broker: REST API, session queue, TTL reaper, build cache, device drivers
client/   # `toolbox` — thin JSON CLI over the API (+ SKILL.md for agents)
SPEC.md / TEST_SPEC.md   # client interface spec and the full test enumeration
```

`server/` and `client/` are independent packages, intended to eventually split
into separate repos.

## Architecture

Everything above the device backend is platform-agnostic and tested against an
in-memory `FakeDriver`. Real Android/iOS drivers implement the same `DeviceDriver`
contract:

- **Android** → owns an AVD pool, clones/boots emulators, proxies adb.
- **iOS** → `simctl clone` of base sims, proxies idb.

The session manager handles caps, the queue, the TTL reaper, and snapshot-reset;
the build manager handles cache-keyed builds and byte-streamed artifacts.

## Run the broker

```bash
cd server && npm install && npm start
# env: TOOLBOX_PORT, TOOLBOX_MAX_ANDROID, TOOLBOX_MAX_IOS, TOOLBOX_TTL_MS, TOOLBOX_CACHE_DIR
```

## Use the client

```bash
cd client && npm install
npx tsx src/index.ts capacity --server http://localhost:4500
```

See `client/SKILL.md` for the agent-facing guide and `client/SPEC.md` for the full
command surface.

## Tests

```bash
cd server && npm test       # 76 fake-tier cases (any OS, no real devices), ~2s
```

The `[real]`/`[both]` tiers in `TEST_SPEC.md` exercise actual emulators/simulators
on a Mac runner and validate the real drivers against the same contract the
FakeDriver is tested on. They land with the real driver implementations.

## Status

- ✅ Server core: driver interface, FakeDriver, session/queue/reaper, build cache, reconciliation
- ✅ Client CLI: full command surface, JSON-only output
- ✅ Fake-tier test suite (76 cases) green
- ⬜ Real Android driver (AVD pool + adb proxy)
- ⬜ Real iOS driver (simctl clone + idb proxy)
- ⬜ `[real]`/`[both]` test tiers on a Mac runner
