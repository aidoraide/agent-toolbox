# Build samples

Real, known-good open-source apps used to validate the build runners
(`server/src/builds-real.ts`) end to end. The clones themselves are gitignored
(they're large third-party trees with build caches) — run `./fetch.sh` to
populate them.

| Platform | App | Path | Toolchain (verified) |
|---|---|---|---|
| Android | [android/testing-samples](https://github.com/android/testing-samples) → AndroidJunitRunnerSample | `android/testing-samples/runner/AndroidJunitRunnerSample` | Gradle 8.7, AGP 8.5, JDK 17, plain AndroidJUnitRunner, on-device instrumented unit tests (run clean on API 36) |
| iOS | [twostraws/simple-swiftui](https://github.com/twostraws/simple-swiftui) → SimpleScores | `ios/simple-swiftui/SimpleScores` | Xcode 26, iphonesimulator, unsigned; has an XCTest target (`SimpleScoresTests`) that runs via `xcodebuild test` |

Both build cleanly from a fresh clone. The Android app uses a plain
`AndroidJUnitRunner` with non-UI instrumented tests (`CalculatorTest`) so they
run under raw `am instrument` without Hilt or Espresso-input incompatibilities.

## Fetch

```bash
./fetch.sh
```

## Build through the broker

```bash
# start a server that uses the real build runner (any non-fake driver)
TOOLBOX_DRIVER=android npm --prefix ../server start &

# android → real APK
(cd android/architecture-samples && zip -qry /tmp/android-sample.zip . -x '*/build/*')
toolbox build upload --platform android --source /tmp/android-sample.zip
# ios → zipped .app
(cd ios/simple-swiftui/SimpleToDo && zip -qry /tmp/ios-sample.zip .)
toolbox build upload --platform ios --source /tmp/ios-sample.zip
```

Build logs stream to stderr; the result JSON (buildId, status, artifacts) prints
to stdout. Pull artifacts with `toolbox build artifact <id> <name> -o <file>`
(`apk`/`test-apk` for Android, `app` for iOS).
