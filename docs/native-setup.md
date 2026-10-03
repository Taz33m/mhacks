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
```

Artifacts:

- `native/macos/build/LIFELINE Waist Motion.app`
- `native/ios/build/Build/Products/Debug-iphonesimulator/LifelinePhone.app`

The Mac build retains Kinesthetic's temporary VFS overlay for duplicate CLT
SwiftBridging module maps. It does not edit the toolchain. The iOS script
compiles for a generic simulator with signing disabled; it does not launch a
simulator, install an app, or demonstrate real motion.

To run on the iPhone, open `native/ios/LifelinePhone.xcodeproj`, select an
available signing team and the connected iPhone, then build/run the
`LifelinePhone` scheme. The device build and installation need that signing
setup. Minimum deployment target: iOS 17.

## Connect

1. Start the backend and open its local dashboard on the Mac. Obtain the
   persistent development pairing token through its localhost setup.
2. Open the Mac waist app, enter the host (`127.0.0.1` when the backend is on
   this Mac) and token, and press **Start motion**.
3. Enter the Mac LAN/Tailscale hostname or IP and the same token in the chest
   iPhone app; press **Start monitoring**. The field accepts a hostname/IP,
   not an entire URL. Port 8877 is fixed.
4. Keep the iPhone app foregrounded. It disables screen sleep while monitoring
   and explicitly stops when backgrounded. Check-in polling continues when a
   device has no motion support, but it emits no fabricated motion.
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
  monitoring and plays each current `checkinId` once.
- Explicit cancellation sends `type: cancel`, the current `incidentId`, and
  `checkinId` with bearer authentication. The server must reject stale IDs
  and phases. A failed/unknown request never locally resolves an incident.
- Provider audio must be a relative authenticated URL (normally
  `/api/audio/checkin`). If unavailable, the UI explicitly identifies native
  iPhone speech as a development fallback. This slice does not record or
  classify spoken replies. Cancellation requires the explicit control.

## First physical checks

Check live traces and source identities on both devices before rehearsing a
trigger. Then validate speaker audibility while the Mac holds the AirPod,
phone-to-Mac networking, clock uncertainty, unplug/reconnect recovery,
background behavior, and current check-in cancellation. Sensor disconnects
must remain visible and must not resolve the incident.

## Build verification in this workspace

- Mac: `zsh native/macos/build.sh` passed; arm64 macOS 14 target, ad-hoc signed.
- iOS: `zsh native/ios/build.sh` passed with Xcode 27.0 / simulator SDK 27.0
  for arm64 and x86_64, minimum iOS 17. No signing or installation performed.
- Plists and Xcode project passed `plutil -lint`.
- `KeepAlive.swift` matches the source file byte-for-byte.
- No native apps were launched and no physical sensors/audio were tested.
