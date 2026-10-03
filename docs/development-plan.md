# LIFELINE development plan

Main track: Actually Intelligent (AI). Fixed hardware: chest iPhone 15, waist AirPod Pro, nearby Mac. Directly reuse Kinesthetic's AirPods acquisition and AudioRouteKeeper; preserve attribution and do not modify the source repo.

## Implementation areas

- Backend: contracts, incident controller, SQLite, motion ingestion/alignment/detection, server, provider worker integration, tests, end-to-end verification.
- Native clients: copied/adapted macOS AirPods app and build script; minimal SwiftUI iPhone motion producer and Xcode project/build script.
- Dashboard: vanilla HTML/CSS/JS live traces, device health, phase/owner/outcome, explicitly labelled development controls.
- Providers: Photon cloud adapter, FinchNode synthetic records, ElevenLabs audio and optional grounded model adapter; provider-level validation.

## Milestones

1. Compile native apps; run the local server; observe two separate real-source channels. Physical acquisition remains unproven until a device session is run.
2. A labelled synthetic trigger opens a persisted incident; injected-clock tests establish escalation, correlation, atomic acceptance, and sourced resolution.
3. Dashboard and authenticated controls demonstrate the response loop without claiming provider delivery when credentials are absent.
4. Configure actual providers and responders; validate sends/replies on real phones. No arbitrary recipients or fake success.
5. Record physical trials, tune tentative detection, compare single-source and combined behavior, rehearse and record the completed demo.

Node 24 + SQLite are the initial runtime/backend. Avoid additional app frameworks. Spacetime is outside this first slice. Camera, FREE-WILi, Fetch/ASI:One, and multi-patient features are deferred.

Shared interfaces are defined in `src/contracts.ts` and `docs/interfaces.md`. Components use separate directories and one shared root package manifest.
