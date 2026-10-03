#!/bin/zsh
set -eu
cd "$(dirname "$0")"
zsh build.sh
app_name='LIFELINE Waist Motion.app'
install_dir="$HOME/Applications"
app_path="$install_dir/$app_name"
if [[ -d "$app_path" ]]; then
  bundle_id="$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$app_path/Contents/Info.plist")"
  if [[ "$bundle_id" != 'org.lifeline.waistmotion' ]]; then
    print -u2 -- "Refusing to replace an unrelated app: $app_path"
    exit 1
  fi
fi
mkdir -p "$install_dir"
/usr/bin/ditto "build/$app_name" "$app_path"
/usr/bin/codesign --verify --deep --strict "$app_path"
print -- "Installed $app_path"
if [[ "${1:-}" == '--open' ]]; then /usr/bin/open "$app_path"; fi
