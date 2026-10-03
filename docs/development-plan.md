# LIFELINE development plan

Main track: Actually Intelligent (AI). Target hardware: FREE-WILi for primary wearable acceleration and mic/speaker, waist AirPod Pro, nearby Mac. The iPhone is the Photon/iMessage communication channel only. Directly reuse Kinesthetic's AirPods acquisition and AudioRouteKeeper; preserve attribution and do not modify the source repo.

The [PRD](PRD.md) defines the product scope, fixed decisions, demo requirements, and acceptance evidence.

The [workshop-grounded migration plan](device-and-record-migration.md) defines the structured Finch patient view and FREE-WILi bridge. The iPhone client is now communication only. WILi acquisition has a separate contract and custom host bridge; physical firmware, board-specific detection and audio remain pending.

## Implementation areas

- Backend: contracts, incident controller, SQLite, motion ingestion/alignment/detection, server, provider worker integration, tests, end-to-end verification.
- Device clients: existing macOS AirPod app; FREE-WILi host bridge and board app selected for the actual hardware. Remove phone motion/audio/speech from the active path.
- Dashboard: vanilla HTML/CSS/JS structured patient records, separately labelled live evidence, device health, phase/owner/outcome and development controls.
- Providers: Photon cloud adapter, FinchNode synthetic records, ElevenLabs audio and required grounded AI handoff/Q&A for the judged demo.

## Milestones

1. Expose validated Finch clinical rows and historical vitals with source metadata, then bind clinical revisions to incidents instead of sharing one startup lookup forever.
2. Acquire real FREE-WILi acceleration with explicit units/range/capabilities and capture timing; adapt calibration/detection without inventing fused Core Motion fields. Preserve the existing AirPod bridge.
3. Add board help/cancel controls, playback and host transcription. Verify motion continuity while audio is active. Existing controller deadlines, ownership and outbox policy remain authoritative.
4. Configure providers and approved phones; verify physical playback, messages/replies and sandbox Connect subject binding. No arbitrary recipients or fake success.
5. Record new board/AirPod trials, tune tentative detection, compare single-source and combined behavior, rehearse and record the completed demo.

Node 24 + SQLite are the runtime/backend. Avoid additional app frameworks. Spacetime, Fetch/ASI:One and multi-patient features remain deferred. Camera acquisition/interpretation is out of scope. The primary track remains AI rather than Hardware.

Shared interfaces are defined in `src/contracts.ts` and `docs/interfaces.md`. Components use separate directories and one shared root package manifest.

## Current progress

Implemented: five-category synthetic Finch patient view and local record Q&A, persisted immutable incident context, handoff/answer provenance, source-separated care-brief export, native Photon chat/line binding and threaded replies, constrained owner progress, wearer updates, communication-only iPhone build, and WILi acceleration transport/quality/clock/recording/button checks. Default acquisition rejects chest-phone motion and phone speech. Board samples do not autonomously trigger incidents until a board-specific assessment is implemented.

Next: compatible physical board firmware, detector and voice integration; approved-phone live rehearsal; sandbox Connect subject binding. Calibration remains deferred.

## Historical phone prototype

The following describes the earlier phone/AirPod implementation and its validation history. Phone motion/audio are retired from the default runtime; do not reuse phone measurements as board evidence.

The backend, native clients, dashboard, and provider adapters are implemented. Automated tests cover the incident loop, speech policy, authentication, raw motion protocol, and provider failures. `npm run setup:local` installs/pairs the Mac app and prepares network access; iPhone device installation uses the signing/device steps in [native setup](native-setup.md).

Spoken check-ins use final on-device English transcripts. Help requests escalate; positive replies require the explicit cancel control; ambiguity preserves the deadline. The dashboard displays the recorded reply and actual source/configuration status.

Positive replies now receive an acknowledgement that directs the wearer to the explicit cancellation control, through native speech or a persisted Photon wearer message. The explicit demo profile accelerates new silence check-ins to five seconds with labelled timing; spoken reply rehearsals use a sufficient normal configurable window. AI composes structured, source-cited handoffs/answers; failure remains a visibly degraded template and does not pass the AI demo gate.

The wearer check-in also queues a Photon iMessage when configured with `LIFELINE_WEARER_PHONE`. Wearer replies share the same policy and deadline; a separate worker slot keeps a slow wearer send from delaying responder alerts. The dashboard distinguishes phone audio, wearer iMessage, and responder delivery. Actual iMessage receipt and replies remain part of the physical demo validation.

Responder alerts and phase updates include exact commands to complete the loop from a phone. Grounded answers now use the persisted responder outbox, with atomic inbound dedupe and permission checks after generation and before submission. Photon listener startup/stream failures recover with capped backoff; incomplete SDK cleanup is visible and blocks replacement clients. Automated checks cover these paths; actual provider receipt and interruption recovery remain live rehearsal gates.

Trial capture and offline replay now preserve timing/calibration and compare combined sensing with each source alone. Synthetic detection fixtures exercise phone-only drops, sitting/bending, ongoing movement, sample gaps, stale clocks, and unstable calibration. These establish software behavior; physical recordings still need to establish whether the thresholds fit the mounted devices. See [motion trials](motion-trials.md).

The signed app is installed on the physical iPhone 15 with its local pairing preferences verified. A 120-second recording captured simultaneous real chest motion at 100.14 Hz and Right AirPod motion at 47.28 Hz over the developer USB tunnel; current availability remains visible in the console. Wi-Fi requests timed out; their cause remains unresolved. The foreground USB helper discovers the current tunnel without changing saved Wi-Fi pairing. Explicit calibration controls and readable wearer incident progress are installed. Remaining physical work: verify the reporting bud is the mounted waist bud, calibrate both mounted sources when requested, and measure sensing/voice behavior. Photon cloud authentication and subscription pass; actual messages still need approved wearer/responder numbers. Local Qwen2.5 3B now generates source-cited handoffs and responder answers, verified in the console with an authenticated preview that sends no messages and creates no incident events. The question history records per-answer provenance and delivery separately. ElevenLabs still needs private configuration and playback validation.
