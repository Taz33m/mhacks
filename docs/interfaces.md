# Shared implementation interfaces

Server: Node 24, HTTP/WebSocket port **8877** (avoids Kinesthetic). Runtime modules use `.ts` imports; no compilation required. Types are in `src/contracts.ts`. Dependencies are managed in the root package manifest.

## Native producers

The retained Mac waist producer connects `ws://HOST:8877/motion?source=waist-airpod&token=TOKEN`. Token is persistent development pairing (shown only via localhost setup); production enrollment is outside this slice. Send `MotionSample`: CoreMotion `sensorTime` in seconds, quaternion xyzw, rotation rad/s, gravity and user acceleration in g. Reporting bud identity must be preserved. Source and session stay stable on a connection; reconnect starts a new session. The iPhone is communication-only. Legacy `chest-phone` ingestion/detection requires explicit `LIFELINE_LEGACY_PHONE=1`; the current iPhone app does not produce samples.

FREE-WILi connects separately as `source=body-wili` through the [official stock-SDK bridge](../native/freewili/README.md). It translates real callbacks into `device.hello`, ordered `accel.sample` packets with gravity-inclusive `accelerationG`, declared range/quality and clock replies. Stock `sensorTime` is gateway receipt in seconds (`captureClock: "host-receipt"`); the original framing timestamp remains separate. The optional custom protocol supports device-monotonic capture. Neither path fabricates quaternion or CoreMotion fields. `Snapshot.wili` reports acquisition, timing, saturation and cadence separately. The provisional paired detector, explicit buttons, cached speech, bounded microphone capture, local Whisper and attributed responder playback are implemented. Physical components have separate verification; the complete mounted chain requires rehearsal. `incident.context` includes explicit `dispatchMode`; the board uses labelled simulated artwork or truthful text fallback rather than inferring mode from prose.

Server sends `ClockPing` approximately every two seconds. Respond with `ClockPong`, echoing `id` and current session, and stamping receipt/send with device monotonic uptime in milliseconds. Native clients must run a WebSocket receive loop. Send backoff/dropped samples must not fabricate continuity.

`GET /health` returns `{status:'ok', motionSources:['waist-airpod', ...]}` for recent CoreMotion samples; WILi acquisition is reported separately in `Snapshot.wili`. Native waist bridge verification uses this rather than Kinesthetic player/game health. `GET /api/checkin` with `Authorization: Bearer TOKEN` supplies the current/latest incident, server time, approved responder names and policy. The iPhone polls this state and sends explicit help/cancel commands; it never captures or plays wearer audio. The response retains optional `audioUrl` (`/api/audio/checkin`, authenticated if prepared) for compatibility, without establishing device playback.

## Dashboard

Static files owned under `public/`. `GET /api/state` returns `Snapshot`; WebSocket `/live` pushes full snapshots, at most 10 Hz. GET state and live view are read-only. `POST /api/commands` receives `Command`, returning `{ok:true}` or `{error:string}`. Commands require bearer token; localhost dashboard can obtain it through `GET /api/setup` which returns `{token, port, addresses}` and is rejected for non-loopback clients. No token in logs, recordings, or public snapshots. Clearly label trigger/responder buttons as development simulation; actor identity on those controls is operator simulation, not production identity proof.

## Communication and check-in controls

The communication iPhone sends bearer-authenticated `/api/commands`: manual `trigger` for **I NEED HELP**, or `cancel` with current `incidentId` and `checkinId` for **I DON'T NEED HELP**. Only controller acceptance establishes a command result; failed/unknown HTTP requests never locally resolve an incident. Pairing preferences and the app bundle identity are retained. Legacy `/api/checkin/reply` returns HTTP 410 by default; the active iPhone app has no speech/microphone path. Enabling the legacy phone profile is separate from the FREE-WILi architecture.

Local `/api/setup` includes `lanEnabled` based on the actual listener address. Advertised addresses do not prove phone reachability.

Snapshot `wearerMessaging:{configured,detail}` reports companion Photon configuration without exposing the wearer phone. `wearer_checkin`, `wearer_ack` and `wearer_status` actions (null recipient) belong to the wearer lane. Wearer and responder submissions have independent busy/pacing state so one person's slow request does not hold the other lane. Existing `checkin` actions are not claimed by messaging workers and do not prove board audio playback. Photon wearer replies require full-phone identity, an accepted current-incident chat/line binding, and message/incident correlation, then are recorded as `CHECKIN_REPLY` with actor `photon-imessage`. Positive replies queue acknowledgements atomically with inbound dedupe, without cancelling or extending the check-in. Phase updates queue wearer status; outdated queued status is not sent. Missing data, silence or reactions never authorize cancellation.

Plain wearer text in the accepted current chat/line is correlated without a copied code. After escalation it becomes a `WEARER_REPORT` and exact attributed `wearer_relay` action for eligible contacted responders. A duplicate provider ID creates neither a second observation nor another relay. Explicit stale reply targets fail even in a reused chat. These reports refresh handoff context but cannot change phase, ownership or deadlines; no closed incident accepts further reports.

Snapshot and `/api/checkin` include `policy:{demoMode,checkinMs,configuredCheckinMs}`. The explicit demo profile accelerates new check-ins to five seconds; metadata never replaces a persisted active incident deadline. The phone displays this acceleration but does not play a prompt.

Use the normal twenty-second window for the physical voice rehearsal. Five seconds is a silence demonstration and cannot fit the check-in prompt, bounded microphone capture and local transcription. Stock bridge readiness must precede forwarding incident context; expired queued check-in context is discarded rather than spoken late.

## Patient records and care brief

`HealthContext.patientRecord` carries the normalized five-category synthetic Finch snapshot: demographics, medications, conditions, allergies and historical vitals, including separate medication administration/dispense sections and consent/source/sync/category metadata. The incident's first bound context and content revision persist in SQLite and are immutable; subsequent dashboard refreshes do not rewrite it.

Bearer-authenticated `GET /api/patient-record` returns the current dashboard snapshot; optional `?incidentId=...` selects that incident's bound snapshot. `POST /api/patient-record/refresh` refreshes the dashboard/future context. `POST /api/patient-record/question` accepts `{question,revision,incidentId?}` and returns `{answer,generation,revision}`; it works before an incident, rejects changed revisions, and creates no incident event or message.

Authenticated `GET /api/incidents/:id/brief` exports local JSON with source-separated `hospitalRecords` (read-only synthetic Finch snapshot), `lifelineObservations` (local evidence, responder reports, timeline/outcome), and `summary` (text, clinical revision, individual handoff provenance). Historical vital dates are distinct from live evidence; responder reports are not hospital EHR entries or diagnoses. No Finch write-back or hospital submission is implemented. Legacy handoffs without generation provenance remain `unavailable`.

## Trial capture

Authenticated `POST /api/trials/start` accepts `{label,scenario}` and returns `TrialView`. Labels are 1–80 characters; scenarios are `standing`, `phone-drop`, `sit`, `bend`, `staged-fall`, or `other`. Start requires no active incident or recording. Paired capture resets detector history, clocks and cooldown while preserving a still-valid waist baseline; legacy phone capture resets its calibration. A fresh clock exchange follows the first accepted sample from each source. Standing tilt calibration is optional for the current paired detector.

Authenticated `POST /api/trials/stop` flushes capture; `TrialView.status` changes through `stopping` to `stopped`. Monitoring remains active. Authenticated `GET /api/trials/:id/download` returns raw JSONL; the current trial must be stopped. Snapshot includes the current trial's status, counts, elapsed timestamps, and stop/error reason. Files remain in private ignored `data/trials/`; the current trial view is process-local. Historical files may be incomplete after an interrupted capture; replay requires a final `trial.stop` marker.

Each `TrialRecord` contains host monotonic `atMs`, wall-clock `at`, event `type`, optional `source`, and optional `payload`. Version-2 paired headers identify WILi/waist capture, initial sessions and preserved calibration. Events retain both sample types, capabilities/range, clocks, resets, markers, assessments and stop reason. Legacy version-1 CoreMotion captures retain their original identity. Capture is limited to ten minutes or 100 MB; failures end capture explicitly. Current paired replay evaluates the combined prototype offline without sends; solo diagnostic comparisons remain pending. See [motion trials](motion-trials.md).

## Providers

Provider adapters live under `src/providers/`. Export from `src/providers/index.ts`:

- `providerStatus(): Record<string,{configured:boolean,detail:string}>`
- `loadHealth(): Promise<HealthContext>` (FinchNode keyless synthetic demo, errors explicitly unavailable)
- `buildHandoff(incident: Incident, health: HealthContext): Promise<string>` (AI-composed source-grounded plan; visibly degraded template on failure)
- `buildHandoffDetailed(incident: Incident, health: HealthContext): Promise<{text:string,generation:'ai'|'degraded',healthRevision?:string}>` (individual handoff provenance/revision, persisted with `HANDOFF_PREPARED`)
- `answerQuestion(incident: Incident, health: HealthContext, question: string): Promise<string>` (AI-composed source-grounded plan; explicit unknowns, no medical conclusions)
- `answerQuestionDetailed(incident: Incident, health: HealthContext, question: string): Promise<{text:string,generation:'ai'|'degraded'|'policy_refusal'}>` (per-answer provenance, independent of the global provider status)
- `answerPatientQuestionDetailed(health: HealthContext, question: string): Promise<{text:string,generation:'ai'|'degraded'|'policy_refusal'}>` (record-only questions without an incident)
- `sendMessage(phone: string, text: string, canSubmit?: () => boolean, options?: {replyToMessageId?:string,chatId?:string,lineId?:string}): Promise<ProviderResult>` (Photon cloud; missing credentials yields failed, ended authorization yields cancelled before submission; bound replies require exact persisted target/chat/line)
- `startPhotonListener(handler: (event: ProviderInbound) => Promise<void>): Promise<() => Promise<void>>`
- `prepareCheckinAudio(): Promise<Uint8Array | null>` (ElevenLabs; no key yields null)

Provider env names: `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `LIFELINE_LLM_API_KEY`, `LIFELINE_LLM_BASE_URL`, `LIFELINE_LLM_MODEL`. Use built-in fetch where possible. Declare Spectrum dependencies in the root package manifest. Tests must not send real messages.

`ProviderInbound` preserves sender/message/target plus native `chatId`, opaque sending `lineId`, and optional `providerTimestamp` milliseconds. `ProviderResult` accepted sends include native message/chat/line IDs; actions persist provider and reply bindings, while public snapshots omit chat/line identifiers. Server routing requires configured wearer/responder identity and a persisted accepted current-incident conversation. LLM proposals never directly mutate state. All provider calls occur outside SQLite transactions. The backend handles worker leases and unknown outcomes.

Responder Q&A first persists the approved original question, inbound event/channel, incident version and `QUESTION_RECEIVED` audit. The listener returns without waiting for inference. A separate bounded worker prepares one persisted job, dedupes concurrent deliveries, recovers interrupted claims, and limits preparation to three attempts. Answer provenance, reply bindings, outbox, inbound dedupe and `ANSWER_QUEUED` commit atomically after generation. Receipt/preparation never establishes answer delivery. Explicit stale/foreign targets or codes and declined/uncontacted identities are rejected. A version change discards the prepared answer; queued answers lose permission after progress, decline or closure. Failed pre-submission sends retry; unknown submissions do not. Only alert targets authorize 👍 acceptance. Constrained progress phrases such as `leaving` and `arrived` need a current message target or one exact incident code plus the bound channel; only the assigned owner advances departure/arrival, and only an on-scene owner resolves with a concrete outcome. Reports retain original text and provider time. No groups, miniapps or edited status bubbles are implemented.

Authenticated `POST /api/context/question` accepts `{incidentId,question}` for the latest displayed incident, including a terminal phase, using its immutable bound clinical snapshot. It returns `{incidentId,version,answer,generation}` without creating an action or changing incident history. Concurrent previews and context changes during generation return a conflict. This is a local rehearsal, not a responder conversation or proof of phone receipt.

The listener returns its stop handle before startup succeeds. Startup and ended/failed iterators retry with exponential backoff (1–30 seconds by default); idle subscribed streams do not time out. Shutdown stops dispatch/recovery and bounds waits. Incomplete SDK teardown blocks replacement clients and remains visible in status.
