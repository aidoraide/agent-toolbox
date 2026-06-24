import { defineConfig } from "vitest/config";

// Real-device suites only. Boots actual emulators/simulators, so it runs
// single-threaded with long timeouts. Gated at runtime by RUN_REAL_ANDROID /
// RUN_REAL_IOS so the file can be present without booting anything by accident.
export default defineConfig({
  test: {
    include: ["test/**/*.real.test.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // Kills any emulator we started after the suite, even on failure.
    globalSetup: ["test/real-global.ts"],
  },
});
