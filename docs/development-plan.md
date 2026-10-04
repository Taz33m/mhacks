# LIFELINE development plan

Updated October 4, 2026. Main track: **Actually Intelligent (AI)**.

The current checkpoint combines incident response and everyday care. The [PRD](PRD.md) defines product behavior; this page records what is implemented, what has been verified, and the next work.

## Architecture

- FREE-WILi: body acceleration, microphone, speaker, display and explicit help/okay controls. The current stock-SDK bridge uses USB to the nearby Mac.
- Waist AirPod Pro: secondary motion through the reused Kinesthetic acquisition and unchanged route keeper.
- iPhone: the wearer's existing Photon/iMessage conversation and explicitly shared Find My location. No phone camera, motion or speech acquisition.
- Mac: Node 24, SQLite, deterministic incident policy, provider workers, local inference and the web workspace.
- One LIFELINE agent coordinates separate private wearer and responder conversations around one persisted incident. The dashboard observes the loop.

## Delivered

| Area | Current behavior |
| --- | --- |
| Incident policy | Persisted check-in deadlines, exact help, explicit cancellation, atomic responder ownership, departure, arrival, recorded outcomes and reassignment. AI cannot cancel, assign ownership or resolve. |
| Autonomous dispatch | A labelled simulated human Maya receives the local alert, accepts, departs, arrives and records an outcome without dashboard progress clicks. The live profile retains approved real responders. |
| Photon | Bound native chat/line identity, threaded replies, wearer reports, independent wearer/responder submission lanes and read-only readiness diagnostics. Durable questions prepare outside the inbound listener with bounded recovery. Unknown submissions are preserved rather than blindly resent. |
| Voice | Cached ElevenLabs prompts, intelligible board playback, bounded microphone capture, local Whisper transcription and dynamic spoken responder replies. Holding Blue supports everyday-care voice messages. |
| Everyday care | One daily prompt per local date, defaulting to 2 p.m.; text/voice replies and short model follow-ups. Clinical questions use the grounded record engine. Loneliness or missed replies do not open incidents; exact help does. |
| Finch and EHR | Read-only structured synthetic chart, grouped medication history, dated vitals, grounded questions, immutable incident/answer snapshots and protected care exports. The fictional Finch subject is explicitly separate from the wearer. |
| Location | Native Photon Find My onboarding and scoped watches; optional browser fallback. Fresh, sufficiently accurate wearer/owner positions can support an Apple Maps walking ETA. Location cannot appoint an owner or confirm arrival. |
| Sensing and trials | Provisional paired WILi/waist assessment, session/clock validation, three-second standing/walking guide, paired JSONL recording and offline replay. Legacy phone captures preserve their original identities behind an explicit flag. |
| Wearable reliability | Bounded USB/backend recovery, one reaped serial worker per attempt, explicit simulated-mode ambient art within the 44-image budget, quiet idle and speech/measurement scheduling. Dynamic transfers show a hold-Red hint and recover newly held Red input; completed taps inside transfer remain unavailable. |
| Web experience | Six dashboard care views, separate read-only EHR and optional Developer tools. Overview focuses on the current incident. WILi retains its last measured display value between reports, with a labelled initial zero and acquisition details in a disclosure. |
| Landing | Scroll-driven desktop/mobile story, reduced-motion/static alternatives, illustrative coordination/signals, supplied logo, local fonts and EHR preview. The Cloudflare bundle excludes operational endpoints and private state. |

## Verification at this checkpoint

- **486 Node tests**, **77 Python gateway/display tests**, **5 Python public-packaging tests**, TypeScript checks and frontend JavaScript syntax pass after the October 4 integration fixes. Isolated server regressions verify responder submission while a wearer request remains pending and acceptance while a clinical answer is generating. Questions persist before inference and recover interrupted preparation. Automated tests do not claim physical accuracy or cloud receipt. See the [codebase and PRD audit](codebase-audit-2026-10-04.md) and its follow-up for implementation gaps.
- Real board microphone → local Whisper → incident policy and ElevenLabs reply playback passed separate physical voice rehearsals within the normal twenty-second check-in. The wearer confirmed clear playback. Physical Blue hold/release still needs a complete rehearsal.
- Real Finch/local-model rehearsals covered attributed symptom updates, grounded clinical and report-only answers, immutable snapshots, daily social replies and the incident state chain. These rehearsals used generated inputs and recording transports, with no external messages.
- Native Photon wearer inbound and return delivery were verified separately. The real responder conversation encountered an upstream new-contact restriction; the complete human-responder incident exchange remains unverified.
- A native Find My sharing request was sent and delivered. A usable shared position and a live wearer/responder ETA remain unverified. A generated public-campus route checked the routing helper only.
- Generated paired-protocol tests opened check-in automatically through server ingestion and reproduced captured detector features offline. Mounted physical fall trials have not established accuracy or a cross-body advantage.
- Dashboard navigation, calm reset state, source-grounded record answers, clinical exports and the supplied branding were inspected in the browser. Generated active-incident fixtures remained labelled. Landing-specific desktop/mobile evidence is recorded in the [production notes](landing-sequence-production.md).

## Next work, in order

1. Restore actual waist measurements when the wearer is available. The earlier standing/walking calibration succeeded in a prior session; the current session has reported no measurements. Calibration is optional for the detector, but real paired acquisition is required for a physical-trigger claim.
2. Record labelled mounted standing, sitting and bending trials, then a controlled low descent onto the mat with continuous timestamped video. Check an isolated WILi drop separately. Preserve gaps, saturation, session identity and replay results beside each trial.
3. Rehearse the full physical wearer → check-in → help → simulated Maya → outcome loop, including actual wearer Photon receipt, WILi spoken updates and Blue hold/release. No dashboard progress operator.
4. Record the submission demo and a clearly labelled operator-triggered backup. Use actual measured timings for detection, check-in, escalation and receipt; do not infer accuracy from generated fixtures or average cadence.
5. Verify real human-responder onboarding and native Find My positions/ETA as separate gates. They do not block the labelled simulated dispatcher profile.

## Boundaries

The current WILi bridge needs USB. Wireless transport remains future work; a Wi-Fi accessory is not part of the working demo. At-rest reporting has been roughly 1 Hz in observed sessions, with faster reports during movement. The detector's 500 ms freshness gate is unchanged; held UI values do not become fresh sensor evidence.

Stock WILi exposes acceleration, not fused orientation. The provisional stock ±2 g profile excludes clipping and uses gateway receipt timing, with unknown board capture latency. Missing evidence never means safe.

Maya's simulated acceptance, arrival and outcome do not establish a real human's attendance, iMessage receipt, GPS or ETA. Finch's fictional records do not become the actual wearer's medical record. Production subject binding, hospital authorization, enrollment and wireless operation follow the working demo. Hospital writeback, seizures and gait-risk detection remain outside the implemented scope.

## Repository map

- `src/`: shared contracts, incident controller, persistence, sensing, everyday care, EHR, location and provider adapters.
- `native/freewili/`: stock serial worker, audio/transcription, ambient display and recovery; `native/macos/`: reused waist acquisition and route helper; `native/ios/`: communication companion.
- `public/`: landing, dashboard, EHR, location fallback, fonts and production story assets.
- `scripts/`: local setup, builds, read-only diagnostics, isolated smoke rehearsals and offline replay.
- `docs/`: product decisions, setup, interfaces, provider guidance, trial procedure and design provenance.
- `.env`, `data/`, `output/` and native build folders: private local configuration, persisted state, recordings and generated verification; excluded from Git.

Verification commands are in the [README](../README.md). Provider details: [providers](providers.md). Physical setup: [native setup](native-setup.md). Trial procedure: [motion trials](motion-trials.md). Public packaging: [Cloudflare landing](cloudflare-landing.md).
