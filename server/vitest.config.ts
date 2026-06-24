import { defineConfig } from "vitest/config";

// Default run: fast fake-tier tests only. Real-device suites (*.real.test.ts)
// boot actual emulators/simulators and are run explicitly via the test:real:*
// scripts, never by default.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "test/**/*.real.test.ts"],
  },
});
