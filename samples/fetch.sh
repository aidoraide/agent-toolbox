#!/usr/bin/env bash
# Populate the build sample apps (gitignored; clone on demand).
set -euo pipefail
cd "$(dirname "$0")"

clone() {
  local url="$1" dest="$2"
  if [ -d "$dest/.git" ]; then
    echo "already present: $dest"
  else
    echo "cloning $url → $dest"
    git clone --depth 1 "$url" "$dest"
  fi
}

clone https://github.com/android/testing-samples  android/testing-samples
clone https://github.com/twostraws/simple-swiftui ios/simple-swiftui

echo "done."
echo "  Android build+test: android/testing-samples/runner/AndroidJunitRunnerSample"
echo "  iOS build+run:      ios/simple-swiftui/SimpleToDo"
