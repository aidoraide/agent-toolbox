#!/usr/bin/env bash
# Start the agent-toolbox broker for mandarinvocab e2e: a single shared instance
# on 0.0.0.0:4500, driver=android, and (once) seed the prebuilt main APK into the
# registry so every `dev <feature>` env can pull it. Foreground (for launchd).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_DIR="$ROOT/server"
CLIENT_BIN="$ROOT/client/dist/index.cjs"
PORT="${TOOLBOX_PORT:-4500}"
APKS="${MANDARINVOCAB_APK_CACHE:-$HOME/.cache/mandarinvocab/apks}"

DEFAULT_TEMPLATES='[{"slug":"android","platform":"android","name":"Android","version":1,"ref":"agtbx-android"}]'

export TOOLBOX_DRIVER=android
export TOOLBOX_HOST=0.0.0.0
export TOOLBOX_PORT="$PORT"
export TOOLBOX_MAX_ANDROID="${TOOLBOX_MAX_ANDROID:-3}"
export TOOLBOX_TEMPLATES="${TOOLBOX_TEMPLATES:-$DEFAULT_TEMPLATES}"

# Seed the branch=main APK into the registry once the server is healthy (only if
# it isn't there already). Runs in the background; the registry persists to disk.
seed_main_build() {
  for _ in $(seq 1 60); do
    curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
    sleep 1
  done
  if curl -sf "http://127.0.0.1:$PORT/builds" 2>/dev/null | grep -q '"branch":"main"'; then
    echo "[broker] main build already in registry"
    return 0
  fi
  if [ -f "$APKS/app-debug.apk" ] && [ -f "$APKS/app-debug-androidTest.apk" ]; then
    echo "[broker] seeding main APK from $APKS"
    node "$CLIENT_BIN" build import --platform android \
      --artifact "apk=$APKS/app-debug.apk" \
      --artifact "test-apk=$APKS/app-debug-androidTest.apk" \
      --meta branch=main --meta source=mandarinvocab-cache \
      --server "http://127.0.0.1:$PORT" >/dev/null 2>&1 \
      && echo "[broker] main build seeded" \
      || echo "[broker] seed failed (non-fatal)"
  else
    echo "[broker] no cached APKs at $APKS — skipping seed (build one first)"
  fi
}

seed_main_build &

cd "$SERVER_DIR"
exec npx tsx src/index.ts
