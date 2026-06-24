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
