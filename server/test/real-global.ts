import { execFileSync } from "node:child_process";

// Safety net: after the real suite finishes (even on failure), kill any emulator
// WE started. We match on the `-read-only` flag, which is unique to how this
// broker boots instances — the user's own manually-launched emulators don't use
// it, so they're never touched.
export default function setup(): () => void {
  return () => {
    try {
      execFileSync("pkill", ["-f", "qemu-system.*-read-only.*-avd"], { stdio: "ignore" });
    } catch {
      // pkill exits non-zero when nothing matched — that's the good case.
    }
  };
}
