import fs from "node:fs";
import path from "node:path";

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

// The persisted registry record for a build. Artifact bytes live alongside it on
// disk (cacheDir/builds/<buildId>/<name>); this holds everything else.
export interface BuildRecord {
  buildId: string;
  platform: Platform;
  cacheKey: string | null;
  status: "running" | "done" | "failed";
  cacheHit: boolean;
  exitCode: number | null;
  ok: boolean | null;
  durationMs: number | null;
  createdAt: string;
  // Arbitrary client-supplied tags (feature, git commit, branch, ...).
  metadata: Record<string, string>;
  artifacts: string[];
}

interface LiveBuild {
  record: BuildRecord;
  buffer: BuildLogEvent[];
  exit: BuildExitEvent | null;
  listeners: Set<(event: BuildStreamEvent) => void>;
  completion: Promise<void>;
}

export interface CreateBuildInput {
  platform: string;
  projectPath: string;
  cacheKey?: string;
  force?: boolean;
  metadata?: Record<string, string>;
}

export class BuildManager {
  private readonly records = new Map<string, BuildRecord>();
  private readonly live = new Map<string, LiveBuild>();
  // cacheId (platform:key) → buildId of the most recent successful build.
  private readonly cacheIndex = new Map<string, string>();
  private readonly buildsDir: string;
  private counter = 0;

  constructor(
    private readonly runner: BuildRunner,
    private readonly clock: Clock,
    cacheDir: string,
  ) {
    this.buildsDir = path.join(cacheDir, "builds");
    this.loadFromDisk();
  }

  create(input: CreateBuildInput): {
    buildId: string;
    status: BuildRecord["status"];
    cacheHit: boolean;
  } {
    if (input.platform !== "android" && input.platform !== "ios") {
      throw new AppError("invalid_argument", `Invalid platform: ${input.platform}`);
    }
    const platform = input.platform;
    if (!input.projectPath || !fs.existsSync(input.projectPath)) {
      throw new AppError("project_not_found", `Project path does not exist: ${input.projectPath}`);
    }

    const cacheKey = input.cacheKey ?? null;
    const cacheId = `${platform}:${cacheKey ?? "__shared__"}`;
    this.counter += 1;
    const id = `b_${this.counter}`;
    const createdAt = this.clock.toIso(this.clock.now());
    const metadata = input.metadata ?? {};

    // Cache hit: reuse a prior successful build's artifacts (copied into this
    // build's dir so each registry entry is self-contained) without rebuilding.
    const cachedId = this.cacheIndex.get(cacheId);
    if (!input.force && cachedId && this.artifactsExist(cachedId)) {
      const source = this.records.get(cachedId) as BuildRecord;
      const dir = this.buildDir(id);
      fs.mkdirSync(dir, { recursive: true });
      for (const name of source.artifacts) {
        fs.copyFileSync(path.join(this.buildDir(cachedId), name), path.join(dir, name));
      }
      const record: BuildRecord = {
        buildId: id, platform, cacheKey, status: "done", cacheHit: true,
        exitCode: 0, ok: true, durationMs: 0, createdAt, metadata,
        artifacts: [...source.artifacts],
      };
      this.persist(record);
      this.records.set(id, record);
      this.cacheIndex.set(cacheId, id);
      this.live.set(id, {
        record,
        buffer: [{ type: "stdout", data: "Cache hit — skipping build\n" }],
        exit: { type: "exit", exitCode: 0, ok: true, durationMs: 0 },
        listeners: new Set(),
        completion: Promise.resolve(),
      });
      return { buildId: id, status: "done", cacheHit: true };
    }

    const record: BuildRecord = {
      buildId: id, platform, cacheKey, status: "running", cacheHit: false,
      exitCode: null, ok: null, durationMs: null, createdAt, metadata, artifacts: [],
    };
    this.records.set(id, record);
    const build: LiveBuild = {
      record,
      buffer: [],
      exit: null,
      listeners: new Set(),
      completion: Promise.resolve(),
    };
    this.live.set(id, build);
    build.completion = this.run(build, platform, input.projectPath, cacheId);
    return { buildId: id, status: "running", cacheHit: false };
  }

  async *logs(id: string, signal: AbortSignal): AsyncIterable<BuildStreamEvent> {
    const build = this.live.get(id);
    if (!build) {
      // Completed build with logs no longer in memory (e.g. after restart).
      if (this.records.has(id)) return;
      throw new AppError("build_not_found", `Unknown build: ${id}`);
    }
    const queue = new AsyncQueue<BuildStreamEvent>();
    const listener = (event: BuildStreamEvent) => queue.push(event);
    build.listeners.add(listener);
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

  async summary(id: string): Promise<BuildRecord> {
    const live = this.live.get(id);
    if (live) await live.completion;
    const record = this.records.get(id);
    if (!record) throw new AppError("build_not_found", `Unknown build: ${id}`);
    return record;
  }

  // The registry: every build, newest first.
  list(): BuildRecord[] {
    return [...this.records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async artifact(id: string, name: string): Promise<Buffer> {
    const live = this.live.get(id);
    if (live) await live.completion;
    const record = this.records.get(id);
    if (!record) throw new AppError("build_not_found", `Unknown build: ${id}`);
    if (record.status === "failed") throw new AppError("build_failed", `Build ${id} failed`);
    const file = path.join(this.buildDir(id), name);
    if (!fs.existsSync(file)) throw new AppError("artifact_not_found", `Unknown artifact: ${name}`);
    return fs.readFileSync(file);
  }

  // --- internals ----------------------------------------------------------

  private async run(build: LiveBuild, platform: Platform, projectPath: string, cacheId: string): Promise<void> {
    const startedAt = this.clock.now();
    const emit = (event: BuildLogEvent) => {
      build.buffer.push(event);
      for (const listener of build.listeners) listener(event);
    };

    let exitCode = 0;
    let artifacts = new Map<string, Buffer>();
    try {
      const result = await this.runner.run(platform, projectPath, emit);
      exitCode = result.exitCode;
      if (exitCode === 0) artifacts = result.artifacts;
    } catch (err) {
      exitCode = 1;
      emit({ type: "stderr", data: `${(err as Error).message}\n` });
    }

    const ok = exitCode === 0;
    build.record.status = ok ? "done" : "failed";
    build.record.exitCode = exitCode;
    build.record.ok = ok;
    build.record.durationMs = this.clock.now() - startedAt;

    if (ok) {
      const dir = this.buildDir(build.record.buildId);
      fs.mkdirSync(dir, { recursive: true });
      for (const [name, bytes] of artifacts) {
        fs.writeFileSync(path.join(dir, name), bytes);
      }
      build.record.artifacts = [...artifacts.keys()];
      this.cacheIndex.set(cacheId, build.record.buildId);
    }
    this.persist(build.record);

    const exit: BuildExitEvent = { type: "exit", exitCode, ok, durationMs: build.record.durationMs };
    build.exit = exit;
    for (const listener of build.listeners) listener(exit);
  }

  private buildDir(id: string): string {
    return path.join(this.buildsDir, id);
  }

  private artifactsExist(id: string): boolean {
    const record = this.records.get(id);
    if (!record || record.status !== "done") return false;
    return record.artifacts.every((name) => fs.existsSync(path.join(this.buildDir(id), name)));
  }

  private persist(record: BuildRecord): void {
    const dir = this.buildDir(record.buildId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "record.json"), JSON.stringify(record));
  }

  private loadFromDisk(): void {
    if (!fs.existsSync(this.buildsDir)) return;
    const entries = fs.readdirSync(this.buildsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const recordPath = path.join(this.buildsDir, entry.name, "record.json");
      try {
        const record = JSON.parse(fs.readFileSync(recordPath, "utf8")) as BuildRecord;
        this.records.set(record.buildId, record);
        const n = Number(record.buildId.replace(/^b_/, ""));
        if (Number.isFinite(n)) this.counter = Math.max(this.counter, n);
        if (record.status === "done") {
          const cacheId = `${record.platform}:${record.cacheKey ?? "__shared__"}`;
          const existing = this.cacheIndex.get(cacheId);
          const existingRec = existing ? this.records.get(existing) : undefined;
          if (!existingRec || record.createdAt > existingRec.createdAt) {
            this.cacheIndex.set(cacheId, record.buildId);
          }
        }
      } catch {
        // skip unreadable record
      }
    }
  }
}
