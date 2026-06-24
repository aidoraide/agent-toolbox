import os from "node:os";
import path from "node:path";

import type { Platform, TemplateConfig } from "./drivers/driver";

export interface ServerConfig {
  host: string;
  port: number;
  maxByPlatform: Record<Platform, number>;
  ttlMs: number;
  templates: TemplateConfig[];
  cacheDir: string;
  testMode: boolean;
  // Which device backend to use. "fake" is in-memory; "android" drives real
  // emulators via adb/emulator; "ios" drives simulators via simctl.
  driver: "fake" | "android" | "ios";
  // Marker baked into every clone we create, so reconciliation can tell our
  // orphans apart from the user's own devices.
  tagPrefix: string;
  // Test-only: pre-existing instances seeded into the driver before startup
  // reconciliation runs (drives CL3/CL5 without a real crash).
  seedInstances?: { ref: string; tagged: boolean }[];
}

export const DEFAULT_TEMPLATES: TemplateConfig[] = [
  {
    slug: "pixel6-api35",
    platform: "android",
    name: "Pixel 6 · API 35",
    version: 1,
    ref: "Pixel6_API35",
  },
  {
    slug: "iphone15-ios17",
    platform: "ios",
    name: "iPhone 15 · iOS 17.5",
    version: 1,
    ref: "iOS-17-5|iPhone 15",
  },
];

export function defaultConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: "0.0.0.0",
    port: 4500,
    maxByPlatform: { android: 5, ios: 2 },
    ttlMs: 5 * 60 * 1000,
    templates: DEFAULT_TEMPLATES,
    cacheDir: path.join(os.homedir(), ".cache", "agent-toolbox"),
    testMode: process.env.TOOLBOX_TEST_MODE === "1",
    driver: "fake",
    tagPrefix: "agtbx-",
    ...overrides,
  };
}

// Resolve config for the standalone server entrypoint (env-driven).
export function loadConfig(): ServerConfig {
  const overrides: Partial<ServerConfig> = {};
  if (process.env.TOOLBOX_HOST) overrides.host = process.env.TOOLBOX_HOST;
  if (process.env.TOOLBOX_PORT) overrides.port = Number(process.env.TOOLBOX_PORT);
  if (process.env.TOOLBOX_CACHE_DIR) overrides.cacheDir = process.env.TOOLBOX_CACHE_DIR;
  if (process.env.TOOLBOX_TTL_MS) overrides.ttlMs = Number(process.env.TOOLBOX_TTL_MS);
  if (
    process.env.TOOLBOX_DRIVER === "android" ||
    process.env.TOOLBOX_DRIVER === "fake" ||
    process.env.TOOLBOX_DRIVER === "ios"
  ) {
    overrides.driver = process.env.TOOLBOX_DRIVER;
  }
  if (process.env.TOOLBOX_MAX_ANDROID || process.env.TOOLBOX_MAX_IOS) {
    overrides.maxByPlatform = {
      android: Number(process.env.TOOLBOX_MAX_ANDROID ?? 5),
      ios: Number(process.env.TOOLBOX_MAX_IOS ?? 2),
    };
  }
  return defaultConfig(overrides);
}
