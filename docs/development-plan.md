# LIFELINE development plan

Main track: Actually Intelligent (AI). FREE-WILi supplies wearable acceleration, voice, display and buttons. A waist AirPod Pro supplies secondary motion through the existing Kinesthetic acquisition and unchanged AudioRouteKeeper. The iPhone is the Photon/iMessage communication channel. The nearby Mac hosts orchestration and local inference.

The [PRD](PRD.md) defines scope and acceptance evidence. Node 24, SQLite and vanilla HTML/CSS/JS remain the stack. Camera acquisition is removed; Spacetime, Fetch/ASI:One and multi-patient features remain deferred.

## Implemented

- Deterministic incident state, check-in deadlines, approved responder ownership, progress and recorded outcomes; persisted outbox distinguishes accepted, failed and unknown sends.
- Structured read-only Finch synthetic records, immutable per-incident revisions, grounded AI handoffs/Q&A and a source-separated care brief. The fictional patient remains distinct from the real wearer.
- Official stock WILi SDK bridge without a firmware flash: measured acceleration, timing/quality views, provisional cross-body assessment, help/cancel buttons and phase display.
- Seven cached ElevenLabs board prompts, verified uploads and intelligible playback confirmed by the wearer; bounded microphone capture and local Whisper recognized a real help request. Acceleration pauses during voice and resumes before listening, with the gap visible.
- Reused waist-AirPod Mac app and communication-only iPhone client. Both motion streams have reported simultaneously; cadence is measured and varies.
- Native Photon chat/line binding, correlated replies, phone command guidance, grounded answer outbox and wearer updates. Project authentication succeeds; real receipt and replies remain unverified.

## Next priorities

1. Verify wearer check-in and responder handoff receipt, then real acceptance, one source-grounded question, departure, arrival and an explicit outcome. The board must show the resulting state changes. Both approved phones are now registered in Photon project Users; preserve the first rehearsal's unknown send outcomes rather than automatically resending them.
2. Rehearse a controlled physical candidate with WILi and the mounted waist AirPod, recording actual cadence/gaps and detection timing. Calibration remains deferred and is optional for the provisional detector.
3. Record the complete demo and a labelled operator-triggered backup. Compare an isolated device drop with the combined stream before making cross-body accuracy claims.

Production Finch Connect subject binding follows the working live loop. The public synthetic fixture already provides the read-only clinical context for the judged demo; hospital writeback is not part of the product.

## Work ownership

The main agent owns integration, policy and live rehearsals. Parallel implementation assignments use distinct files for device acquisition, provider transport and presentation/context composition. Shared contracts are in `src/contracts.ts`; each agent reports verification before integration.
