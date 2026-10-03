# Provider adapters

`src/providers/index.ts` exports the interfaces agreed in `docs/interfaces.md`. `createProviders` injects environment, fetch, time, and a small Photon client for offline tests. No adapter changes incident state or authorizes a responder.

## Configuration

| Provider | Environment | Behavior without configuration |
| --- | --- | --- |
| Photon cloud | `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET` | Send returns `failed`; listener stays inactive |
| FinchNode | None | Reads only the public synthetic `patient-demo-001` fixture |
| ElevenLabs | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | Returns no audio |
| OpenAI-compatible model | `LIFELINE_LLM_API_KEY`, `LIFELINE_LLM_BASE_URL`, `LIFELINE_LLM_MODEL` | Uses visibly degraded templates; the judged AI requirement remains unmet |

The model base URL is the API prefix, such as `https://provider.example/v1`; the adapter appends `/chat/completions`. Requests require HTTPS, except localhost development. Set server-side API credentials in `.env`.

Status `configured` means configuration exists, not that a live integration has passed. The detail records lookup/preparation/listener failures. SDK errors, credentials, incoming bodies, and recipient numbers are not copied into status details.

For setup, configure a managed Photon cloud line and the two Spectrum project values; add approved E.164 responders through `LIFELINE_RESPONDERS_JSON`. Confirm an actual incoming text and reaction from those phones. For ElevenLabs, use a key with text-to-speech access and an existing voice ID. A failed preparation returns no clip and remains cached for that process; after fixing configuration, restart to prepare it once. FinchNode needs no credential. The AI model needs an API key, an API base URL, and the exact model name; an invalid response falls back to source fields and leaves the AI demo requirement unmet. Check provider detail alongside `configured`; a configured provider can be unavailable.

For the wearer side, set `LIFELINE_WEARER_PHONE` to the approved E.164 phone, distinct from every responder. The phone still plays the audible check-in; a persisted `wearer_checkin` action sends the companion iMessage through Photon. These channels share one check-in ID and deadline. The wearer send has its own worker slot, so it cannot block responder alerts. Queued/failed check-in messages stop at escalation or cancellation; a send already submitted may finish later, with its actual outcome recorded.

Wearer replies require the complete configured phone identity and either the current check-in's persisted provider message target or the exact full current incident ID at the end of the text. An explicit stale target cannot be rescued by a newer incident code. Exact help escalates; positive text queues a persisted `wearer_ack` directing the wearer to the explicit phone cancel control. Ambiguous text preserves the deadline. Acknowledgements use the wearer lane and can receive a correlated help reply; they stop being eligible at cancellation/escalation/the original deadline. Reactions never cancel a check-in. Inbound IDs, audit events, acknowledgements, and state changes commit together. Live wearer receipt/replies still need validation on configured phones.

## Photon

Use `@spectrum-ts/core@12.10.1` and `@spectrum-ts/imessage@12.10.1`; cloud discovery renews line tokens. [Official cloud setup](https://photon.codes/docs/spectrum-ts/providers/imessage)

The adapter resolves an E.164 user, opens a DM, rechecks the outbox action's current authorization, and sends once. Authorization ending during chat preparation returns `cancelled` before submission. A returned message ID becomes `provider_accepted`, which does not establish recipient delivery. An exception or missing ID after the send begins returns `unknown`. No adapter retries; the persisted worker owns reconciliation/retry policy. [Official send and DM interfaces](https://photon.codes/docs/spectrum-ts/spaces-and-users)

Inbound mapping preserves `message.sender.id`, `message.id`, and reaction/reply `content.target.id`. Outbound echoes and actor-less messages are ignored. Only incoming 👍 reactions are forwarded as possible acceptance evidence; text is relayed without interpretation. The controller must match the approved responder and the persisted alert ID before accepting anything. [Official inbound shapes](https://photon.codes/docs/spectrum-ts/messages), [tapback aliases](https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features/tapback-reactions)

**Removal limitation:** inspection of the published 12.10.1 cloud source found normalization for `message.reactionAdded`, without a `reactionRemoved` arm. The adapter reports `removed:true` when explicit `reactionRecord.selected:false` or a nested reaction `unsend` is supplied, but general removal delivery is unverified. Never treat disappearance or silence as a decline. Test actual alert → 👍 on the demo phones. Use an explicit incident-coded decline to relinquish responsibility.

The listener returns a stop callback before startup succeeds, and retries connection failures or ended/failed iterators with exponential backoff from 1 to 30 seconds. Successfully handled recent message IDs are suppressed in memory across reconnections; persisted controller dedupe remains the authority across restarts. Listener diagnostics remain visible alongside outbound send status. Idle subscribed streams do not expire merely because no message arrives.

The stop callback stops dispatch/recovery, closes Spectrum once, and bounds cleanup waits. SDK initialization cannot be forcibly cancelled; a late client is stopped when it resolves. Incomplete teardown blocks replacement clients and reports unavailable recovery. SDK startup and send calls have bounded waits; a timed-out send may still complete remotely, so an unknown action must not be blindly resent. SDK telemetry is disabled.

Actionable alerts and phase updates include the exact acceptance/decline, departure, arrival, and resolution commands appropriate to that phase. Context-only handoffs do not repeat acceptance instructions. Responder questions must come from an eligible contacted phone for the active incident. Explicit stale/foreign targets or incident codes cannot fall through to a question about a newer incident.

Replies enter the same persisted outbox as responder alerts. Generation occurs outside the transaction; only a current-version answer commits with the inbound ID and audit event. Generation interrupted before that commit requires inbound redelivery; it is not a durable generation job. Each distinct question queues separately, duplicates commit once, pre-submission failures retry, and unknown sends require reconciliation. Authorization is checked again before submission; phase changes, decline, or closure invalidate old answers. Actual reply receipt and the sourced live question/answer still need demo-phone validation.

## FinchNode and grounded responses

Read `https://api.finchnode.com/demo/v1/users/patient-demo-001/records?categories=medications,conditions,allergies` without a key. Require the response to identify itself as synthetic/demo. Retain raw records internally for up to eight contexts, indexed by retrieval timestamp and record IDs. The public context contains source-linked field summaries and retrieval time; it does not contain the raw response. This cache is process-local. After restart, retrieve a new context before model-assisted Q&A. [Official demo reference](https://finchnode.com/docs/api/demo)

Fixture dates and consent/synchronization are simulated. Empty categories say “no records returned”; absent data does not establish no medications, conditions, or allergies. Lookup failures return unavailable and never block escalation.

JSON reads are capped at 1 MB before parsing. Each returned record needs a unique ID, the category's text label, and nullable text fields for displayed status/dosage/reaction data. Malformed nested values invalidate the context instead of being silently omitted from an apparently available handoff.

AI is required for the judged handoff and Q&A. The model receives the physical incident context and synthetic records, then generates a structured plan: source record IDs and fields in relevance order, selected incident facts, and explicit unavailable information. Application code renders those source values and IDs. A selected absent record field says “not returned; unknown.” Unknown IDs, field names, or invalid plans visibly degrade to templates and leave the AI demo gate unmet. Treatment and diagnosis questions receive an explicit limitation. Models have no tools to mutate phase, assign ownership, clear a check-in, or send messages.

The console pairs recorded responder questions with their persisted answer and delivery result. Each answer records its own provenance: validated AI output, degraded template, or policy refusal. Older entries without that audit data remain explicitly unavailable. **Local AI rehearsal** uses the latest incident and synthetic records through the same answer adapter, including after closure. It creates no message or incident event; its labelled preview does not establish live responder receipt.

## ElevenLabs

Prepare a fixed check-in with `POST /v1/text-to-speech/{voice_id}?output_format=mp3_44100_128`, the `xi-api-key` header, and `eleven_multilingual_v2`. Return the MP3 bytes; the server owns the authenticated audio route. Preparation is cached once per process, including a failure, so a polling phone does not generate repeated paid clips. [Official conversion API](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)

The normal clip says: “I detected a possible fall. Do you need help? You can say I need help, or tap I don't need help to cancel.” The explicit five-second demo profile prepares “I detected a possible fall. Are you okay?” Spoken text cannot clear an incident; the controller handles the explicit cancellation control. A positive spoken reply receives native spoken acknowledgement directing the wearer to that control; it creates no paid voice request and preserves the original deadline. The response must be a successful `audio/mpeg` body with an MP3 signature. Header and streamed body sizes are bounded to 5 MB; JSON errors, empty output, and a different audio format produce no clip.

Offline tests inject fetch/SDK clients. They make no real message sends or speech/model generations. Public synthetic fixture lookup was read during implementation to confirm its schema; paid/authenticated integration remains to be verified with configured credentials.
