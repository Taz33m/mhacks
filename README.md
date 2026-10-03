# LIFELINE

MHacks 2026 — Actually Intelligent (AI). LIFELINE combines read-only patient records, conversational coordination, and an incident loop followed through responder acceptance, progress, and a recorded outcome. Falls are the first intended physical trigger. The iPhone is the Photon/iMessage communication channel. The [product requirements](docs/PRD.md) define the demo scope, policy, and acceptance gates.

**Current implementation:** structured Finch synthetic records, record questions, immutable incident context, threaded Photon replies, wearer updates, and source-separated care-brief export are implemented. The iPhone app is communication only. The connected original FREE-WILi uses its official stock SDK for acceleration, display, help/okay buttons and board audio. A provisional WILi + waist-AirPod detector and bounded local microphone transcription are implemented; physical sensing accuracy and end-to-end messaging still require rehearsal. See the [migration plan](docs/device-and-record-migration.md). Camera work is out of scope.

## Start

Requires Node 24+ and npm. Native builds require Xcode on macOS.

```sh
npm ci
npm run setup:local
npm start
```

`setup:local` creates a private `.env` for phone access on the development network, pairs the Mac app without printing its token, and builds/installs it in `~/Applications`. Existing environment settings are preserved. Connect the AirPods and start motion in the installed app.

Open **http://127.0.0.1:8877**. The dashboard shows real source availability, incident state, provider configuration, and explicitly labelled development controls. Trigger a synthetic incident or manual help, accept as a development responder, report departure/arrival, and record an outcome. These controls simulate authenticated actors for development; they are not production identity verification.

For the accelerated silence demo, use `npm run start:demo`. New check-ins use five seconds and display the acceleration from the normal configurable policy. Existing persisted deadlines stay intact. Positive or ambiguous wearer messages preserve the existing deadline; only the explicit current-check-in control cancels before escalation.

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

For phone-to-Mac access, run with `LIFELINE_HOST=0.0.0.0 npm start` on a trusted development network. Visit the dashboard from this Mac to obtain the pairing token and LAN address, then enter them in the native apps. The server's default binding is local-only. Test venue connectivity before relying on it. Keep the phone app foregrounded. The reporting AirPod is mounted at the waist. FREE-WILi is the primary body sensor; the original v54 board is connected through the [stock SDK bridge](native/freewili/README.md). Start with chest placement for access to its buttons and speaker. The phone supplies no motion or audio. Standing tilt calibration is optional for the AirPod; the provisional detector uses acceleration and rotation without requiring that baseline.

See [native setup](docs/native-setup.md) for off-ear acquisition, reporting-bud checks, audio routing, and device installation. Native apps never substitute simulated sensor input.

For the wired demo with the paired Debug app installed, keep the iPhone unlocked
and connected by USB, then run `npm run device:usb -- DEVICE_UDID` alongside the
backend. This starts a foreground relay on the connected device's developer
tunnel and launches the communication companion without changing saved Wi-Fi pairing. Keep the
cable and helper connected for status access.

## Providers

Copy `.env.example` to `.env` and configure only the integrations being used. Photon uses its cloud provider; responders must have approved phone numbers in `LIFELINE_RESPONDERS_JSON`. Approved phone identity, the persisted native chat/line and the alert's provider message ID determine who can accept. Exact incident-coded text commands are `ON IT`, `DEPART`, `ARRIVED`, `DECLINE`, or `RESOLVED`, followed by the full incident ID; resolution also requires an outcome. Removed reactions do not release ownership.

Set `LIFELINE_WEARER_PHONE` to the approved wearer's E.164 number to send a companion Photon iMessage: “I detected a possible fall. Are you okay?” It shares the incident deadline. Audible interaction belongs to the WILi audio path; the phone does not speak or listen. The wearer can reply to that message with “I need help,” or send `I NEED HELP LF-XXXXXXXX` using the full current incident ID. Positive or ambiguous replies preserve the check-in; cancellation still requires an explicit green board button or phone control. Wearer and responder numbers must differ. The dashboard tracks wearer iMessage configuration and the actual send outcome.

FinchNode handoffs retain synthetic source record IDs. AI is required for the judged demo: it composes incident-relevant handoffs and answers through source-field selection and explicit unknowns. Application code renders the cited facts; AI cannot clear an incident, invent a clinical claim, or change ownership. Unconfigured/failed AI visibly degrades to templates and does not pass the AI demo gate.

The stock WILi bridge plays seven cached 8 kHz PCM prompts and captures a bounded microphone utterance after the check-in prompt. Local Whisper on the Mac transcribes 16 kHz resampled audio; set an absolute `LIFELINE_WHISPER_MODEL` path and optionally `WHISPER_CLI` in the private `.env`. See the [board audio setup](native/freewili/README.md). Cached assets retain their generation source; local speech is not an ElevenLabs demonstration. Provider generation, board command acceptance, audibility, and recognized speech are separate verification steps.

To prepare the seven board prompts with ElevenLabs, set `ELEVENLABS_API_KEY` and run `npm run prepare:wili:elevenlabs`. `ELEVENLABS_VOICE_ID` and `ELEVENLABS_MODEL_ID` are optional overrides. `npm run prepare:wili:local` explicitly selects the macOS speech fallback. A matching verified local cache avoids new provider calls; failure preserves the previous assets and does not silently change their source. Inspect the preparation manifest and rehearse board playback before claiming a live ElevenLabs demonstration.

Replies to the current bound alert/status may use exact phrases such as “on my way,” “I’m here,” and “resolved: <outcome>.” The owner and phase rules still apply; broader inferred intent and ETAs do not change state.

The protected **Patient record** view shows demographics, medications, conditions, allergies and dated historical vitals. Ask record questions before an incident or against its immutable revision. Use Record context to switch between the current patient record and the saved incident snapshot. Refresh changes the current record only. **Download care brief** exports Finch facts separately from LIFELINE observations and responder reports; it does not write to a hospital EHR.

Details: [provider setup](docs/providers.md).

Use **Local AI rehearsal** in **Responder questions** to preview a grounded answer against the latest incident without sending a message. Answers display source record IDs and distinguish validated AI generation, a degraded template, and a policy refusal. Actual responder exchanges appear separately with their original question and persisted delivery result.

Local AI can run through Ollama with `npm run ai:local`; see [local model configuration](docs/providers.md) for the model and private environment settings.

## Motion trials

The **Legacy / waist recorder** preserves the existing motion capture/replay format. WILi acquisition is separately recorded under its actual source identity; it is not included in legacy trial replay; the separate provisional WILi assessment freezes acceleration and corroborating waist features in incident evidence. Optional tilt calibration and physical comparison trials do not block the initial incident loop; physical accuracy remains unvalidated. Stopping capture leaves incident response running.

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

The default runtime accepts WILi and waist-AirPod acquisition, and rejects chest-phone motion and phone speech. WILi usability means acquisition quality. The provisional cross-body detector requires usable WILi acceleration plus aligned waist movement and subsequent quiet. Stock ±2 g measurements use a provisional 1.65 g threshold and gateway host-receipt timing; board capture time is unknown and clipping is excluded. The separate wider-range custom firmware profile retains its 2.5 g threshold. Actual accuracy remains unvalidated. The old iPhone detector and replay fixtures remain available explicitly with `LIFELINE_LEGACY_PHONE=1`, preserving historical source labels.

Automated tests and simulator compilation do not establish physical board sensing/audio or actual Photon receipt. Approved wearer/responder numbers and a live rehearsal are still needed. The patient view uses a fictional Finch synthetic subject, explicitly separate from the real wearer; sandbox Connect and real-patient authorization are pending.
The controller, native clients, dashboard, and providers use the shared [interfaces](docs/interfaces.md). See the [development plan](docs/development-plan.md) and [reference architecture](docs/LIFELINE-reference-architecture.md).
