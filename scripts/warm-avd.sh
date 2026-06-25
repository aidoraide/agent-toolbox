#!/usr/bin/env bash
# Create/refresh the `default_boot` quickboot snapshot for the broker's AVD so
# leases boot WARM (~4s) instead of cold (~30-40s). Idempotent: boots the AVD
# writable once, lets it settle, saves the snapshot, and shuts it down.
#
# This is a SPEED optimization only — leases are reliable on a cold boot too
# (the lease is gated on a settled device and the test harness retries launches).
set -euo pipefail

AVD="${1:-agtbx-android}"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
EMU="$SDK/emulator/emulator"
ADB="$SDK/platform-tools/adb"
PORT="${WARM_AVD_PORT:-5620}"
SERIAL="emulator-$PORT"

echo "[warm-avd] booting $AVD (writable, cold) to build default_boot snapshot"
nohup "$EMU" -avd "$AVD" -port "$PORT" -no-window -no-audio -no-boot-anim \
  -no-snapshot -gpu "${TOOLBOX_EMULATOR_GPU:-auto}" \
  -partition-size "${TOOLBOX_EMULATOR_PARTITION_MB:-6144}" \
  >/tmp/agtbx-warm-avd.log 2>&1 &

for _ in $(seq 1 60); do
  if [ "$("$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
    break
  fi
  sleep 3
done
echo "[warm-avd] booted; settling so the snapshot captures a ready device"
sleep 30

echo "[warm-avd] saving snapshot: default_boot"
"$ADB" -s "$SERIAL" emu avd snapshot save default_boot
sleep 5
"$ADB" -s "$SERIAL" emu kill 2>/dev/null || true
sleep 3
echo "[warm-avd] done"
