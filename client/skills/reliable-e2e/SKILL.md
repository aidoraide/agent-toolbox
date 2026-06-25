---
name: reliable-e2e-setup
description: Best practices for building RELIABLE end-to-end mobile test infrastructure on top of the agent-toolbox device broker — device readiness, storage, GPU, JS-bundle warmth, launch resilience, state isolation, build reuse, diagnostics, and lifecycle. Use when designing a new e2e setup or debugging a flaky one (intermittent "app not ready" / launch timeouts / install failures / works-locally-fails-in-CI).
---

# Reliable e2e setup (with the `toolbox` client)

Hard-won, **repo-agnostic** practices for making device-based end-to-end tests
reliable — not just passing once, but passing every time, including on a cold,
slow machine. They apply to any UI test runner (Detox, Espresso, XCUITest,
Maestro, Appium) driving an app on a leased emulator/simulator.

## The one principle

**Reliability first, speed second. A flake is a race you are losing — eliminate
the race, don't try to outrun it with a bigger timeout.** Every run should start
from a *known-clean, known-ready* state, and every timed wait should be backed by
a retry so a slow-but-correct run cannot fail. Optimize for speed only *after*
the worst case (a stone-cold first boot) is green.

## Reliability checklist

1. Lease a **fresh, isolated** device per run; release it in `finally`.
2. Gate on a **settled** device, not merely "booted".
3. Give the device **enough storage** for the real app.
4. Use a **real GPU** for graphical apps.
5. **Pre-warm** the JS/asset bundle before the timed launch.
6. **Retry** the app launch — don't bet the run on one timeout window.
7. **Isolate all mutable state** (database, device) per run.
8. Reuse **one canonical build**; load per-change JS onto it instead of rebuilding.
9. Capture **diagnostics on failure** (cleared logcat + screenshot).
10. Add speed (warm snapshots, pre-booted pool) **last**, as a layer reliability
    does not depend on.

---

## 1. One fresh, isolated device per run

Shared or reused devices accumulate state (installed apps, prefs, full storage,
half-dead processes) that turns into "works on the 1st run, fails on the 5th".
Lease a disposable device, use it, release it — always in a `finally`.

```bash
SID=$(toolbox session create --template android | jq -r .sessionId)
trap 'toolbox session release "$SID" >/dev/null 2>&1' EXIT
# ... drive the device via $SID ...
```

The broker hands out a disposable clone per lease and reaps it on release, so
each run is clean by construction. Never assume the device is empty — uninstall
the app before installing if your runner doesn't.

## 2. Gate on a SETTLED device, not "booted"

The single most common device flake: treating `sys.boot_completed == 1` (Android)
/ "booted" (iOS) as "ready". That signal fires while the system is still starting
services, finishing package installs, and (on a cold boot) crashing/restarting
system apps. Install or launch a heavy app into that window and it races — the
app "isn't ready" or the install fails intermittently.

**Wait for a genuinely settled device**: boot flag **plus** a responsive package
manager **plus** a short settle. Make the extra probes *best-effort* — they must
only ever delay, never fail provisioning (a backstop retry covers the rest):

```bash
# Prefer a broker that gates the lease on readiness, so you don't hand-roll a
# boot wait: `session create` should already return a settled device.
toolbox session wait "$SID"        # block until the broker reports it ready
```

If you must probe yourself, check a real capability (e.g. the package manager
resolves a known package) and proceed anyway after a soft deadline — a readiness
probe must only delay, never wedge, provisioning.

## 3. Enough storage for the real app

Modern app + test binaries are large (hundreds of MB) and the OS needs **2–4×**
the APK/IPA size during install for extraction and ahead-of-time compilation. A
default emulator data partition — or a base image that's already near-full — fails
the install with *"not enough space"*, intermittently, depending on what else
accumulated. Symptoms masquerade as launch failures.

- Use a device template whose data partition is sized for your app (e.g. 6 GB),
  and whose userdata is **clean every boot** (an ephemeral/temp data partition),
  not a long-lived image that fills up.
- Check it once: `toolbox device shell "$SID" "df -h /data" | jq -r .stdout`
  should show plenty free *before* install.

## 4. Real GPU for graphical apps

Headless emulators often default to software rendering. That's fine for logic-only
instrumented tests, but a graphics-heavy app (React Native, Flutter, games, Compose
with heavy animation) may never finish rendering its first frame under software
GPU — so the test runner times out waiting for the app to become "ready", looking
exactly like an app crash. Boot graphical-app devices with a **host/hardware GPU**
(offscreen is fine). If you control the broker template, set this there.

## 5. Pre-warm the JS / asset bundle

For dev-client / Metro / live-reload setups, the **first** request compiles the
entire JS bundle — tens of seconds for a large app. If that cold compile happens
*inside* the launch's "ready" timeout, the launch fails even though nothing is
broken. Force and await the build **before** the timed launch:

```bash
# Ask the dev server for the platform manifest, then fetch the bundle it points
# at so the build completes before you launch the app.
curl -s -H 'expo-platform: android' "$DEV_SERVER/" \
  | jq -r .launchAsset.url | xargs curl -s -o /dev/null
```

Same idea for any "build on first request" asset pipeline: pay the cold build in
an untimed step, then launch into a warm server.

## 6. Retry the launch — don't bet on one timeout

Even with 2–5 done right, a cold device + cold server can occasionally overshoot a
*fixed* launch window. Don't let a single first-try launch fail the run: catch the
"not ready" / "failed to connect" error, terminate, wait briefly, and relaunch
into the now-warm state. Reliability should not depend on the launch happening to
fit one timeout.

```text
for attempt in 1..3:
  try: launchApp(); break
  catch: terminateApp(); sleep 10s   # next launch hits a warm server + settled device
```

The worst case costs an extra launch, not a failed run. This single pattern
absorbs most residual cold-start variance.

## 7. Isolate ALL mutable state per run

A fresh device is only half of it. Anything else a run reads or writes must be
per-run too, or runs contaminate each other and order-dependence creeps in:

- **Database**: clone a template DB per run (don't share one across runs).
- **Backend/test server**: per-run instance or per-run namespace.
- **Device-side data**: seed deterministically each run; never rely on leftovers.

Reach the device's backend through the lease, not host networking assumptions:
`toolbox device forward "$SID" --remote <devicePort> --local <hostPort>`.

## 8. Reuse one canonical build; load per-change JS onto it

Rebuilding a native binary per branch/feature is slow and a flake source. For
dev-client apps the native shell rarely changes — **build once, reuse everywhere**,
and load each change's JS bundle onto the same binary at runtime.

```bash
# Register a canonical build once (e.g. from main) ...
toolbox build import --platform android \
  --artifact apk=app-debug.apk --artifact test-apk=app-debug-androidTest.apk \
  --meta branch=main
# ... and every env pulls it instead of compiling:
ID=$(toolbox build list | jq -r '.builds[] | select(.metadata.branch=="main") | .buildId' | head -1)
toolbox build artifact "$ID" apk -o app-debug.apk
toolbox build artifact "$ID" test-apk -o app-debug-androidTest.apk
```

## 9. Capture diagnostics on failure

A device is noisy; a tail-limited log dump after a failure often misses the actual
launch window entirely. **Clear the log right before the timed section**, then on
failure dump the whole buffer plus a screenshot — that's the difference between
"the app crashed (here's the stack)" and "no idea".

```bash
toolbox device shell "$SID" "logcat -c"                          # clear before launch
# ... on failure (device shell returns JSON — take .stdout):
toolbox device shell "$SID" "logcat -d -v threadtime" | jq -r .stdout > failure.log
toolbox device screenshot "$SID" -o failure.png                  # login? red box? blank?
```

The screenshot alone resolves most "why didn't it launch" questions in seconds.

## 10. Speed comes last, as a layer

Only once the cold worst case is reliably green, add speed — and keep it strictly
optional:

- **Warm snapshots**: boot leases from a saved "booted + settled" snapshot (seconds
  vs tens of seconds). Ensure the snapshot bytes exist before serving leases; if
  they're missing, fall back to a cold boot — never make reliability depend on the
  snapshot.
- **Pre-booted pool**: keep N devices warm and hand them out instantly.
- **Parallelism**: the broker caps and queues concurrent leases; request what you
  need and let it schedule (`toolbox capacity` shows headroom).

If a speed optimization ever introduces a flake, it has failed its one job —
disable it and keep the reliable path.

---

## Putting it together (skeleton)

```bash
set -euo pipefail
SID=$(toolbox session create --template android | jq -r .sessionId)   # 1 fresh device
trap 'toolbox session release "$SID" >/dev/null 2>&1' EXIT            # released in finally

toolbox session wait "$SID"                                          # 2 settle gate (broker-gated)
toolbox device shell "$SID" "df -h /data" | jq -r .stdout            # 3 storage sanity
ID=$(toolbox build list | jq -r '.builds[]|select(.metadata.branch=="main")|.buildId' | head -1)
toolbox build artifact "$ID" apk -o app.apk                          # 8 reuse build
toolbox device install "$SID" app.apk
toolbox device forward "$SID" --remote 3001 --local 3001             # 7 reach backend
prewarm_bundle                                                        # 5 warm JS
toolbox device shell "$SID" "logcat -c"                              # 9 clean diag buffer
run_tests_with_launch_retry                                          # 6 launch retry
# on failure: dump logcat + screenshot (9)
```

Reliability is the product of all of these; skip one and the flake it prevents
comes back. Get them green on a cold boot first, then layer on speed.
