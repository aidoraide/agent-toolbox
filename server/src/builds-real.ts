import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AppError } from "./errors";
import type { BuildLogEvent, BuildRunner } from "./builds";
import type { Platform } from "./drivers/driver";
import { sdkRoot } from "./drivers/sdk";

// Spawn a build process and stream its stdout/stderr to `emit` line-agnostically
// (raw chunks). Resolves with the exit code.
function spawnStream(
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  emit: (event: BuildLogEvent) => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env });
    child.stdout.on("data", (c: Buffer) => emit({ type: "stdout", data: c.toString("utf8") }));
    child.stderr.on("data", (c: Buffer) => emit({ type: "stderr", data: c.toString("utf8") }));
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

// Recursively find files matching a predicate, skipping noisy dirs.
function walk(dir: string, match: (full: string) => boolean, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      walk(full, match, out);
    } else if (match(full)) {
      out.push(full);
    }
  }
  return out;
}

export class GradleBuildRunner {
  async run(
    projectPath: string,
    emit: (event: BuildLogEvent) => void,
  ): Promise<{ exitCode: number; artifacts: Map<string, Buffer> }> {
    const gradlew = path.join(projectPath, "gradlew");
    if (!fs.existsSync(gradlew)) {
      throw new AppError("project_not_found", `No gradlew wrapper in ${projectPath}`);
    }
    const env = { ...process.env, ANDROID_HOME: sdkRoot() };
    // Build the app APK and the instrumentation (androidTest) APK so the full
    // install → instrument flow works from one build.
    const tasks = ["assembleDebug", "assembleDebugAndroidTest"];
    emit({ type: "stdout", data: `Running ./gradlew ${tasks.join(" ")} in ${projectPath}\n` });
    const exitCode = await spawnStream(gradlew, [...tasks, "--no-daemon"], projectPath, env, emit);

    const artifacts = new Map<string, Buffer>();
    if (exitCode === 0) {
      // Both the app APK (.../apk/debug/) and the instrumentation APK
      // (.../apk/androidTest/debug/) live under build/outputs/apk.
      const apks = walk(projectPath, (f) => /\/build\/outputs\/apk\/.*\.apk$/.test(f));
      const appApk = apks.find((f) => !/androidTest/i.test(f)) ?? apks[0];
      if (appApk) artifacts.set("apk", fs.readFileSync(appApk));
      const testApk = apks.find((f) => /androidTest/i.test(f));
      if (testApk) artifacts.set("test-apk", fs.readFileSync(testApk));
    }
    return { exitCode, artifacts };
  }
}

export class XcodeBuildRunner {
  async run(
    projectPath: string,
    emit: (event: BuildLogEvent) => void,
  ): Promise<{ exitCode: number; artifacts: Map<string, Buffer> }> {
    const { containerArg, container } = this.findContainer(projectPath);
    const scheme = this.firstScheme(projectPath, containerArg, container);
    emit({ type: "stdout", data: `Building scheme '${scheme}' for iphonesimulator\n` });

    const derivedData = fs.mkdtempSync(path.join(os.tmpdir(), "agtbx-xcode-dd-"));
    const args = [
      containerArg, container,
      "-scheme", scheme,
      "-sdk", "iphonesimulator",
      "-destination", "generic/platform=iOS Simulator",
      "-derivedDataPath", derivedData,
      "CODE_SIGNING_ALLOWED=NO",
      "build",
    ];
    const exitCode = await spawnStream("xcodebuild", args, projectPath, process.env, emit);

    const artifacts = new Map<string, Buffer>();
    if (exitCode === 0) {
      const productsDir = path.join(derivedData, "Build", "Products", "Debug-iphonesimulator");
      const app = fs
        .readdirSync(productsDir)
        .map((name) => path.join(productsDir, name))
        .find((p) => p.endsWith(".app"));
      if (app) {
        // Zip the .app bundle so it streams as bytes; the iOS driver unzips it.
        const zipPath = path.join(derivedData, "app.zip");
        execFileSync("zip", ["-r", "-q", zipPath, path.basename(app)], { cwd: productsDir });
        artifacts.set("app", fs.readFileSync(zipPath));
      }
    }
    fs.rmSync(derivedData, { recursive: true, force: true });
    return { exitCode, artifacts };
  }

  private findContainer(projectPath: string): { containerArg: string; container: string } {
    const entries = fs.readdirSync(projectPath);
    const workspace = entries.find((e) => e.endsWith(".xcworkspace"));
    if (workspace) return { containerArg: "-workspace", container: workspace };
    const project = entries.find((e) => e.endsWith(".xcodeproj"));
    if (project) return { containerArg: "-project", container: project };
    throw new AppError("project_not_found", `No .xcworkspace/.xcodeproj in ${projectPath}`);
  }

  // Prefer the scheme named after the workspace/project: a CocoaPods workspace
  // also lists every pod's scheme.
  private firstScheme(projectPath: string, containerArg: string, container: string): string {
    const out = execFileSync("xcodebuild", [containerArg, container, "-list", "-json"], {
      cwd: projectPath,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    const parsed = JSON.parse(out) as { project?: { schemes?: string[] }; workspace?: { schemes?: string[] } };
    const schemes = parsed.project?.schemes ?? parsed.workspace?.schemes ?? [];
    if (schemes.length === 0) throw new AppError("build_failed", "No build schemes found");
    const named = container.replace(/\.(xcworkspace|xcodeproj)$/, "");
    return schemes.includes(named) ? named : (schemes[0] as string);
  }
}

const SKIP_DIRS = new Set([".git", "node_modules", "build", "Pods"]);
const MAX_SEARCH_DEPTH = 4;

function isExpoApp(dir: string): boolean {
  if (!["app.json", "app.config.js", "app.config.ts"].some((f) => fs.existsSync(path.join(dir, f)))) {
    return false;
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    return pkg.dependencies?.expo !== undefined;
  } catch {
    return false;
  }
}

function isNativeProject(dir: string, platform: Platform): boolean {
  if (platform === "android") return fs.existsSync(path.join(dir, "gradlew"));
  return fs.readdirSync(dir).some((e) => e.endsWith(".xcworkspace") || e.endsWith(".xcodeproj"));
}

// Find the project inside an unpacked source zip: the shallowest Expo app or
// native project. Two at the same depth is ambiguous, so ask for --app-dir.
export function findProjectDir(root: string, platform: Platform): string {
  let level = [root];
  for (let depth = 0; depth <= MAX_SEARCH_DEPTH && level.length > 0; depth += 1) {
    const matches = level.filter((dir) => isExpoApp(dir) || isNativeProject(dir, platform));
    if (matches.length === 1) return matches[0] as string;
    if (matches.length > 1) {
      const names = matches.map((m) => path.relative(root, m)).join(", ");
      throw new AppError("project_not_found", `Multiple projects found (${names}); pick one with --app-dir`);
    }
    level = level.flatMap((dir) =>
      fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
        .map((e) => path.join(dir, e.name)),
    );
  }
  throw new AppError("project_not_found", `No ${platform} project found in the zip`);
}

// Every directory an app's modules resolve from, in install order. Node also walks
// up parent directories, and local `file:` dependencies keep their own node_modules,
// so anything with a lockfile in either place gets installed before the app itself.
export function installDirs(sourceDir: string, appDir: string): string[] {
  const hasLockfile = (dir: string) => fs.existsSync(path.join(dir, "package-lock.json"));
  const parents: string[] = [];
  for (let dir = path.dirname(appDir); dir.startsWith(sourceDir); dir = path.dirname(dir)) {
    parents.unshift(dir);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const localDeps = Object.values(pkg.dependencies ?? {})
    .filter((spec) => spec.startsWith("file:"))
    .map((spec) => path.resolve(appDir, spec.slice("file:".length)));
  return [...new Set([...parents, ...localDeps])].filter(hasLockfile).concat(appDir);
}

// Expo apps have no native project until prebuild generates one.
async function prepareExpoApp(
  sourceDir: string,
  appDir: string,
  platform: Platform,
  emit: (event: BuildLogEvent) => void,
): Promise<number> {
  const env = { ...process.env, CI: "1" };
  for (const dir of installDirs(sourceDir, appDir)) {
    const verb = fs.existsSync(path.join(dir, "package-lock.json")) ? "ci" : "install";
    emit({ type: "stdout", data: `Running npm ${verb} in ${dir}\n` });
    const code = await spawnStream("npm", [verb], dir, env, emit);
    if (code !== 0) return code;
  }

  emit({ type: "stdout", data: `Running expo prebuild --platform ${platform}\n` });
  return spawnStream("npx", ["expo", "prebuild", "--platform", platform, "--clean"], appDir, env, emit);
}

// Dispatches to the platform-appropriate real toolchain.
export class RealBuildRunner implements BuildRunner {
  private readonly gradle = new GradleBuildRunner();
  private readonly xcode = new XcodeBuildRunner();

  async run(
    platform: Platform,
    sourceDir: string,
    emit: (event: BuildLogEvent) => void,
    appDir?: string,
  ): Promise<{ exitCode: number; artifacts: Map<string, Buffer> }> {
    let projectPath = appDir ? path.join(sourceDir, appDir) : findProjectDir(sourceDir, platform);
    if (!fs.existsSync(projectPath)) {
      throw new AppError("project_not_found", `--app-dir not found in the zip: ${appDir}`);
    }
    if (isExpoApp(projectPath)) {
      const exitCode = await prepareExpoApp(sourceDir, projectPath, platform, emit);
      if (exitCode !== 0) return { exitCode, artifacts: new Map() };
      projectPath = path.join(projectPath, platform);
    }
    return platform === "android"
      ? this.gradle.run(projectPath, emit)
      : this.xcode.run(projectPath, emit);
  }
}
