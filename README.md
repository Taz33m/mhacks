# LIFELINE

MHacks 2026 — Actually Intelligent (AI). Chest iPhone + waist AirPod evidence starts a policy-controlled incident, followed through responder acceptance, progress, and a recorded outcome. The [product requirements](docs/PRD.md) define the demo scope, policy, and acceptance gates.

## Start

Requires Node 24+ and npm. Native builds require Xcode on macOS.

```sh
npm ci
npm run setup:local
npm start
```

`setup:local` creates a private `.env` for phone access on the development network, pairs the Mac app without printing its token, and builds/installs it in `~/Applications`. Existing environment settings are preserved. Connect the AirPods and start motion in the installed app.

Open **http://127.0.0.1:8877**. The dashboard shows real source availability, incident state, provider configuration, and explicitly labelled development controls. Trigger a synthetic incident or manual help, accept as a development responder, report departure/arrival, and record an outcome. These controls simulate authenticated actors for development; they are not production identity verification.

For the accelerated silence demo, use `npm run start:demo`. New check-ins use five seconds and display the acceleration from the normal configurable policy. Existing persisted deadlines stay intact. Rehearse spoken positive replies with a longer window; the phone acknowledges them without extending the deadline or cancelling the incident.

The default backend is Node + SQLite, with persisted deadlines and an action outbox. Data, recordings, tokens, and native build products are ignored by Git. No keys or approved phones are configured by default. Unconfigured providers do not claim delivery. FinchNode uses its public synthetic demo.

## Native sensors

```sh
npm run build:airpods
npm run build:ios
```

The Mac app directly incorporates Kinesthetic's acquisition and audio route keeper. `KeepAlive.swift` is unchanged; the bridge adds acceleration/gravity, LIFELINE packets, clock synchronization, and source/session validation. See [native provenance](native/PROVENANCE.md).

For the actual phone, open `native/ios/LifelinePhone.xcodeproj` in Xcode, select your signing team and connected iPhone, then build/run. The automated build checks the simulator target without launching it; it does not establish hardware sensing.

The installer can build/sign/install once the phone is connected and your Xcode account is available:

```sh
npm run install:ios -- TEAM_ID DEVICE_UDID
```

`npm run build:ios:device` checks the physical target without signing; it cannot install on a real iPhone.

For phone-to-Mac access, run with `LIFELINE_HOST=0.0.0.0 npm start` on a trusted development network. Visit the dashboard from this Mac to obtain the pairing token and LAN address, then enter them in the native apps. The server's default binding is local-only. Test venue connectivity before relying on it. Keep the phone app foregrounded. Mount the phone at the chest and the reporting AirPod at the waist; calibrate while standing still after both sources are fresh. Disconnects, source changes, and remounts require calibration again.

See [native setup](docs/native-setup.md) for off-ear acquisition, reporting-bud checks, audio routing, and device installation. Native apps never substitute simulated sensor input.

For the wired demo with the paired Debug app installed, keep the iPhone unlocked
and connected by USB, then run `npm run device:usb -- DEVICE_UDID` alongside the
backend. This starts a foreground relay on the connected device's developer
tunnel and launches monitoring without changing saved Wi-Fi pairing. Keep the
cable and helper connected; reconnecting requires calibration again.

## Providers

Copy `.env.example` to `.env` and configure only the integrations being used. Photon uses its cloud provider; responders must have approved phone numbers in `LIFELINE_RESPONDERS_JSON`. Approved phone identity and the alert's provider message ID determine who can accept. Exact incident-coded text commands are `ON IT`, `DEPART`, `ARRIVED`, `DECLINE`, or `RESOLVED`, followed by the full incident ID; resolution also requires an outcome. Removed reactions do not release ownership.

Set `LIFELINE_WEARER_PHONE` to the approved wearer's E.164 number to send a companion Photon iMessage: “I detected a possible fall. Are you okay?” It accompanies the phone's audible check-in and shares its deadline. The wearer can reply to that message with “I need help,” or send `I NEED HELP LF-XXXXXXXX` using the full current incident ID. Positive or ambiguous replies preserve the check-in; cancellation still requires the phone's explicit control. Wearer and responder numbers must differ. The dashboard tracks wearer iMessage configuration and the actual send outcome separately from phone audio.

FinchNode handoffs retain synthetic source record IDs. AI is required for the judged demo: it composes incident-relevant handoffs and answers through source-field selection and explicit unknowns. Application code renders the cited facts; AI cannot clear an incident, invent a clinical claim, or change ownership. Unconfigured/failed AI visibly degrades to templates and does not pass the AI demo gate. ElevenLabs prepares one cached check-in clip. The iPhone has a labelled native speech fallback for development.

Details: [provider setup](docs/providers.md).

## Motion trials

Use **Motion trials** on the dashboard to record a labelled trial. Begin recording before calibration, mount both sensors, stand still for at least one continuous second, calibrate, perform the controlled movement, then stop and download JSONL. The capture preserves accepted samples, clock exchanges, calibration/reset events, assessments, and disconnects. Stopping capture leaves incident response running.

Compare the same capture offline:

```sh
npm run replay:motion -- data/trials/trial-ID.jsonl
```

Replay evaluates combined, chest-only, and waist-only modes without connecting to the live backend or sending alerts. Scenario labels are operator annotations. Candidate counts do not establish fall-detection accuracy. See [trial procedure and replay output](docs/motion-trials.md).

## Verify

```sh
npm run typecheck
npm test
```

Tests cover deadlines/restart, stale and unauthorized acceptance, atomic ownership, explicit cancellation, sourced resolution, retries versus unknown sends, motion validity/calibration, clock uncertainty, controlled detection fixtures, trial capture/replay, and offline provider behavior.

## Current boundary

This is a working development foundation, not validated fall-detection accuracy. The initial detector uses tentative impact/tilt/stillness thresholds, preserves both streams, and requires bounded alignment for a cross-body candidate. Source failures remain explicit unknowns. Signed installation and wired streaming passed on the physical iPhone 15: real chest motion was received at 100 Hz alongside roughly 46 Hz from the Right AirPod. Mounted movement trials, audio routing, on-device recognition, and real provider sends still require validation. Venue Wi-Fi reachability remains unresolved; the wired path is the tested development connection.

Final on-device spoken replies are recorded against the current check-in. Exact help commands escalate immediately; positive replies ask the wearer to confirm using the cancel control; ambiguous replies leave the incident and deadline unchanged. Voice never resolves an incident. Stale replies and cancellation after the deadline are rejected.

The controller, native clients, dashboard, and providers use the shared [interfaces](docs/interfaces.md). See the [development plan](docs/development-plan.md) and [reference architecture](docs/LIFELINE-reference-architecture.md).
