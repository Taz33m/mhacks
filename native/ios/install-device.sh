#!/bin/zsh
set -eu
cd "$(dirname "$0")"

if (( $# != 2 )); then
  print -u2 -- 'Usage: zsh native/ios/install-device.sh TEAM_ID DEVICE_UDID'
  print -u2 -- 'Find TEAM_ID in Xcode > Settings > Accounts. Find DEVICE_UDID with xcrun devicectl list devices.'
  exit 2
fi
lifeline_team="$1"
lifeline_device="$2"
if [[ ! "$lifeline_team" =~ '^[A-Z0-9]{10}$' || ! "$lifeline_device" =~ '^[A-Za-z0-9-]+$' ]]; then
  print -u2 -- 'Expected a 10-character Apple team ID and an alphanumeric/hyphen device UDID.'
  exit 2
fi
if ! xcodebuild -version >/dev/null 2>&1; then
  print -u2 -- 'Full Xcode must be installed and selected before a signed device build.'
  exit 2
fi
lifeline_tmp="$(mktemp -d "${TMPDIR:-/tmp}/lifeline-install.XXXXXX")"
trap 'rm -rf -- "$lifeline_tmp"' EXIT
lifeline_ready=true
security find-identity -v -p codesigning > "$lifeline_tmp/identities.txt"
if ! /usr/bin/grep -Eq '"Apple (Development|Distribution):|"iPhone (Developer|Distribution):' "$lifeline_tmp/identities.txt"; then
  print -u2 -- 'No existing valid signing identity. Automatic signing will attempt certificate/profile creation for the supplied team once the iPhone is available. If it fails, sign in under Xcode > Settings > Accounts and check that team.'
fi
xcrun devicectl list devices --json-output "$lifeline_tmp/devices.json" >/dev/null
if ! python3 - "$lifeline_tmp/devices.json" "$lifeline_device" <<'PY'
import json, sys
devices = json.load(open(sys.argv[1])).get('result', {}).get('devices', [])
for device in devices:
    hardware = device.get('hardwareProperties', {})
    properties = device.get('properties', {})
    identifiers = {device.get('identifier'), hardware.get('udid'), properties.get('hardware', {}).get('udid')}
    if sys.argv[2] not in identifiers:
        continue
    reality = properties.get('hardware', {}).get('reality', hardware.get('reality'))
    state = properties.get('connection', {}).get('state', device.get('connectionProperties', {}).get('tunnelState'))
    if reality == 'physical' and state not in {None, 'unavailable', 'disconnected'}:
        sys.exit(0)
sys.exit(1)
PY
then
  print -u2 -- 'Target physical iPhone is unavailable. Connect it, unlock it, trust this Mac, and enable Developer Mode; verify with xcrun devicectl list devices.'
  lifeline_ready=false
fi
if [[ "$lifeline_ready" != true ]]; then exit 2; fi
if ! xcrun devicectl device info details --device "$lifeline_device" --timeout 15 >/dev/null; then
  print -u2 -- 'Device connection check failed. Keep the iPhone connected and unlocked, then retry.'
  exit 2
fi

xcodebuild -project LifelinePhone.xcodeproj -scheme LifelinePhone \
  -configuration Debug -sdk iphoneos -destination "id=$lifeline_device" \
  -derivedDataPath build-signed DEVELOPMENT_TEAM="$lifeline_team" \
  CODE_SIGN_STYLE=Automatic CODE_SIGNING_ALLOWED=YES \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration build
lifeline_app="$PWD/build-signed/Build/Products/Debug-iphoneos/LifelinePhone.app"
codesign --verify --deep --strict "$lifeline_app"
if [[ ! -f "$lifeline_app/embedded.mobileprovision" ]]; then
  print -u2 -- 'Build has no embedded provisioning profile; refusing installation.'
  exit 2
fi
security cms -D -i "$lifeline_app/embedded.mobileprovision" > "$lifeline_tmp/profile.plist"
python3 - "$lifeline_tmp/profile.plist" "$lifeline_team" "$lifeline_device" <<'PY'
import datetime, plistlib, sys
profile = plistlib.load(open(sys.argv[1], 'rb'))
if sys.argv[2] not in profile.get('TeamIdentifier', []):
    sys.exit('Provisioning profile belongs to another team; refusing installation.')
if sys.argv[3] not in profile.get('ProvisionedDevices', []):
    sys.exit('Provisioning profile does not include this iPhone; refusing installation.')
expiry = profile.get('ExpirationDate')
if not expiry or expiry <= datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None):
    sys.exit('Provisioning profile expired; refusing installation.')
PY
xcrun devicectl device install app --device "$lifeline_device" "$lifeline_app" --timeout 60
print -- 'Signed app installation completed. Open LIFELINE on the iPhone and start the communication session.'
