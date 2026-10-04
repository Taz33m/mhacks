#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/../.."
mkdir -p native/macos/build
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
xcrun swiftc -parse-as-library native/macos/route-eta.swift -o native/macos/build/route-eta -framework MapKit
print 'Apple Maps walking ETA helper built.'
