# Build samples

Real, known-good open-source apps used to validate the build runners
(`server/src/builds-real.ts`) end to end. The clones themselves are gitignored
(they're large third-party trees with build caches) — run `./fetch.sh` to
populate them.

| Platform | App | Path | Toolchain (verified) |
|---|---|---|---|
| Android | [android/architecture-samples](https://github.com/android/architecture-samples) | `android/architecture-samples` | Gradle 8.11.1, AGP 8.7.3, JDK 17, compileSdk 35 (auto-downloaded) |
| iOS | [twostraws/simple-swiftui](https://github.com/twostraws/simple-swiftui) → SimpleToDo | `ios/simple-swiftui/SimpleToDo` | Xcode 26, iphonesimulator, unsigned |

Both build cleanly from a fresh clone with the installed toolchain.

## Fetch

```bash
./fetch.sh
```

## Build through the broker

```bash
# start a server that uses the real build runner (any non-fake driver)
TOOLBOX_DRIVER=android npm --prefix ../server start &

# android → real APK
toolbox build create --platform android --path "$(pwd)/android/architecture-samples"
# ios → zipped .app
toolbox build create --platform ios --path "$(pwd)/ios/simple-swiftui/SimpleToDo"
```

Build logs stream to stderr; the result JSON (buildId, status, artifacts) prints
to stdout. Pull artifacts with `toolbox build artifact <id> <name> -o <file>`
(`apk`/`test-apk` for Android, `app` for iOS).
