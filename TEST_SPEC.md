# agent-toolbox — test specification

Every test drives the system the same way: **the `toolbox` client invoked against a
running server**, asserting on the JSON the client emits. No test reaches into
server internals. This keeps the test surface identical to the real agent surface.

## Backends

The server is started per-test with one of:

- **`fake`** — `FakeDriver`. Booting/cloning are in-memory and instant. Runs on any
  OS, in CI. Covers all queue / session / cleanup / error logic. The bulk of tests.
- **`real`** — `AndroidDriver` / `IosDriver`. Mac + SDK required. A small smoke set
  that proves the real driver honors the same contract the Fake is tested against.
- **`both`** — the driver **contract suite**: the identical test runs against `fake`
  and `real`. If both pass, Fake-based results are trustworthy.

Tag on each case: `[fake]`, `[real]`, `[both]`.

## Harness conventions

- Each test starts a fresh server with an explicit config: per-platform `max`,
  template list, cache dir (temp), and a **short TTL** (e.g. 500 ms) for reaper
  tests. Server torn down after.
- Streaming commands (`session wait`, `device logs`, `build logs`) emit NDJSON; the
  harness reads line-by-line with a timeout.
- A test-only **clock control** endpoint (`POST /_test/advance-clock { ms }`, enabled
  only when `TOOLBOX_TEST_MODE=1`) drives TTL/reaper cases deterministically without
  real sleeps. Real-backend TTL tests fall back to short real TTLs.
- "Fresh clone count" assertions use a test-only `GET /_test/driver-state` returning
  the driver's live instance count — to prove no leaks. Fake only.

---

## 1. health & capacity

- **H1** `[fake]` `health` → `{ ok: true, service, version }`, exit 0.
- **H2** `[fake]` client against a down server → JSON error on stderr, nonzero exit,
  error code `server_unreachable`.
- **C1** `[fake]` fresh server, `capacity` → configured `max`, `active: 0`,
  `queued: 0` for each platform.
- **C2** `[fake]` after N creates (N < max), `capacity.active == N`.
- **C3** `[fake]` android filled to max + extra creates → `android.queued > 0` while
  `ios.active/queued` unaffected (independent caps).
- **C4** `[fake]` after release, `active` drops and `queued` decrements as one
  advances.

---

## 2. templates

- **T1** `[fake]` `templates list` → array with `slug`, `platform`, `name`, `version`
  for each configured base.
- **T2** `[fake]` server configured with zero templates → `{ templates: [] }`, exit 0
  (empty, not error).
- **T3** `[both]` `templates list` matches the real tool inventory
  (`emulator -list-avds` / `simctl list -j`) for configured slugs.
- **T4** `[fake]` lease response `templateVersion` equals the template's current
  `version`.

---

## 3. session lifecycle & queue (core logic)

- **S1** `[fake]` `session create` with a free slot → `status: "active"`, unique
  `sessionId`, `template`, `templateVersion` present.
- **S2** `[fake]` create when slots full → `status: "queued"`, integer `position`.
- **S3** `[fake]` queue ordering: fill max, then create A, B, C → positions are
  sequential (A < B < C) and stable.
- **S4** `[fake]` `session wait` on an already-active session → emits the active
  event immediately, exit 0.
- **S5** `[fake]` `session wait` on a queued session blocks, emits ≥1 position event,
  then an `active` event after a slot frees; exit 0.
- **S6** `[fake]` releasing an active session advances the queue: the head queued
  session becomes `active` and that transition fires on its open `wait` stream.
- **S7** `[fake]` releasing a **queued** session removes it; later sessions' positions
  shift down by one.
- **S8** `[fake]` `session release` is idempotent: releasing twice → both return
  `{ released: true }`, exit 0.
- **S9** `[fake]` release of a never-existent ID → `{ released: true }`, exit 0
  (idempotent per spec).
- **S10** `[fake]` `session get` on active → full state; on unknown ID → error
  `session_not_found`, nonzero exit.
- **S11** `[fake]` `session list` returns all active + queued sessions with status.
- **S12** `[fake]` create with unknown template slug → error `template_not_found`.
- **S13** `[fake]` create with malformed/missing `--template` → error
  `invalid_argument`.
- **S14** `[fake]` every `sessionId` across many creates is unique.
- **S15** `[fake]` **concurrency**: 20 simultaneous creates against `max: 5` → exactly
  5 `active`, 15 `queued`, no duplicate device assignment, caps never exceeded.
- **S16** `[fake]` **race on a freeing slot**: two queued sessions, release one active
  slot → exactly one of the two becomes active, the other stays queued at position 1.
- **S17** `[fake]` churn: create→release repeated 100× → `capacity` returns to
  baseline each cycle, driver instance count returns to 0 (no leak).
- **S18** `[real]` create a real template → `active` with a working device (validated
  by a follow-up `device shell getprop`), then release.

---

## 4. TTL, heartbeat, reaping

- **R1** `[fake]` active session with no heartbeat past TTL (advance clock) → reaped:
  removed from `list`, slot freed, clone destroyed.
- **R2** `[fake]` `session heartbeat` before TTL → `expiresAt` pushed forward; session
  survives a clock advance shorter than the new TTL.
- **R3** `[fake]` any `device` call (e.g. `device shell`) counts as a heartbeat:
  session survives past the original TTL.
- **R4** `[fake]` reaping an active session **advances the queue** — head queued
  session becomes active.
- **R5** `[fake]` queued sessions also expire: an abandoned queued session past TTL is
  dropped and positions shift.
- **R6** `[fake]` `--ttl` override honored: a session created with a longer TTL
  survives a clock advance that reaps a default-TTL session.
- **R7** `[real]` short real TTL, no heartbeat → device actually shut down and removed
  (verify via `templates`/driver state that the clone is gone).

---

## 5. reset

- **RS1** `[fake]` `session reset --mode snapshot` (default) → `status: "active"`, same
  `sessionId`, `capacity` unchanged (slot retained).
- **RS2** `[both]` install-then-reset clears state: `device install`, confirm present,
  `reset --mode wipe`, confirm the app is gone.
- **RS3** `[both]` `reset --mode reboot` preserves installed state: install, reboot,
  app still present.
- **RS4** `[both]` `reset --mode snapshot` restores post-boot snapshot: a mutation
  (file/app) made after lease is gone after reset.
- **RS5** `[fake]` reset on a **queued** session → error `session_not_active`.
- **RS6** `[fake]` reset on unknown ID → error `session_not_found`.
- **RS7** `[fake]` reset with invalid `--mode` → error `invalid_argument`.
- **RS8** `[fake]` reset does not change the slot count or queue ordering.

---

## 6. device proxy

- **D1** `[both]` `device shell 'getprop ro.build.version.sdk'` (or iOS equiv) →
  `stdout` non-empty, `exitCode: 0`.
- **D2** `[fake]` `device shell` on unknown session → error `session_not_found`.
- **D3** `[fake]` `device shell` on a **queued** (not active) session → error
  `session_not_active`.
- **D4** `[fake]` `device shell` on a **released** session → error.
- **D5** `[both]` `device install <apk>` → `{ installed: true, package }`.
- **D6** `[fake]` `device install` with a missing local file → client error before any
  request, nonzero exit.
- **D7** `[fake]` `device install` of a non-package file → server error
  `install_failed`.
- **D8** `[fake]` `device forward --remote --local` → echoes the mapping.
- **D9** `[both]` `device screenshot -o file` → file written, reported `bytes > 0`.
- **D10** `[both]` `device logs` streams ≥1 NDJSON event then can be cancelled cleanly.
- **D11** `[fake]` `device input tap/swipe` → `{ ok: true }`.
- **D12** `[fake]` a `device` call refreshes the session TTL (cross-check with R3).
- **D13** `[fake]` device verb on a session whose platform doesn't support it (e.g.
  android-only `input` on iOS) → explicit `unsupported_on_platform` error, not a
  silent pass.

---

## 7. build

- **B1** `[fake]` `build create` (fresh) → `status: "running"`, `buildId`,
  `cacheHit: false`.
- **B2** `[fake]` second `build create` with same `--cache-key`, no `--force` →
  `status: "done"`, `cacheHit: true`, no rebuild performed.
- **B3** `[fake]` `build create --force` with a populated cache → `cacheHit: false`,
  rebuild runs.
- **B4** `[fake]` different `--cache-key` → independent cache, `cacheHit: false`.
- **B5** `[fake]` no `--cache-key` → uses shared cache bucket (second shared build
  hits cache).
- **B6** `[fake]` `build logs` streams `stdout` events then a terminal `exit` event
  with `exitCode`, `ok`, `durationMs`.
- **B7** `[fake]` `build artifact <id> apk -o file` → file written, `bytes > 0`,
  `name: "apk"`.
- **B8** `[fake]` `build artifact` with unknown artifact name → error
  `artifact_not_found`.
- **B9** `[fake]` `build artifact` / `build logs` for unknown `buildId` → error
  `build_not_found`.
- **B10** `[fake]` artifact request for a **failed** build → error `build_failed`.
- **B11** `[fake]` `build create` with invalid platform → error `invalid_argument`.
- **B12** `[fake]` `build create` with a non-existent `--path` → error
  `project_not_found`.
- **B13** `[real]` end-to-end: build a real fixture project → `exit 0`, download the
  apk, `bytes > 0`, and it installs onto a leased real device.

---

## 8. resource cleanup & crash recovery

- **CL1** `[fake]` `release` destroys the underlying clone (driver instance count
  decrements; cross-check S17 no-leak invariant).
- **CL2** `[fake]` reaped session (R1) destroys its clone.
- **CL3** `[real]` **startup reconciliation**: pre-create an orphan clone carrying the
  broker's tag prefix, start the server → orphan is destroyed on boot.
- **CL4** `[real]` **crash recovery**: lease real devices, `kill -9` the server,
  restart → tagged orphans reaped, `capacity.active` back to 0, no leftover clones on
  disk.
- **CL5** `[fake]` reconciliation ignores devices **not** carrying the broker tag
  (never touches the user's own AVDs/sims).
- **CL6** `[fake]` full lifecycle leaves zero residue: lease N, exercise, release N →
  driver instance count 0, cache dir contains only intended artifacts.

---

## 9. driver contract suite `[both]`

The same sequence run against `fake` and `real`; both must produce structurally
identical JSON (values differ, shapes/codes don't):

- **CT1** `templates list` → non-empty, well-formed.
- **CT2** `session create` → `active`, device reachable.
- **CT3** `device shell` round-trip → `exitCode: 0`, stdout present.
- **CT4** `device install` → `installed: true`.
- **CT5** `session reset --mode wipe` → state cleared.
- **CT6** `session release` → clone gone, slot freed.

A divergence here means the Fake has drifted from reality and Tier-1 results can no
longer be trusted.

---

## 10. client contract & errors

- **E1** `[fake]` every error path emits `{ error: { code, message } }` on **stderr**
  and exits nonzero; stdout stays empty.
- **E2** `[fake]` every success emits exactly one JSON object (or NDJSON stream) on
  **stdout** and exits 0.
- **E3** `[fake]` unknown command / unknown subcommand → error `unknown_command`.
- **E4** `[fake]` missing required positional/flag → error `invalid_argument` naming
  the missing field.
- **E5** `[fake]` `--server` flag overrides `TOOLBOX_SERVER` overrides config file
  overrides default (precedence test, point each at a distinguishable stub).
- **E6** `[fake]` malformed JSON from server → client surfaces `bad_server_response`,
  does not crash or print partial stdout.
- **E7** `[fake]` `--timeout` honored: a deliberately slow endpoint trips a client
  timeout error.
- **E8** `[fake]` streaming command interrupted mid-stream (server closes) → client
  exits nonzero with `stream_closed`, having emitted only whole NDJSON lines.

---

## Coverage matrix (what each tier guarantees)

| Concern | fake | real | both |
|---|---|---|---|
| Queue / caps / positions | ✅ (S, C) | — | — |
| TTL / reaping | ✅ (R) | smoke (R7) | — |
| Reset semantics | partial (RS1,5–8) | — | ✅ (RS2–4) |
| Device proxy shape | ✅ (D2–8,11–13) | — | ✅ (D1,5,9,10) |
| Build cache logic | ✅ (B1–12) | e2e (B13) | — |
| Cleanup / crash recovery | ✅ logic (CL1,2,5,6) | ✅ real (CL3,4) | — |
| Driver fidelity | — | — | ✅ (CT) |
| Client/JSON contract | ✅ (E) | — | — |

The `fake` column is the CI gate (runs everywhere, fast). `real`/`both` run on a Mac
runner and are the trust anchor for the Fake.
