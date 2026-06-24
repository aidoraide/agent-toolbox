import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { aapt2Path, androidJar, buildToolPath } from "../src/drivers/sdk";

const FIXTURE_PACKAGE = "com.agenttoolbox.fixture";

// Build a minimal, real, installable APK (code-less: android:hasCode="false")
// once and cache it. Used by the real-device install tests so we have a genuine
// package to install/uninstall without depending on any prebuilt artifact.
export function buildFixtureApk(): { apkPath: string; packageName: string } {
  const dir = path.join(os.tmpdir(), "agtbx-fixture");
  const apkPath = path.join(dir, "fixture.apk");
  if (fs.existsSync(apkPath)) return { apkPath, packageName: FIXTURE_PACKAGE };

  const aapt2 = aapt2Path();
  const jar = androidJar();
  const zipalign = buildToolPath("zipalign");
  const apksigner = buildToolPath("apksigner");
  const keystore = path.join(os.homedir(), ".android", "debug.keystore");
  if (!aapt2 || !jar || !zipalign || !apksigner || !fs.existsSync(keystore)) {
    throw new Error("APK build toolchain incomplete (aapt2/android.jar/zipalign/apksigner/debug.keystore)");
  }

  fs.mkdirSync(dir, { recursive: true });
  const manifest = path.join(dir, "AndroidManifest.xml");
  fs.writeFileSync(
    manifest,
    `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="${FIXTURE_PACKAGE}"
    android:versionCode="1" android:versionName="1.0">
  <uses-sdk android:minSdkVersion="24" android:targetSdkVersion="34" />
  <application android:hasCode="false" android:label="Agtbx" />
</manifest>
`,
  );

  const unsigned = path.join(dir, "unsigned.apk");
  const aligned = path.join(dir, "aligned.apk");
  execFileSync(aapt2, ["link", "--manifest", manifest, "-I", jar, "-o", unsigned], { stdio: "pipe" });
  execFileSync(zipalign, ["-f", "-p", "4", unsigned, aligned], { stdio: "pipe" });
  execFileSync(
    apksigner,
    ["sign", "--ks", keystore, "--ks-pass", "pass:android", "--out", apkPath, aligned],
    { stdio: "pipe" },
  );

  return { apkPath, packageName: FIXTURE_PACKAGE };
}

const IOS_FIXTURE_BUNDLE = "com.agenttoolbox.iosfixture";

// Build a minimal, real, installable iOS simulator app packaged as an .ipa
// (Payload/Agtbx.app) once and cache it. The executable is a tiny clang-built
// simulator binary; no Xcode project required.
export function buildFixtureIpa(): { ipaPath: string; bundleId: string } {
  const dir = path.join(os.tmpdir(), "agtbx-ios-fixture");
  const ipaPath = path.join(dir, "fixture.ipa");
  if (fs.existsSync(ipaPath)) return { ipaPath, bundleId: IOS_FIXTURE_BUNDLE };

  fs.mkdirSync(dir, { recursive: true });
  const payload = path.join(dir, "Payload");
  const app = path.join(payload, "Agtbx.app");
  fs.mkdirSync(app, { recursive: true });

  const src = path.join(dir, "main.c");
  fs.writeFileSync(src, "int main(){return 0;}\n");
  const sdkPath = execFileSync("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-path"]).toString().trim();
  execFileSync("clang", [
    "-isysroot", sdkPath,
    "-target", "arm64-apple-ios13.0-simulator",
    src, "-o", path.join(app, "Agtbx"),
  ]);

  fs.writeFileSync(
    path.join(app, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Agtbx</string>
<key>CFBundleIdentifier</key><string>${IOS_FIXTURE_BUNDLE}</string>
<key>CFBundleName</key><string>Agtbx</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>MinimumOSVersion</key><string>13.0</string>
<key>UIDeviceFamily</key><array><integer>1</integer></array>
</dict></plist>
`,
  );

  execFileSync("zip", ["-r", "-q", ipaPath, "Payload"], { cwd: dir });
  return { ipaPath, bundleId: IOS_FIXTURE_BUNDLE };
}
