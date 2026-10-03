#!/bin/zsh
set -eu
cd "$(dirname "$0")"
swift_exe="$(xcrun --find swiftc)"
sdk_path="$(xcrun --sdk macosx --show-sdk-path)"
build_arch="$(uname -m)"
case "$build_arch" in
  arm64|x86_64) ;;
  *) print -u2 -- "Unsupported Mac architecture: $build_arch"; exit 1 ;;
esac

build_tmp="$(mktemp -d "${TMPDIR:-/tmp}/lifeline-swift.XXXXXX")"
trap 'rm -rf -- "$build_tmp"' EXIT
compiler_flags=()
old_map=/Library/Developer/CommandLineTools/usr/include/swift/module.modulemap
current_map=/Library/Developer/CommandLineTools/usr/include/swift/bridging.modulemap
# Some CLT installs retain two SwiftBridging definitions. Apply the workaround
# only when both definitions are present; leave installed toolchain files intact.
if [[ -f "$old_map" && -f "$current_map" ]] && \
   /usr/bin/grep -q 'module SwiftBridging' "$old_map" && \
   /usr/bin/grep -q 'module SwiftBridging' "$current_map"; then
  python_exe="$(command -v python3)"
  "$python_exe" - "$build_tmp" "$old_map" <<'PY'
import json
import sys
from pathlib import Path
p=Path(sys.argv[1])
(p/'empty.modulemap').write_text('// Superseded by bridging.modulemap\n')
(p/'overlay.json').write_text(json.dumps({'version':0,'roots':[{'type':'file','name':sys.argv[2],'external-contents':str(p/'empty.modulemap')}]}))
PY
  compiler_flags=(-vfsoverlay "$build_tmp/overlay.json" -Xcc -ivfsoverlay -Xcc "$build_tmp/overlay.json")
fi

app_name='LIFELINE Waist Motion'
  "$swift_exe" -parse-as-library -target "$build_arch-apple-macos14.0" \
  -sdk "$sdk_path" \
  "${compiler_flags[@]}" \
  ClubMotionBridge.swift \
  KeepAlive.swift \
  -o "$build_tmp/ClubMotionBridge" \
  -framework SwiftUI -framework CoreMotion \
  -framework CoreAudio -framework AVFoundation \
  -module-cache-path "$build_tmp/module-cache"
mkdir -p "build/$app_name.app/Contents/MacOS"
cp Info.plist "build/$app_name.app/Contents/Info.plist"
cp "$build_tmp/ClubMotionBridge" "build/$app_name.app/Contents/MacOS/ClubMotionBridge"
codesign --force --deep --sign - "build/$app_name.app"
print -- "Built native/macos/build/$app_name.app"
