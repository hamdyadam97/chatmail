#!/usr/bin/env bash
# Build + sign the Android APK of mobile/ inside WSL (Windows hits the
# 260-character path limit in the native build). Run once: scripts/wsl-setup.sh
# Then:   wsl.exe -e bash /mnt/g/tmp/mobile/scripts/build-apk.sh
# Output: C:/Users/USER/android-build/out/correspondence-native.apk
# Bump expo.android.versionCode in app.json for every release.
# The signing key stays OUTSIDE the repo (C:/Users/USER/android-build/signing/).
set -euo pipefail
T="$HOME/corr-build"
export JAVA_HOME="$T/jdk" ANDROID_HOME="$T/sdk" PATH="$T/node/bin:$T/jdk/bin:$T/sdk/cmdline-tools/latest/bin:$PATH"
SRC=/mnt/g/tmp/mobile
APP="$T/app"
mkdir -p "$APP"
rsync -a --delete \
  --exclude node_modules --exclude .expo --exclude 'android/.cxx' --exclude 'android/app/.cxx' \
  --exclude 'android/build' --exclude 'android/app/build' --exclude 'android/.gradle' \
  --exclude 'android/local.properties' \
  "$SRC/" "$APP/"
cd "$APP"
npm ci --no-audit --no-fund --loglevel=error
[ -d android ] || CI=1 npx expo prebuild --platform android --no-install
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
chmod +x android/gradlew
cd android
grep -q "^reactNativeArchitectures=armeabi-v7a,arm64-v8a" gradle.properties || sed -i "s/^reactNativeArchitectures=.*/reactNativeArchitectures=armeabi-v7a,arm64-v8a/" gradle.properties
./gradlew assembleRelease --no-daemon -q 2>&1 | grep -vE "^w: |warning:|deprecat" | tail -25
ls -la app/build/outputs/apk/release/


# --- sign with the distributed key (same as the TWA APK: installs as an update) ---
cd "$T/app/android"
BT="$ANDROID_HOME/build-tools/$(ls "$ANDROID_HOME/build-tools" | sort -V | tail -1)"
SIGN=/mnt/c/Users/USER/android-build/signing
OUT=/mnt/c/Users/USER/android-build/out
mkdir -p "$OUT"
KS_PASS="$(sed -n '3s/^[^:]*:[[:space:]]*//p' "$SIGN/KEYSTORE-PASSWORD.txt" | tr -d '\r')"
KEY_PASS="$KS_PASS"
export KS_PASS KEY_PASS
rm -f /tmp/aligned.apk
"$BT/zipalign" -p -f 4 app/build/outputs/apk/release/app-release.apk /tmp/aligned.apk
"$BT/apksigner" sign --ks "$SIGN/corr-release.keystore" --ks-key-alias corr \
  --ks-pass env:KS_PASS --key-pass env:KEY_PASS --out "$OUT/correspondence-native.apk" /tmp/aligned.apk
"$BT/apksigner" verify --print-certs "$OUT/correspondence-native.apk" | grep -i "SHA-256" | head -1
"$ANDROID_HOME/build-tools/$(ls "$ANDROID_HOME/build-tools" | sort -V | tail -1)/aapt2" dump badging "$OUT/correspondence-native.apk" 2>/dev/null | grep -E "^package|application-label:|sdkVersion|native-code" | head -6
ls -la "$OUT/correspondence-native.apk"
echo SIGN_DONE
