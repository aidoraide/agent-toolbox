import { execFileSync } from "node:child_process";

// Safety net: after the real suite finishes (even on failure), kill any emulator
// WE started. We match on the `-read-only` flag, which is unique to how this
// broker boots instances — the user's own manually-launched emulators don't use
// it, so they're never touched.
export default function setup(): () => void {
  return () => {
    // Android: kill any emulator we started (matched by our unique -read-only flag).
    try {
      execFileSync("pkill", ["-f", "qemu-system.*-read-only.*-avd"], { stdio: "ignore" });
    } catch {
      // pkill exits non-zero when nothing matched — that's the good case.
    }
    // iOS: shut down + delete any simulator we created (name carries our tag).
    try {
      execFileSync(
        "bash",
        [
          "-c",
          `xcrun simctl list devices | grep "agtbx-" | grep -oiE "[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}" | while read u; do xcrun simctl shutdown "$u" 2>/dev/null; xcrun simctl delete "$u" 2>/dev/null; done`,
        ],
        { stdio: "ignore" },
      );
    } catch {
      // nothing to clean
    }
  };
}
