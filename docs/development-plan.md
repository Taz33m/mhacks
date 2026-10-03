# LIFELINE development plan

Main track: Actually Intelligent (AI). Fixed hardware: chest iPhone 15, waist AirPod Pro, nearby Mac. Directly reuse Kinesthetic's AirPods acquisition and AudioRouteKeeper; preserve attribution and do not modify the source repo.

The [PRD](PRD.md) defines the product scope, fixed decisions, demo requirements, and acceptance evidence.

## Implementation areas

- Backend: contracts, incident controller, SQLite, motion ingestion/alignment/detection, server, provider worker integration, tests, end-to-end verification.
- Native clients: copied/adapted macOS AirPods app and build script; minimal SwiftUI iPhone motion producer and Xcode project/build script.
- Dashboard: vanilla HTML/CSS/JS live traces, device health, phase/owner/outcome, explicitly labelled development controls.
- Providers: Photon cloud adapter, FinchNode synthetic records, ElevenLabs audio and required grounded AI handoff/Q&A for the judged demo.

## Milestones

1. Compile native apps; run the local server; observe two separate real-source channels. Physical acquisition remains unproven until a device session is run.
2. A labelled synthetic trigger opens a persisted incident; injected-clock tests establish escalation, correlation, atomic acceptance, and sourced resolution.
3. Dashboard and authenticated controls demonstrate the response loop without claiming provider delivery when credentials are absent.
4. Configure actual providers and responders; validate sends/replies on real phones. No arbitrary recipients or fake success.
5. Record physical trials, tune tentative detection, compare single-source and combined behavior, rehearse and record the completed demo.

Node 24 + SQLite are the initial runtime/backend. Avoid additional app frameworks. Spacetime is outside this first slice. Camera, FREE-WILi, Fetch/ASI:One, and multi-patient features are deferred.

Shared interfaces are defined in `src/contracts.ts` and `docs/interfaces.md`. Components use separate directories and one shared root package manifest.

## Current progress

The backend, native clients, dashboard, and provider adapters are implemented. Automated tests cover the incident loop, speech policy, authentication, raw motion protocol, and provider failures. `npm run setup:local` installs/pairs the Mac app and prepares network access; iPhone device installation uses the signing/device steps in [native setup](native-setup.md).

Spoken check-ins use final on-device English transcripts. Help requests escalate; positive replies require the explicit cancel control; ambiguity preserves the deadline. The dashboard displays the recorded reply and actual source/configuration status.

Positive replies now receive an acknowledgement that directs the wearer to the explicit cancellation control, through native speech or a persisted Photon wearer message. The explicit demo profile accelerates new silence check-ins to five seconds with labelled timing; spoken reply rehearsals use a sufficient normal configurable window. AI composes structured, source-cited handoffs/answers; failure remains a visibly degraded template and does not pass the AI demo gate.

The wearer check-in also queues a Photon iMessage when configured with `LIFELINE_WEARER_PHONE`. Wearer replies share the same policy and deadline; a separate worker slot keeps a slow wearer send from delaying responder alerts. The dashboard distinguishes phone audio, wearer iMessage, and responder delivery. Actual iMessage receipt and replies remain part of the physical demo validation.

Responder alerts and phase updates include exact commands to complete the loop from a phone. Grounded answers now use the persisted responder outbox, with atomic inbound dedupe and permission checks after generation and before submission. Photon listener startup/stream failures recover with capped backoff; incomplete SDK cleanup is visible and blocks replacement clients. Automated checks cover these paths; actual provider receipt and interruption recovery remain live rehearsal gates.

Trial capture and offline replay now preserve timing/calibration and compare combined sensing with each source alone. Synthetic detection fixtures exercise phone-only drops, sitting/bending, ongoing movement, sample gaps, stale clocks, and unstable calibration. These establish software behavior; physical recordings still need to establish whether the thresholds fit the mounted devices. See [motion trials](motion-trials.md).

The signed app is installed and launched on the physical iPhone 15 with its local pairing preferences verified. Real chest motion is reaching the backend over the connected developer USB tunnel at 100 Hz, alongside roughly 46 Hz from the Right AirPod. Wi-Fi requests timed out; their cause remains unresolved. The foreground USB helper discovers the current tunnel without changing saved Wi-Fi pairing. Remaining physical work: verify the reporting bud is the mounted waist bud, calibrate both mounted sources, and measure sensing/voice behavior. Photon cloud authentication and subscription pass; actual messages still need approved wearer/responder numbers. Grounded AI and ElevenLabs need private configuration before their demo gates can pass.
