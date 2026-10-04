# Native setup: FREE-WILi + waist AirPod + communication iPhone

The Mac waist app retains real AirPod CoreMotion acquisition and the unchanged
Kinesthetic off-ear keepalive; see `native/PROVENANCE.md`. The iPhone app is a
communication/check-in companion, not a motion or voice source. FREE-WILi
uses a separate stock-SDK acquisition bridge on **8877**. The original board's
v54 firmware supports the current DISPLAY-port path without custom firmware or
flashing. Speaker prompts, bounded microphone capture, local Whisper and
responder speech are implemented; verify their current physical behavior and
the provisional detector separately. See [FREE-WILi setup](../native/freewili/README.md).

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

1. Run `npm run setup:local`, then open the local Mac dashboard. Setup
   privately pairs the Mac waist app. Obtain the persistent development
   pairing token through localhost setup for the communication iPhone.
2. Pair the AirPods to the Mac, open the waist app, enter the host
   (`127.0.0.1` for a backend on this Mac) and token, then press **Start motion**.
3. Open **Connection and device details** in the iPhone companion, enter the
   Mac LAN/Tailscale hostname or IP and token, then press **Start communication**.
   Missing values expand this section. Enter a hostname/IP, not a URL; port
   8877 is fixed. Existing app bundle identity and pairing preferences remain.
4. Keep the companion foregrounded. It disables screen sleep while the
   communication session is active and stops communication when backgrounded.
   It has no motion, microphone, speech-recognition or audio permission path.
5. Use the **Mac dashboard** for sensor calibration. The retained CoreMotion
   calibration does not establish calibration or detection for WILi's separate
   acceleration protocol. Verify the mounted waist reporting bud before use.
6. Follow the FREE-WILi stock bridge instructions with the identified **DISPLAY**
   serial port. Synthetic protocol fixtures are offline tests, not proof of a
   connected board. The optional custom NDJSON transport is a separate path.

The companion shows current incident, assigned responder, reported progress,
and recorded outcome above connection details. Lost polling labels retained
context as last known and removes stale cancellation controls. Start/stop
communication and explicit help/cancel remain available. Stopping this session
neither stops wearable acquisition nor resolves the controller's incident.

The token is saved in each development app's own UserDefaults so setup
persists. This is development pairing, not production enrollment or secure
credential storage. It is not printed to logs. The companion uses plain HTTP
with an explicit development ATS exemption for LAN/Tailscale addresses; the
waist and board bridges use WebSocket. Use a trusted development connection.

### Wired connection for the demo

The physical iPhone can reach the Mac through its connected Apple developer
tunnel even when venue Wi-Fi requests time out. With the backend running and
the paired Debug app already installed, keep the phone unlocked and connected
by USB, then run:

```sh
npm run device:usb -- DEVICE_UDID
```

The foreground helper discovers the current tunnel and Mac IPv6 address,
starts a relay only on that interface, and launches the communication session.
Keep this process and the cable connected. Ctrl-C closes the relay; incident
updates become unavailable without changing sensor calibration or safety state.
The helper does not install the app, change saved Wi-Fi pairing, or create a background job.
Localhost pairing setup stays unavailable through the relay.

Debug builds accept `LIFELINE_RELAY_HOST` for a process-only address override
and the retained `LIFELINE_START_MONITORING=1` flag for a one-time communication
start on launch. The screen
shows an active override separately from the saved address. Ordinary launches
keep the explicit Start control; returning from background does not restart
communication. Release builds ignore these environment flags. IPv6 addresses are
accepted with or without brackets.

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
- A connected relay socket with no reporting bud or fresh samples is not a
  live waist stream. If Bluetooth says **Not Connected**, wake the charged
  pair near the Mac and reconnect that existing pair. The app keeps discovering
  it while monitoring; the pairing token need not be re-entered when it still
  matches the backend.

KeepAlive's comments report Kinesthetic measurements. We have not re-measured
them for LIFELINE, validated a five-second recovery time, or measured fall
detection accuracy.

## Contracts and behavior

- `/motion?source=waist-airpod&token=…` transmits `MotionSample`: quaternion
  **x,y,z,w**, rotation **rad/s**, gravity and user acceleration **g**, and original
  CoreMotion `sensorTime` in **seconds**. Reporting bud identity is retained.
- The waist bridge receives `clock.ping` and replies with ID/session and device
  monotonic receipt/send stamps in **milliseconds**. Reconnection starts a new
  session; missing/backpressured samples do not fabricate continuity. The Mac
  verifies `/health` and recent CoreMotion `motionSources` rather than game state.
- WILi connects separately at `/motion?source=body-wili&token=…`, with a validated
  hello, gravity-inclusive acceleration/range/saturation, clock replies, and
  explicit button events. Its acquisition/freshness appears in the separate
  dashboard card; these values alone do not establish a fall. Incident context
  selects prepared phase voice, actual local transcripts reach the bounded
  check-in policy, and authorized responder messages can reach board speech.
  Playback completion describes an elapsed clip window, not independent
  confirmation that the wearer heard it.
- The legacy chest-phone producer/detector path is gated by
  `LIFELINE_LEGACY_PHONE=1`. The current iPhone app never emits motion packets,
  plays check-in audio or submits speech, regardless of that backend setting.
- The iPhone polls authenticated `/api/checkin` every second while communication
  is active, with bounded HTTP requests and session guards against stale results.
  It shows responder names, acceptance/departure/arrival, deadlines and outcome.
  Static network diagnostics never expose authenticated URLs or pairing tokens.
- **I NEED HELP** posts the manual trigger. **I DON'T NEED HELP** posts explicit
  `cancel` with current incident/check-in IDs. Rejected or unknown results never
  locally close an incident. Calibration is controlled from the Mac dashboard.

## Messages and responder progress

Configure Photon wearer and approved responder phones separately from local
pairing. Wearer check-ins, acknowledgements and phase status use a dedicated
persisted message lane. A positive text reply asks for explicit phone
cancellation; it never cancels or extends the deadline. The companion's local
controls and Photon replies operate on the same controller incident.

Native 👍 acceptance requires the current persisted alert and approved sender
in its accepted chat/line. Constrained phrases such as `leaving` and `arrived`
need a current message target or the exact incident code; only the assigned
owner updates progress. Arrival does not resolve the incident: an on-scene
owner must record a concrete outcome. Q&A responses use native threaded replies
bound to the original source message/chat/line. Receipt and live interaction
still require phone verification; configured credentials alone prove neither.

## First physical checks

Verify the actual WILi family, firmware and serial port before calling board
samples live. Bench-check fresh acceleration, range/saturation, clock alignment,
source/session ordering and unplug behavior. Confirm the physical mounted AirPod
matches the reported bud. Board playback, microphone/STT and the provisional
fall assessment need separate physical validation; the iPhone cannot substitute
for them. Verify companion connectivity, background behavior,
current-ID help/cancel and Photon responder ownership/progress. Disconnects must
stay visible and never resolve an incident.

## Build verification in this workspace

- Mac: `zsh native/macos/build.sh` passed; arm64 macOS 14 target, ad-hoc signed.
- iOS: `zsh native/ios/build.sh` passed with Xcode 27.0 / simulator SDK 27.0
  for arm64 and x86_64, minimum iOS 17.
- The current communication-only iOS app compiled successfully after removal
  of its sensor/voice code. This build was not installed or launched on a
  physical phone; earlier installed phone-sensor builds do not verify it.
- Earlier unsigned/device/simulator builds and signed iPhone 15 installation
  belonged to the legacy sensor/voice app. Those results are historical, not
  proof of FREE-WILi acquisition, board audio or the current companion UI.
- Plists and Xcode project passed `plutil -lint`.
- `KeepAlive.swift` matches the source file byte-for-byte.

### Historical legacy-source connectivity

These recordings used the retired chest-phone architecture. They establish
connectivity/cadence only, not the current WILi detector or board voice loop.

- A 134-second connectivity recording captured 6,139 real Right AirPod samples
  at a mean received cadence of 45.69 Hz. The maximum received gap was 233 ms;
  this recording does not prove the detector's continuous quiet-window gate.
  The chest phone subsequently streamed alongside the AirPod over the wired
  tunnel. Placement and detector accuracy were not established by this recording.
- A subsequent complete 120-second wired dual-source recording captured
  12,019 chest samples at 100.14 Hz and 5,674 waist-source samples at 47.28 Hz.
  Maximum received gaps were 81 ms and 127 ms. Sampled alignment uncertainty
  stayed below 1 ms. Placement was unverified, sources were uncalibrated,
  and no detection or voice result is established by this connectivity trial.
