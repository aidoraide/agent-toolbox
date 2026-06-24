import fs from "node:fs";

import type { Clock } from "./clock";
import { AppError } from "./errors";
import type { Platform } from "./drivers/driver";
import { AsyncQueue } from "./util/async-queue";

export interface BuildLogEvent {
  type: "stdout" | "stderr";
  data: string;
}

export interface BuildExitEvent {
  type: "exit";
  exitCode: number;
  ok: boolean;
  durationMs: number;
}

export type BuildStreamEvent = BuildLogEvent | BuildExitEvent;

// Pluggable build backend. FakeBuildRunner is used everywhere except the real
// Gradle/xcodebuild drivers.
export interface BuildRunner {
  run(
    platform: Platform,
    projectPath: string,
    emit: (event: BuildLogEvent) => void,
  ): Promise<{ exitCode: number; artifacts: Map<string, Buffer> }>;
}

const ARTIFACT_NAMES: Record<Platform, string[]> = {
  android: ["apk", "test-apk"],
  ios: ["app", "ipa"],
};

export class FakeBuildRunner implements BuildRunner {
  async run(
    platform: Platform,
    projectPath: string,
    emit: (event: BuildLogEvent) => void,
  ): Promise<{ exitCode: number; artifacts: Map<string, Buffer> }> {
    emit({ type: "stdout", data: `Building ${platform} project at ${projectPath}\n` });

    // Deterministic failure hook for tests: a marker file fails the build.
    if (fs.existsSync(`${projectPath}/fail.marker`)) {
      emit({ type: "stderr", data: "Build failed: fail.marker present\n" });
      return { exitCode: 1, artifacts: new Map() };
    }

    const artifacts = new Map<string, Buffer>();
    for (const name of ARTIFACT_NAMES[platform]) {
      emit({ type: "stdout", data: `Packaging artifact: ${name}\n` });
      artifacts.set(name, Buffer.from(`fake-${platform}-${name}-artifact`));
    }
    emit({ type: "stdout", data: "Build succeeded\n" });
    return { exitCode: 0, artifacts };
  }
}

interface Build {
  id: string;
  platform: Platform;
  cacheId: string;
  status: "running" | "done" | "failed";
  cacheHit: boolean;
  buffer: BuildLogEvent[];
  exit: BuildExitEvent | null;
  artifacts: Map<string, Buffer>;
  listeners: Set<(event: BuildStreamEvent) => void>;
  completion: Promise<void>;
}

export interface CreateBuildInput {
  platform: string;
  projectPath: string;
  cacheKey?: string;
  force?: boolean;
}

export class BuildManager {
  private readonly builds = new Map<string, Build>();
  private readonly cache = new Map<string, Map<string, Buffer>>();
  private counter = 0;

  constructor(
    private readonly runner: BuildRunner,
    private readonly clock: Clock,
  ) {}

  create(input: CreateBuildInput): {
    buildId: string;
    status: Build["status"];
    cacheHit: boolean;
  } {
    if (input.platform !== "android" && input.platform !== "ios") {
      throw new AppError("invalid_argument", `Invalid platform: ${input.platform}`);
    }
    const platform = input.platform;
    if (!input.projectPath || !fs.existsSync(input.projectPath)) {
      throw new AppError(
        "project_not_found",
        `Project path does not exist: ${input.projectPath}`,
      );
    }

    const cacheId = `${platform}:${input.cacheKey ?? "__shared__"}`;
    this.counter += 1;
    const id = `b_${this.counter}`;

    const cached = this.cache.get(cacheId);
    if (cached && !input.force) {
      const build: Build = {
        id,
        platform,
        cacheId,
        status: "done",
        cacheHit: true,
        buffer: [{ type: "stdout", data: "Cache hit — skipping build\n" }],
        exit: { type: "exit", exitCode: 0, ok: true, durationMs: 0 },
        artifacts: new Map(cached),
        listeners: new Set(),
        completion: Promise.resolve(),
      };
      this.builds.set(id, build);
      return { buildId: id, status: "done", cacheHit: true };
    }

    const build: Build = {
      id,
      platform,
      cacheId,
      status: "running",
      cacheHit: false,
      buffer: [],
      exit: null,
      artifacts: new Map(),
      listeners: new Set(),
      completion: Promise.resolve(),
    };
    this.builds.set(id, build);
    build.completion = this.run(build, platform, input.projectPath);
    return { buildId: id, status: "running", cacheHit: false };
  }

  async *logs(id: string, signal: AbortSignal): AsyncIterable<BuildStreamEvent> {
    const build = this.requireBuild(id);
    const queue = new AsyncQueue<BuildStreamEvent>();
    const listener = (event: BuildStreamEvent) => queue.push(event);
    build.listeners.add(listener);

    // Replay buffered output, then the exit event if the build already ended.
    for (const event of build.buffer) queue.push(event);
    if (build.exit) queue.push(build.exit);

    const onAbort = () => queue.close();
    signal.addEventListener("abort", onAbort);

    try {
      for await (const event of queue) {
        yield event;
        if (event.type === "exit") return;
      }
    } finally {
      build.listeners.delete(listener);
      signal.removeEventListener("abort", onAbort);
    }
  }

  async artifact(id: string, name: string): Promise<Buffer> {
    const build = this.requireBuild(id);
    await build.completion;
    if (build.status === "failed") {
      throw new AppError("build_failed", `Build ${id} failed`);
    }
    const bytes = build.artifacts.get(name);
    if (!bytes) {
      throw new AppError("artifact_not_found", `Unknown artifact: ${name}`);
    }
    return bytes;
  }

  private async run(
    build: Build,
    platform: Platform,
    projectPath: string,
  ): Promise<void> {
    const startedAt = this.clock.now();
    const emit = (event: BuildLogEvent) => {
      build.buffer.push(event);
      for (const listener of build.listeners) listener(event);
    };

    let exitCode = 0;
    try {
      const result = await this.runner.run(platform, projectPath, emit);
      exitCode = result.exitCode;
      if (exitCode === 0) {
        build.artifacts = result.artifacts;
        this.cache.set(build.cacheId, new Map(result.artifacts));
      }
    } catch (err) {
      exitCode = 1;
      emit({ type: "stderr", data: `${(err as Error).message}\n` });
    }

    build.status = exitCode === 0 ? "done" : "failed";
    const exit: BuildExitEvent = {
      type: "exit",
      exitCode,
      ok: exitCode === 0,
      durationMs: this.clock.now() - startedAt,
    };
    build.exit = exit;
    for (const listener of build.listeners) listener(exit);
  }

  private requireBuild(id: string): Build {
    const build = this.builds.get(id);
    if (!build) {
      throw new AppError("build_not_found", `Unknown build: ${id}`);
    }
    return build;
  }
}
