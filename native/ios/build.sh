#!/bin/zsh
set -eu
cd "$(dirname "$0")"
# Compilation only: no simulator/device is booted and no app is installed.
xcodebuild -project LifelinePhone.xcodeproj -scheme LifelinePhone \
  -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build CODE_SIGNING_ALLOWED=NO build
print -- 'Built native/ios/build/Build/Products/Debug-iphonesimulator/LifelinePhone.app'
