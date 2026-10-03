# LIFELINE

MHacks 2026 — Actually Intelligent (AI). Chest iPhone + waist AirPod evidence starts a policy-controlled incident, followed through responder acceptance, progress, and a recorded outcome.

## Start

Requires Node 24+ and npm. Native builds require Xcode on macOS.

```sh
npm install
npm start
```

Open **http://127.0.0.1:8877**. The dashboard shows real source availability, incident state, provider configuration, and explicitly labelled development controls. Trigger a synthetic incident or manual help, accept as a development responder, report departure/arrival, and record an outcome. These controls simulate authenticated actors for development; they are not production identity verification.

The default backend is Node + SQLite, with persisted deadlines and an action outbox. Data, recordings, tokens, and native build products are ignored by Git. No keys or approved phones are configured by default. Unconfigured providers do not claim delivery. FinchNode uses its public synthetic demo.

## Native sensors

```sh
npm run build:airpods
npm run build:ios
```

The Mac app directly incorporates Kinesthetic's acquisition and audio route keeper. `KeepAlive.swift` is unchanged; the bridge adds acceleration/gravity, LIFELINE packets, clock synchronization, and source/session validation. See [native provenance](native/PROVENANCE.md).

For the actual phone, open `native/ios/LifelinePhone.xcodeproj` in Xcode, select your signing team and connected iPhone, then build/run. The automated build checks the simulator target without launching it; it does not establish hardware sensing.

For phone-to-Mac access, run with `LIFELINE_HOST=0.0.0.0 npm start` on a trusted development network. Visit the dashboard from this Mac to obtain the pairing token and LAN address, then enter them in the native apps. The server's default binding is local-only. Test venue connectivity before relying on it. Keep the phone app foregrounded. Mount the phone at the chest and the reporting AirPod at the waist; calibrate while standing still after both sources are fresh. Disconnects, source changes, and remounts require calibration again.

See [native setup](docs/native-setup.md) for off-ear acquisition, reporting-bud checks, audio routing, and device installation. Native apps never substitute simulated sensor input.

## Providers

Copy `.env.example` to `.env` and configure only the integrations being used. Photon uses its cloud provider; responders must have approved phone numbers in `LIFELINE_RESPONDERS_JSON`. Approved phone identity and the alert's provider message ID determine who can accept. Exact incident-coded text commands are `ON IT`, `DEPART`, `ARRIVED`, `DECLINE`, or `RESOLVED`, followed by the full incident ID; resolution also requires an outcome. Removed reactions do not release ownership.

FinchNode handoffs retain synthetic source record IDs. Optional model calls select relevant existing records; model text cannot clear an incident, invent a clinical claim, or change ownership. ElevenLabs prepares one cached check-in clip. The iPhone has a labelled native speech fallback for development.

Details: [provider setup](docs/providers.md).

## Verify

```sh
npm run typecheck
npm test
```

Tests cover deadlines/restart, stale and unauthorized acceptance, atomic ownership, explicit cancellation, sourced resolution, retries versus unknown sends, motion validity/calibration, clock uncertainty, and offline provider behavior.

## Current boundary

This is a working development foundation, not validated fall-detection accuracy. The initial detector uses tentative impact/tilt/stillness thresholds, preserves both streams, and requires bounded alignment for a cross-body candidate. Source failures remain explicit unknowns. Physical trials, iPhone installation, actual audio-route behavior, and real provider sends require device/configuration validation. Spoken reply recording is not implemented yet.

The controller, native clients, dashboard, and providers use the shared [interfaces](docs/interfaces.md). See the [development plan](docs/development-plan.md) and [reference architecture](docs/LIFELINE-reference-architecture.md).
