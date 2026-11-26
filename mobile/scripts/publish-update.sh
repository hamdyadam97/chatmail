#!/usr/bin/env bash
# Publish a screens/logic update to the installed apps (expo-updates, channel
# "production"). Phones download it in the background and run it from the next
# launch. Only for JS/asset changes: a new native module, permission or plugin
# needs a new APK (bump expo.version in app.json -> new runtime) instead.
#
#   bash mobile/scripts/publish-update.sh "وصف التحديث"
#
# The Expo access token stays OUTSIDE the repo, never printed:
#   C:/Users/USER/android-build/signing/EXPO_TOKEN.txt   (one line)
set -euo pipefail
MSG="${1:-تحديث}"
TOKEN_FILE="${EXPO_TOKEN_FILE:-/c/Users/USER/android-build/signing/EXPO_TOKEN.txt}"
[ -f "$TOKEN_FILE" ] || { echo "missing $TOKEN_FILE (expo.dev -> Access tokens)"; exit 1; }
EXPO_TOKEN="$(tr -d '\r\n ' < "$TOKEN_FILE")"
export EXPO_TOKEN
cd "$(dirname "$0")/.."
npx --yes eas-cli@latest update --channel production --environment production --platform android --message "$MSG" --non-interactive
