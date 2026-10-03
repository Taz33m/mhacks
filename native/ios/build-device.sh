#!/bin/zsh
set -eu
cd "$(dirname "$0")"
# Compile against the physical iPhone SDK only. This does not install or sign.
xcodebuild -project LifelinePhone.xcodeproj -scheme LifelinePhone \
  -configuration Debug -sdk iphoneos -destination 'generic/platform=iOS' \
  -derivedDataPath build-device CODE_SIGNING_ALLOWED=NO build
print -- 'Compiled native/ios/build-device/Build/Products/Debug-iphoneos/LifelinePhone.app'
print -- 'Unsigned compilation artifact: cannot install on an iPhone. Use install-device.sh with a signing team and connected device.'
