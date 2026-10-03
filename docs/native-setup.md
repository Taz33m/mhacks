# Native sensors: chest iPhone + waist AirPod

Both apps send real Core Motion readings to the LIFELINE server on **8877**.
They never generate fake sensor readings. The Mac AirPods acquisition and
off-ear keepalive are incorporated directly from Kinesthetic; see
`native/PROVENANCE.md`.

## Build

From the repository root:

```sh
zsh native/macos/build.sh
zsh native/ios/build.sh
zsh native/ios/build-device.sh
```

Artifacts:

- `native/macos/build/LIFELINE Waist Motion.app`
- `native/ios/build/Build/Products/Debug-iphonesimulator/LifelinePhone.app`
- `native/ios/build-device/Build/Products/Debug-iphoneos/LifelinePhone.app`

`build-device.sh` compiles against the physical iPhone SDK without signing. Its
artifact cannot be installed on a physical phone. `build.sh` creates the
simulator artifact. Neither build script installs or launches anything.

The Mac build retains Kinesthetic's temporary VFS overlay for duplicate CLT
SwiftBridging module maps. It does not edit the toolchain. The iOS script
compiles for a generic simulator with signing disabled; it does not launch a
simulator, install an app, or demonstrate real motion.

To run on the iPhone, add your Apple ID in Xcode > Settings > Accounts and
confirm the selected team. Automatic signing can create its development
certificate/profile. Connect and
unlock the iPhone, trust this Mac, and enable Developer Mode. Then run:

```sh
zsh native/ios/install-device.sh TEAM_ID DEVICE_UDID
```

Replace both arguments with the actual 10-character team ID and physical
device UDID (`xcrun devicectl list devices`). The installer checks local signing
state and device connectivity, then builds for that device with automatic signing.
An absent certificate does not block an available device: Xcode may create it
for an already signed-in team, and the actual signing error determines failure.
The script
verifies the signature and profile/team/device/expiry, and only then calls
`devicectl` installation. It does not install an unsigned artifact or claim
success after a failed preflight.

Alternatively, open `native/ios/LifelinePhone.xcodeproj`, select the signing
team and connected iPhone, then build/run `LifelinePhone`. Minimum deployment
target: iOS 17.

If automatic signing reports `PLA Update available`, review the pending
Program License Agreement in the [Apple developer account](https://developer.apple.com/account/)
before retrying. That account restriction prevents certificate/profile creation.

## Connect

1. Run `npm run setup:local` for the local Mac setup, then open the local
   dashboard. Setup installs/privately pairs the Mac motion app. Obtain the
   persistent development pairing token through the localhost setup for the
   iPhone; no token needs to be printed in logs.
2. Open the Mac waist app, enter the host (`127.0.0.1` when the backend is on
   this Mac) and token, and press **Start motion**.
3. Enter the Mac LAN/Tailscale hostname or IP and the same token in the chest
   iPhone app; press **Start monitoring**. The field accepts a hostname/IP,
   not an entire URL. Port 8877 is fixed.
4. Keep the iPhone app foregrounded. It disables screen sleep while monitoring
   and explicitly stops when backgrounded. Check-in polling continues when a
   device has no motion support, but it emits no fabricated motion.
   Grant Microphone and Speech Recognition during setup. If either is denied,
   or on-device English recognition is unsupported, use the explicit controls.
   Enable denied permissions in Settings and stop/start monitoring to refresh.
5. With both sources mounted and stable, calibrate on the dashboard. Repeat
   after reconnecting, changing the reporting bud, or remounting.

The token is saved in each development app's own UserDefaults so setup
persists. This is development pairing, not production enrollment or secure
credential storage. It is not printed to logs. Native relay traffic is plain
HTTP/WebSocket with an explicit development ATS exemption supporting LAN and
Tailscale IP addresses. Use a trusted development connection.

## Waist setup inherited from Kinesthetic

- Turn off Automatic Ear Detection for this AirPods pair in the device's
  settings before off-ear use.
- Pair the AirPods to the Mac, mount a bud at the waist, and confirm the
  app's **Reporting AirPod** is that physical bud. Core Motion chooses the
  reporting Left/Right source; this app cannot force that choice.
- Once verified, select **Left** or **Right** in **Mounted waist bud** while
  stopped. A different reporting bud then sends no samples.
- Start explicitly enables Kinesthetic's unchanged route keeper. It holds
  AirPods as an active audio output and plays the existing quiet keepalive
  tone. Pause/quit releases the route. The retained optional speaker mirror
  uses Kinesthetic's existing combined-device name.
- Do not run the Kinesthetic motion app at the same time. Keep the pair on the
  Mac and test automatic switching, the other bud in its case, off-ear
  continuity, reconnect settling, and the actual venue range.

KeepAlive's comments report Kinesthetic measurements. We have not re-measured
them for LIFELINE, validated a five-second recovery time, or measured fall
detection accuracy.

## Contracts and behavior

- `/motion?source=chest-phone&token=…` and
  `/motion?source=waist-airpod&token=…` transmit the shared `MotionSample`.
- Quaternion order is **x,y,z,w**, rotation rate **rad/s**, gravity and user
  acceleration **g**, and `sensorTime` is the original Core Motion timestamp
  in **seconds**. Never mix linear acceleration with gravity-inclusive
  impact thresholds.
- Each connection gets a new UUID session. Sequences increase; invalid,
  non-finite, non-increasing, or delayed callbacks are discarded. A changed
  AirPod reporting source forces a new session. Outstanding sends cause
  explicitly counted skips rather than invented continuity.
- Both apps receive `clock.ping` and reply with its ID, their current session,
  and monotonic device uptime receipt/send stamps in **milliseconds**. The
  backend owns clock alignment and uncertainty.
- The Mac verifies `/health` and recent `motionSources` rather than a game
  relay's player list. The dashboard is the authority for freshness,
  calibration, alignment, and measured cadence.
- iPhone requests a 100 Hz interval; delivered/transmitted cadence needs
  measurement. It polls authenticated `/api/checkin` every second while
  monitoring and plays each current `checkinId` once per monitoring session.
  The response includes `serverTime` and responder names. A conservative local
  voice deadline is derived from server time and local request-start time.
- Explicit cancellation sends `type: cancel`, the current `incidentId`, and
  `checkinId` with bearer authentication. The server must reject stale IDs
  and phases. A failed/unknown request never locally resolves an incident.
- Provider audio must be a relative authenticated URL (normally
  `/api/audio/checkin`). If unavailable, the UI explicitly identifies native
  iPhone speech as a development fallback. The prompt is:
  “I detected a possible fall. Do you need help? You can say I need help, or
  tap I don't need help to cancel.”

## Spoken replies and responder progress

The microphone tap is absent during the prompt. Capture starts only after the
provider player or native synthesizer reports completion and a 450 ms pause.
The iPhone prefers its built-in microphone and speaker, with no Bluetooth
recording route requested, so the waist bud remains a Mac sensor. This audio
arrangement still requires physical validation.

Recognition uses Apple's `SFSpeechRecognizer` for `en-US`. It checks
`supportsOnDeviceRecognition`, recognition availability, and both permissions;
each request sets `requiresOnDeviceRecognition = true`. It has **no cloud
speech fallback**. See Apple's [support check](https://developer.apple.com/documentation/speech/sfspeechrecognizer/supportsondevicerecognition)
and [request requirement](https://developer.apple.com/documentation/speech/sfspeechrecognitionrequest/requiresondevicerecognition).

Partial words appear as “not submitted.” Only a final result posts, with bearer
authentication, to `/api/checkin/reply`:

```json
{
  "incidentId": "current incident ID",
  "checkinId": "current check-in ID",
  "transcript": "final on-device recognition result",
  "source": "ios-on-device-speech"
}
```

The server classifies the reply:

- `help_requested`: stop voice and wait for responder updates.
- `confirmation_required`: ask the wearer to tap **I DON'T NEED HELP**; voice
  has not cancelled anything.
- `unresolved`: keep the incident open, with at most one additional capture
  attempt if time remains.

There are at most two capture attempts per voice session. Each listens for at
most six seconds, followed by up to 1.3 seconds for a final result. The check-in
deadline takes precedence. Capture and pending callbacks are invalidated on a
phase/ID change, deadline, button command, or backgrounding. A lost check-in
connection suspends capture and pending replies while preserving the original
identity, attempt count, and deadline. Recovery of that same confirming
check-in resumes listening without replaying the prompt, within the original
budget. A changed check-in never resumes the old session.
Capture UUIDs, incident/check-in IDs, and monitoring epochs
reject stale callbacks. The server remains authoritative if a final reply and
an explicit button race. Failed submissions never establish safety and are
not silently retried as successful actions.

**I NEED HELP** posts the existing manual trigger command and immediately
requests help through the controller. The app shows assigned responder name,
acceptance versus departure versus arrival, the next progress deadline, and
the recorded outcome when returned by the controller.

## First physical checks

Check live traces and source identities on both devices before rehearsing a
trigger. Then validate speaker audibility while the Mac holds the AirPod,
phone-to-Mac networking, clock uncertainty, unplug/reconnect recovery,
background behavior, spoken help, safe phrases requiring the button,
ambiguous speech, permission-denial recovery, and current check-in cancellation. Sensor disconnects
must remain visible and must not resolve the incident.

## Build verification in this workspace

- Mac: `zsh native/macos/build.sh` passed; arm64 macOS 14 target, ad-hoc signed.
- iOS: `zsh native/ios/build.sh` passed with Xcode 27.0 / simulator SDK 27.0
  for arm64 and x86_64, minimum iOS 17.
- Unsigned physical target: `zsh native/ios/build-device.sh` passed for arm64
  with iPhone SDK 27.0. This is compilation, not physical installation.
- Simulator app installation/launch and initial-screen visual inspection
  passed on the simulated iPhone 18 Pro. This does not verify real motion,
  microphone capture, on-device recognition, or phone/Mac audio interaction.
- Signed physical installation passed on the iPhone 15 running iOS 26.6.2.
  Automatic signing created the development certificate/profile after the
  pending Apple agreement was accepted. Signature and profile validation
  passed before installation; the app launched on the phone. Its private
  relay address and pairing token were copied into the app's preferences and
  verified without displaying the token. Installation does not establish
  phone-to-Mac reachability or physical motion/voice behavior.
- Plists and Xcode project passed `plutil -lint`.
- `KeepAlive.swift` matches the source file byte-for-byte.
- The Mac app briefly acquired real Right AirPod samples through local setup,
  observed around 38 Hz with roughly 6 ms clock uncertainty. The stream later
  became stale/disconnected. Sustained off-ear continuity, waist mounting, and
  calibration remain unvalidated. Physical chest-phone motion, on-device voice
  recognition, and phone/Mac audio interaction remain unverified.
