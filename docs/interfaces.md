# Shared implementation interfaces

Server: Node 24, HTTP/WebSocket port **8877** (avoids Kinesthetic). Runtime modules use `.ts` imports; no compilation required. Types are in `src/contracts.ts`. Dependencies are managed in the root package manifest.

## Native producers

Connect `ws://HOST:8877/motion?source=waist-airpod&token=TOKEN` or `source=chest-phone`. Token is a persistent development pairing token (shown only via localhost setup); production enrollment is outside this slice. Send `MotionSample`: CoreMotion `sensorTime` in seconds, quaternion xyzw, rotation rad/s, gravity and user acceleration in g. Reporting bud identity must be preserved. Source and session stay stable on a connection; reconnect starts a new session.

Server sends `ClockPing` approximately every two seconds. Respond with `ClockPong`, echoing `id` and current session, and stamping receipt/send with device monotonic uptime in milliseconds. Native clients must run a WebSocket receive loop. Send backoff/dropped samples must not fabricate continuity.

`GET /health` returns `{status:'ok', motionSources:['waist-airpod', ...]}` for recent producer samples. Native bridge verification uses this, rather than Kinesthetic player/game health. `GET /api/checkin` with `Authorization: Bearer TOKEN` returns `{incident, audioUrl}`; iPhone displays current check-in and plays each checkinId once. `POST /api/commands` cancellation uses the same token and current IDs. Audio URL is `/api/audio/checkin` (if prepared; otherwise null), authenticated using the token; iPhone can use native speech as a clearly indicated development fallback.

## Dashboard

Static files owned under `public/`. `GET /api/state` returns `Snapshot`; WebSocket `/live` pushes full snapshots, at most 10 Hz. GET state and live view are read-only. `POST /api/commands` receives `Command`, returning `{ok:true}` or `{error:string}`. Commands require bearer token; localhost dashboard can obtain it through `GET /api/setup` which returns `{token, port, addresses}` and is rejected for non-loopback clients. No token in logs, recordings, or public snapshots. Clearly label trigger/responder buttons as development simulation; actor identity on those controls is operator simulation, not production identity proof.

## Phone check-in replies

The phone can POST a final spoken reply to `/api/checkin/reply` with bearer authentication and `{incidentId,checkinId,transcript,source:"ios-on-device-speech"}`. A transcript is 1–500 characters and must target the current confirming check-in before its deadline. The response is `{decision:"help_requested"|"confirmation_required"|"unresolved"}`. Help escalates immediately; every other decision preserves the incident/deadline. Positive replies require explicit cancellation. `CHECKIN_REPLY` timeline details contain JSON `{transcript,decision}` with the declared source as actor. `GET /api/checkin` also supplies `serverTime` and approved responder names (no phone numbers).

Local `/api/setup` includes `lanEnabled` based on the actual listener address. Advertised addresses do not prove phone reachability.

Snapshot `wearerMessaging:{configured,detail}` reports companion Photon configuration without exposing the wearer phone. `wearer_checkin` and `wearer_ack` actions (null recipient) belong to the configured wearer; existing `checkin` actions are phone audio and never claimed by the messaging worker. Photon wearer replies are routed internally after full-phone and message/incident correlation, then recorded as `CHECKIN_REPLY` with actor `photon-imessage`. Positive replies queue acknowledgements atomically with inbound dedupe, without cancelling or extending the check-in. The native REST reply endpoint still accepts only `ios-on-device-speech`; it cannot impersonate Photon events. The phone speaks a native positive acknowledgement. Both channels use the same incident/check-in deadline and explicit cancellation boundary.

Snapshot and `/api/checkin` include `policy:{demoMode,checkinMs,configuredCheckinMs}`. The explicit demo profile accelerates new check-ins to five seconds; the metadata never replaces a persisted active incident deadline. The phone selects the short demo prompt and displays the acceleration when configured.

## Trial capture

Authenticated `POST /api/trials/start` accepts `{label,scenario}` and returns `TrialView`. Labels are 1–80 characters; scenarios are `standing`, `phone-drop`, `sit`, `bend`, `staged-fall`, or `other`. Start requires no active incident or recording. It resets detector calibration, buffers, clock estimates, and cooldown, then requests a fresh clock exchange after the first accepted sample from each source. Mount and calibrate after starting.

Authenticated `POST /api/trials/stop` flushes capture; `TrialView.status` changes through `stopping` to `stopped`. Monitoring remains active. Authenticated `GET /api/trials/:id/download` returns raw JSONL; the current trial must be stopped. Snapshot includes the current trial's status, counts, elapsed timestamps, and stop/error reason. Files remain in private ignored `data/trials/`; the current trial view is process-local. Historical files may be incomplete after an interrupted capture; replay requires a final `trial.stop` marker.

Each `TrialRecord` contains host monotonic `atMs`, wall-clock `at`, event `type`, optional `source`, and optional `payload`. The version-1 header identifies the trial and initially connected sources. Events preserve accepted motion packets, sent pings/accepted pongs, successful calibration sources, detector resets, connections, assessment calls/results, and stop reason. Capture is limited to ten minutes or 100 MB; storage failures or backpressure end capture explicitly. Replays run offline and never issue incident commands.

## Providers

Provider adapters live under `src/providers/`. Export from `src/providers/index.ts`:

- `providerStatus(): Record<string,{configured:boolean,detail:string}>`
- `loadHealth(): Promise<HealthContext>` (FinchNode keyless synthetic demo, errors explicitly unavailable)
- `buildHandoff(incident: Incident, health: HealthContext): Promise<string>` (AI-composed source-grounded plan; visibly degraded template on failure)
- `answerQuestion(incident: Incident, health: HealthContext, question: string): Promise<string>` (AI-composed source-grounded plan; explicit unknowns, no medical conclusions)
- `sendMessage(phone: string, text: string, canSubmit?: () => boolean): Promise<ProviderResult>` (Photon cloud; missing credentials yields failed/unconfigured, ended authorization yields cancelled before submission)
- `startPhotonListener(handler: (event: ProviderInbound) => Promise<void>): Promise<() => Promise<void>>`
- `prepareCheckinAudio(): Promise<Uint8Array | null>` (ElevenLabs; no key yields null)

Provider env names: `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `LIFELINE_LLM_API_KEY`, `LIFELINE_LLM_BASE_URL`, `LIFELINE_LLM_MODEL`. Use built-in fetch where possible. Declare Spectrum dependencies in the root package manifest. Tests must not send real messages.

The server maps inbound phone IDs only to configured approved responders and correlates target message IDs through persisted actions. LLM proposals never directly mutate state. All provider calls occur outside SQLite transactions. The backend handles worker leases and unknown outcomes.

Responder Q&A queues an `answer` action in the responder lane. The inbound ID, queued action, and audit event commit atomically after generation; generation itself is not a persisted job. Each distinct question can queue a reply in the same phase. Explicit stale/foreign targets or codes and declined/uncontacted identities are rejected. A version change during preparation discards the answer; pending answers become ineligible after progress, decline, or closure. Failed pre-submission sends retry through the normal outbox; unknown submissions do not. Only alert targets authorize tapback acceptance; replies to current status/handoff/answer messages can correlate a question without authorizing ownership.

The listener returns its stop handle before startup succeeds. Startup and ended/failed iterators retry with exponential backoff (1–30 seconds by default); idle subscribed streams do not time out. Shutdown stops dispatch/recovery and bounds waits. Incomplete SDK teardown blocks replacement clients and remains visible in status.
