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
    emit({ type: "stdout", data: `Running ./gradlew assembleDebug in ${projectPath}\n` });
    const exitCode = await spawnStream(gradlew, ["assembleDebug", "--no-daemon"], projectPath, env, emit);

    const artifacts = new Map<string, Buffer>();
    if (exitCode === 0) {
      // Collect the app debug APK (exclude the androidTest instrumentation apk).
      const apks = walk(projectPath, (f) => /\/build\/outputs\/apk\/debug\/.*\.apk$/.test(f));
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

  private firstScheme(projectPath: string, containerArg: string, container: string): string {
    const out = execFileSync("xcodebuild", [containerArg, container, "-list", "-json"], {
      cwd: projectPath,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    const parsed = JSON.parse(out) as { project?: { schemes?: string[] }; workspace?: { schemes?: string[] } };
    const schemes = parsed.project?.schemes ?? parsed.workspace?.schemes ?? [];
    if (schemes.length === 0) throw new AppError("build_failed", "No build schemes found");
    return schemes[0] as string;
  }
}

// Dispatches to the platform-appropriate real toolchain.
export class RealBuildRunner implements BuildRunner {
  private readonly gradle = new GradleBuildRunner();
  private readonly xcode = new XcodeBuildRunner();

  async run(
    platform: Platform,
    projectPath: string,
    emit: (event: BuildLogEvent) => void,
  ): Promise<{ exitCode: number; artifacts: Map<string, Buffer> }> {
    return platform === "android"
      ? this.gradle.run(projectPath, emit)
      : this.xcode.run(projectPath, emit);
  }
}
