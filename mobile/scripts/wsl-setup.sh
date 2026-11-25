#!/usr/bin/env bash
# Build toolchain for the mobile app inside WSL (user home only, no sudo):
# Node 22, Microsoft OpenJDK 17, Android command-line tools. Gradle fetches
# the SDK platform / build-tools / NDK / CMake it needs on first build.
set -euo pipefail
T="$HOME/corr-build"
mkdir -p "$T" && cd "$T"

extract_zip() {  # no unzip in this distro
  python3 - "$1" "$2" <<'PY'
import sys, zipfile, os, stat
z = zipfile.ZipFile(sys.argv[1])
for info in z.infolist():
    path = z.extract(info, sys.argv[2])
    mode = (info.external_attr >> 16) & 0o777
    if mode:
        os.chmod(path, mode)
PY
}

if [ ! -x node/bin/node ]; then
  echo "== node"
  curl -fsSL https://nodejs.org/dist/v22.21.1/node-v22.21.1-linux-x64.tar.xz -o node.tar.xz
  mkdir -p node && tar -xJf node.tar.xz -C node --strip-components=1 && rm node.tar.xz
fi
if [ ! -x jdk/bin/java ]; then
  echo "== jdk"
  curl -fsSL https://aka.ms/download-jdk/microsoft-jdk-17-linux-x64.tar.gz -o jdk.tgz
  mkdir -p jdk && tar -xzf jdk.tgz -C jdk --strip-components=1 && rm jdk.tgz
fi
if [ ! -x sdk/cmdline-tools/latest/bin/sdkmanager ]; then
  echo "== android cmdline-tools"
  curl -fsSL https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip -o cmdline.zip
  rm -rf sdk/cmdline-tools && mkdir -p sdk/cmdline-tools
  extract_zip cmdline.zip sdk/cmdline-tools && mv sdk/cmdline-tools/cmdline-tools sdk/cmdline-tools/latest && rm cmdline.zip
fi
export JAVA_HOME="$T/jdk" ANDROID_HOME="$T/sdk" PATH="$T/node/bin:$T/jdk/bin:$T/sdk/cmdline-tools/latest/bin:$PATH"
yes | sdkmanager --licenses >/dev/null 2>&1 || true
node -v; java -version 2>&1 | head -1; sdkmanager --version
echo SETUP_OK
