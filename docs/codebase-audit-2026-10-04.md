# LIFELINE codebase and PRD audit

Audited October 4, 2026, approximately 1:38 a.m. ET. Primary track: **Actually Intelligent (AI)**. This is a source, test and saved-evidence audit; it did not send messages, play audio, reset calibration or perform a new physical trial.

**Assessment:** the product's main software flows exist and the automated checks pass. LIFELINE is ready for focused integration and rehearsal work. It is not yet a verified autonomous physical demo. The largest remaining risk is the mounted sensing-to-response chain, followed by messaging latency and a few mismatches between the PRD and implementation.

## What is built

| Layer | Current implementation |
| --- | --- |
| Policy and persistence | Node 24 with SQLite transactions, one active incident, persisted deadlines, audit events, atomic ownership, reassignment and concrete outcomes. The model cannot cancel, appoint an owner or resolve. |
| Physical acquisition | Official stock WILi SDK over USB for acceleration, display, buttons and audio. Waist AirPod motion uses the adapted Kinesthetic bridge; its route keeper remains unchanged. The iPhone is communication-only. |
| Detection | Provisional acceleration impact plus correlated waist movement/rotation and continuous waist quiet. Range, clipping, clocks, sessions and missing measurements constrain eligibility. |
| Voice | Cached ElevenLabs prompts, bounded WILi microphone capture, local Whisper transcription, dynamic attributed responder speech and Blue hold/release for everyday care. |
| Communication | One LIFELINE identity with separate approved wearer/responder Photon conversations, native chat/line/message correlation, an action outbox and bounded listener recovery. |
| AI and clinical data | Actual model fact selection from returned synthetic Finch records and local incident observations, application-rendered citations, grounded questions, explicit fallback, immutable incident revisions and care exports. |
| Everyday care | Default afternoon check-in, one prompt per local date, text/voice replies, social follow-ups and a separate grounded clinical-question path. Incidents interrupt routine care. |
| Dispatch | Real-contact profile plus an autonomous, explicitly simulated human Maya profile. Local acceptance, departure, arrival and outcome require no dashboard operator. |
| Location | Native Find My requests and scoped watches, optional consented browser sharing, and walking-route ETA code. Missing location remains unknown. |
| Web | Landing, care dashboard, EHR, calibration guide, hidden Developer controls, brand assets and a read-only reconstructed wearer avatar. |

The architecture is coherent for the hackathon. Its authoritative incident state lives in the backend; Photon carries conversations and actions, and the model selects/interprets context within policy. The main integration concentration is in `src/server.ts`, `src/controller.ts` and `public/app.js`. A framework rewrite would not resolve the current demo gates.

## Fresh verification

| Check | Result |
| --- | --- |
| Full Node test suite | **462 passed, 0 failed, 0 skipped**; approximately 7.8 seconds |
| WILi Python unit suite | **64 passed**; approximately 3.6 seconds |
| TypeScript | Passed |
| All top-level frontend JavaScript syntax | Passed |

Logs are in ignored `output/verification/codebase-audit-{node-tests,python-tests,typecheck}.log`. Tests exercise controller policy, transport fixtures, grounding, acquisition validation, replay, server contracts and presentation. Passing fixtures do not establish physical sensing performance or actual phone receipt.

## PRD coverage

“Implemented” below means the code and relevant automated coverage exist. The last column states the outstanding acceptance proof or concrete mismatch.

| PRD | Implementation | Remaining requirement or proof |
| --- | --- | --- |
| S1 — source provenance | Implemented | Observe both mounted streams together through the entire rehearsal, including voice operations. |
| S2 — quality and calibration | Implemented | Measure actual cadence/alignment/gaps. Held dashboard readings are presentation only. Earlier successful calibration does not establish a fresh current session. |
| S3 — paired assessment | Implemented prototype | No complete mounted WILi/AirPod staged-event recording exists in `data/trials`. No physical detection performance or cross-body advantage established. |
| S4 — missing evidence | Implemented | Degraded cases pass fixtures; record a real interrupted-source trial. No single-source live fallback. |
| C1 — incident persistence | Implemented | Injected-clock, duplicate-trigger and restart checks pass. |
| C2 — parallel check-in/escalation | **Partial** | Board context and policy deadlines are independent, but one outbound Photon worker can delay responder submission behind a slow wearer send. Full simultaneous sensing/audio/message rehearsal remains pending. |
| C3 — reply correlation | Implemented | Exact help, ambiguity, positive replies, stale targets and dedupe are covered. Rehearse actual wearer speech and Photon input in the same incident. |
| C4 — closure policy | Implemented | Explicit pre-escalation cancellation and on-scene owner outcome are enforced. |
| R1 — identity and ownership | Implemented | Actual approved human alert/acceptance loop remains unverified. Simulated receipts are separately typed. |
| R2 — actionable messages | Implemented | A human responder has not completed the whole loop solely through received messages. |
| R3 — reassignment | Implemented | Automated missed-owner/exhausted-contact cases pass; the real unavailable-owner branch remains unrehearsed. |
| A1 — grounded AI | Implemented; actual inference exercised | Saved rehearsals used the actual configured model and synthetic Finch endpoint with generated inputs and recording transports. A sourced answer on a real responder phone is not yet proved. |
| A2 — durable questions and answers | **Partial** | Answer/provenance/outbox commit is atomic after generation. The original question is not persisted before model preparation begins. |
| A3 — listener recovery | Implemented | Bounded reconnect/end/error/shutdown fixtures pass; a live interruption rehearsal remains pending. Slow question generation also blocks later inbound processing. |
| D1 — console and preview | Implemented | Dashboard/EHR browser evidence exists. Verify all views during one integrated incident. |
| D2 — clear simulation labels | **Partial** | Dashboard, protocol and messages distinguish simulation. The image-based WILi renderer drops the demo flag. |
| D3 — demo timing | Implemented | Effective/configured policy is exposed; persisted deadlines survive profile changes. Current backend uses the normal 20-second check-in. |
| D4 — clinical source separation | Implemented | Historical dates, subject/source identity, revisions, local observations and citations are represented. Personal hospital-record binding is not implemented. |
| E1 — capture and replay | **Partial** | Current paired recording/replay exists, but primary-only/waist-only paired diagnostic modes requested by the PRD do not. Reset replay also drops recorded calibration-preservation intent. |
| P1 — held-out evaluation | Pending | No held-out mounted trial set or measured miss/false-alert/latency report exists. |

Daily wellbeing, location and the communication-only phone are also present. Physical Blue hold/release through an actual daily reply, native usable shared positions and real walking ETA remain separate proof gates.

## What the existing evidence proves

- The wearer confirmed clear board voice in prior rehearsals and has now confirmed the actual LIFELINE screen. The screen fix uses the manufacturer's filename-only `show_gui_image` call. A displayed static image does not prove continuous monitoring or animation.
- WILi microphone/transcription and response speech have separate physical/acoustic evidence. The saved voice smoke explicitly used synthetic acoustic wearer input and a recording transport; it did not send an actual responder message.
- Actual wearer Photon inbound and return delivery were verified separately, including user confirmation of receipt. The responder probe retained an **unknown** submission result, not a successful full responder exchange.
- The complete saved incident-flow rehearsal passes with actual local inference, generated wearer/responder inputs and a local recording transport. It proves workflow integration under those inputs.
- Autonomous simulated-dispatch tests require zero manual responder progress commands and fabricate no native receipts or GPS. The full physical rehearsal of this profile remains pending.
- Find My sharing-card delivery was verified. A usable native location and real wearer/owner ETA were not.
- All three saved `data/trials` captures are legacy version 1. One has no samples; two contain 17,693 and 6,139 Core Motion samples respectively. None contains a WILi `accel.sample` stream. They cannot prove the current paired detector.
- Stored dashboard/EHR and landing browser checks exist. The inspected current public landing bundle has no unexpected operational files; future build-directory reuse remains a packaging gap.

## Concrete findings

### Fix before calling the physical demo ready

1. **Restore and verify continuous paired acquisition.** At the audit snapshot, WILi was disconnected and the waist stream had no fresh measurements. The latest incident was resolved in simulated mode. Image provisioning previously encountered USB failures; complete stock-bridge startup after the confirmed display fix still needs verification.

   The detector requires a currently fresh WILi sample (`src/wili-assessment.ts:118`), while freshness expires after 500 ms (`src/freewili.ts:165`). Roughly 1 Hz at-rest reporting therefore makes eligibility intermittent. Measure behavior during the candidate and subsequent quiet window before changing thresholds; holding a UI value must not change evidence.

2. **Carry simulated-dispatch labeling into native image screens.** The server supplies `LIFELINE DEMO` in status text (`src/server.ts:748`), but image-enabled status suppresses that text (`native/freewili/stock_io.py:138`) and passes only phase/owner to the image model (`:479`). Simulated acceptance, travel and arrival can therefore look real on the physical screen.

3. **Remove messaging head-of-line blocking where it affects incident action.** One `messageBusy` flag serializes all Photon sends (`src/server.ts:123,299`). A slow wearer submission does not stop the incident timer, but delays the actual responder alert. Independently, the listener awaits each inbound handler (`src/providers/photon.ts:402`), and a clinical question awaits model generation (`src/responder-questions.ts:27`). Later help/progress messages can wait behind inference.

4. **Persist responder questions before generation.** Post-generation dedupe, provenance, authorization and outbox transactions are sound (`src/controller.ts:599`). A crash during generation leaves no durable original question/job; recovery currently depends on provider redelivery.

5. **Account for the dynamic-audio button interruption.** Dynamic reply upload disables button events (`native/freewili/stock_io.py:618`) and restores the current pressed state (`:629`). A short Red tap entirely inside that interval can be missed. This is a known control-availability gap, not proof that the whole physical button loop fails.

### Finish measurement and polish

- **E1:** implement paired diagnostic ablations or explicitly revise that PRD requirement. Keep offline comparisons separate from the no-single-source live policy. Also preserve reset calibration intent in replay (`scripts/replay-paired-motion.ts:227`).
- **Developer controls:** Arrive is disabled from `ACKNOWLEDGED` (`public/app.js:1581`), despite policy allowing direct arrival. This affects operator tools, not autonomous Maya's policy transitions.
- **Provenance label:** generic Photon reports are rendered as “iMessage” (`public/app.js:650`) even when native service is unspecified; other views already say “Photon message.”
- **EHR readability:** the backend already projects structured audit JSON into readable descriptions. Preserve those descriptions and exact quotes; the remaining improvement is readable event headings/source labels. The initial client-only interpretation of a JSON wall was incorrect.
- **Public build:** clean the Cloudflare destination and validate its complete file allowlist. Current output is clean, but the builder can retain stale files (`scripts/build-cloudflare-landing.py:11`).
- **Avatar reproducibility:** the reconstructed pose and sensor-coordinate vectors are read-only visualization. Assets depend on ignored `output/demo-avatar` files and special server routes (`src/server.ts:672`); a fresh clone needs a documented preparation/package path. This is not animated body tracking.

## Documentation and scope

Some implementation notes lag behind the product. `docs/interfaces.md` still describes WILi primarily as custom firmware, says voice/STT are pending and the server sends no board audio, and describes only version-1 capture. `native/PROVENANCE.md` still calls iOS a chest producer. The reference-architecture document still says the earlier phone runtime remains active. The PRD's remaining live-chain list also requires a real responder although its selected demo gate permits labelled simulated dispatch. Those statements should be reconciled with the current architecture.

The current synthetic Finch retrieval is useful as read-only context for local observations, messages and source-grounded answers. Sandbox Connect/personal subject binding, hospital authorization and writeback are absent. Wireless WILi operation, seizures, multiple wearers, automatic calls, Spacetime and Fetch integrations are deferred rather than missing pieces of the selected demo. The local workspace also has unauthenticated read-only incident snapshots; it is not a production patient-access boundary.

## Recommended next sequence

1. Fix the native simulation label and messaging/inbound scheduling gaps; verify stock-bridge startup and both current streams without triggering an incident.
2. When the wearer is available, capture mounted standing/sitting/bending, an isolated-device movement and a controlled descent onto the mat. Replay the current paired rule and retain missing/clipped evidence.
3. Run one autonomous physical wearer → check-in/actual wearer receipt → help → simulated Maya → spoken progress → recorded outcome rehearsal. Exercise Blue hold/release separately. Measure each stage and record a backup.
4. Make the AI contribution visible in that same story: an actual model-generated handoff plus one source-grounded question/answer with its provenance.
5. Complete real-human responder and native location/ETA proof if time permits. They should not delay the labelled simulated-dispatch submission.

The next work should close these gates. The code already has enough product breadth for the intended demo.

## Implementation follow-up

The subsequent development pass addressed C2's application-level outbound blocking, A2's preparation durability, inbound model blocking and D2's native image disclosure. Wearer/responder lanes are independent; the listener persists questions and returns; bounded background jobs recover interrupted preparation. The single simulated screen bundle preserves visible DEMO labels within 44 images and falls back to labelled text on a mode mismatch.

Dynamic audio transfer now shows HOLD RED FOR HELP and recovers a newly held Red input once, using the updated incident context. A press released entirely during transfer remains unavailable. Developer direct arrival, Photon service labels, EHR headings, pending Q&A presentation and clean allowlisted public builds were also corrected.

Fresh checks after these changes: **486 Node tests, 77 wearable Python tests, 5 packaging Python tests**, TypeScript and frontend syntax passed. New isolated server tests exercise slow wearer sends and slow clinical generation while incident actions continue. The backend was restarted with the updated code and the actual local dashboard inspected. Physical rehearsal remains the user's next step; these checks do not stand in for it.
