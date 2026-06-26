#!/usr/bin/env bash
# Start the agent-toolbox broker: a single shared instance on 0.0.0.0:4500,
# driver=all (Android emulators + iOS sims). Foreground (for launchd).
#
# This launcher is app-agnostic. Registering builds for a specific app — importing
# its APK/.app, tagging branch=main, choosing what "one build serves every feature"
# means — is the APP's job: it runs `toolbox build import` against this broker. The
# broker only stores builds + leases devices; it knows nothing about any app.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_DIR="$ROOT/server"
PORT="${TOOLBOX_PORT:-4500}"
BROKER_AVD="${BROKER_AVD:-agtbx-android}"
BROKER_IOS_DEVICE="${BROKER_IOS_DEVICE:-iPhone 16}"
BROKER_IOS_RUNTIME="${BROKER_IOS_RUNTIME:-iOS 18.3}"

# One broker, both platforms: an Android emulator template + an iOS simulator
# template (ref is "<deviceType>|<runtime>"). driver=all routes each lease to the
# right driver by platform.
DEFAULT_TEMPLATES="[{\"slug\":\"android\",\"platform\":\"android\",\"name\":\"Android\",\"version\":1,\"ref\":\"${BROKER_AVD}\"},{\"slug\":\"ios\",\"platform\":\"ios\",\"name\":\"iOS\",\"version\":1,\"ref\":\"${BROKER_IOS_DEVICE}|${BROKER_IOS_RUNTIME}\"}]"

export TOOLBOX_DRIVER=all
export TOOLBOX_HOST=0.0.0.0
export TOOLBOX_PORT="$PORT"
export TOOLBOX_MAX_ANDROID="${TOOLBOX_MAX_ANDROID:-3}"
export TOOLBOX_MAX_IOS="${TOOLBOX_MAX_IOS:-2}"
export TOOLBOX_TEMPLATES="${TOOLBOX_TEMPLATES:-$DEFAULT_TEMPLATES}"

# Note: the AVD and its warm-boot snapshot are provisioned by the SERVER on first
# lease (create-if-missing), so leasing always yields a warm, validated device
# with no setup script. scripts/warm-avd.sh remains as an optional manual primer.

cd "$SERVER_DIR"
exec npx tsx src/index.ts
