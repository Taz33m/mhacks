# Provider adapters

`src/providers/index.ts` exports the interfaces agreed in `docs/interfaces.md`. `createProviders` injects environment, fetch, time, and a small Photon client for offline tests. No adapter changes incident state or authorizes a responder.

## Configuration

| Provider | Environment | Behavior without configuration |
| --- | --- | --- |
| Photon cloud | `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET` | Send returns `failed`; listener stays inactive |
| FinchNode | None | Reads only the public synthetic `patient-demo-001` fixture |
| ElevenLabs | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | Returns no audio |
| OpenAI-compatible model | `LIFELINE_LLM_API_KEY`, `LIFELINE_LLM_BASE_URL`, `LIFELINE_LLM_MODEL` | Uses record-grounded templates |

The model base URL is the API prefix, such as `https://provider.example/v1`; the adapter appends `/chat/completions`. Requests require HTTPS, except localhost development. Set server-side API credentials in `.env`.

Status `configured` means configuration exists, not that a live integration has passed. The detail records lookup/preparation/listener failures. SDK errors, credentials, incoming bodies, and recipient numbers are not copied into status details.

## Photon

Use `@spectrum-ts/core@12.10.1` and `@spectrum-ts/imessage@12.10.1`; cloud discovery renews line tokens. [Official cloud setup](https://photon.codes/docs/spectrum-ts/providers/imessage)

The adapter resolves an E.164 user, opens a DM, and sends once. A returned message ID becomes `provider_accepted`, which does not establish recipient delivery. An exception or missing ID after the send begins returns `unknown`. No adapter retries; the persisted worker owns reconciliation/retry policy. [Official send and DM interfaces](https://photon.codes/docs/spectrum-ts/spaces-and-users)

Inbound mapping preserves `message.sender.id`, `message.id`, and reaction/reply `content.target.id`. Outbound echoes and actor-less messages are ignored. Only incoming 👍 reactions are forwarded as possible acceptance evidence; text is relayed without interpretation. The controller must match the approved responder and the persisted alert ID before accepting anything. [Official inbound shapes](https://photon.codes/docs/spectrum-ts/messages), [tapback aliases](https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features/tapback-reactions)

**Removal limitation:** inspection of the published 12.10.1 cloud source found normalization for `message.reactionAdded`, without a `reactionRemoved` arm. The adapter reports `removed:true` when explicit `reactionRecord.selected:false` or a nested reaction `unsend` is supplied, but general removal delivery is unverified. Never treat disappearance or silence as a decline. Test actual alert → 👍 on the demo phones. Use an explicit incident-coded decline to relinquish responsibility.

The stop callback closes Spectrum. SDK startup and send calls have bounded waits; a timed-out send may still complete remotely, so an unknown action must not be blindly resent. SDK telemetry is disabled.

## FinchNode and grounded responses

Read `https://api.finchnode.com/demo/v1/users/patient-demo-001/records?categories=medications,conditions,allergies` without a key. Require the response to identify itself as synthetic/demo. Retain raw records internally for up to eight contexts, indexed by retrieval timestamp and record IDs. The public context contains source-linked field summaries and retrieval time; it does not contain the raw response. This cache is process-local. After restart, retrieve a new context before model-assisted Q&A. [Official demo reference](https://finchnode.com/docs/api/demo)

Fixture dates and consent/synchronization are simulated. Empty categories say “no records returned”; absent data does not establish no medications, conditions, or allergies. Lookup failures return unavailable and never block escalation.

The optional model selects existing record IDs in relevance order. Unknown IDs or invalid output cause a fallback. Responses render original record fields with their IDs, rather than model-authored clinical prose. Treatment and diagnosis questions receive an explicit limitation. Models have no tools to mutate phase, assign ownership, clear a check-in, or send messages.

## ElevenLabs

Prepare a fixed check-in with `POST /v1/text-to-speech/{voice_id}?output_format=mp3_44100_128`, the `xi-api-key` header, and `eleven_multilingual_v2`. Return the MP3 bytes; the server owns the authenticated audio route. Preparation is cached once per process, including a failure, so a polling phone does not generate repeated paid clips. [Official conversion API](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)

Offline tests inject fetch/SDK clients. They make no real message sends or speech/model generations. Public synthetic fixture lookup was read during implementation to confirm its schema; paid/authenticated integration remains to be verified with configured credentials.
