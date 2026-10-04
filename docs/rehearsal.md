# One-phone LIFELINE rehearsal

Use this when the teammate is unavailable: the wearer's phone and FREE-WILi are real, while Maya is a clearly labelled local simulated responder. No responder phone is contacted. Maya's acceptance, departure, arrival, and outcome are scripted; they are not human reports, real travel, or a real patient assessment. Do not display simulated GPS or provider receipts.

The clinical context remains the fictional Finch demo patient. It is not linked to the wearer's personal medical record. Exact wearer statements and captured motion evidence are separate LIFELINE observations.

Start the backend in simulated dispatch mode with `npm run start:dispatch`. This preserves the configured wearer/Photon path and substitutes `demo-maya`, whose phone is null, for the live responder list. Finish or explicitly end an existing active incident before changing dispatch mode. The approved real responder configuration can remain private and is not used by this mode. Start the physical bridge through the existing `npm run device:freewili` setup; this document does not provision or flash hardware.

Before the run, verify the console says simulated dispatch, shows Maya without a configured phone, and shows current physical WILi/AirPod connections. Confirm the board can play the prepared prompt and the wearer phone is using the actual assigned messaging conversation. A configured provider or a `provider_accepted` outbox row does not prove recipient delivery. Observe the actual new message on the wearer phone. An unknown result stays unknown and must not be retried automatically.

Use normal check-in timing for the spoken rehearsal. `npm run start:dispatch` does not shorten the response window; the explicit `LIFELINE_DEMO_MODE=1` profile shortens it to five seconds and can expire before capture and transcription finish.

1. From idle, press YELLOW once to start the wearable rehearsal, then release it. This starts a labelled synthetic fall check-in through the actual device/backend protocol. No calibration or dashboard operator is required. It does not claim that the physical detector measured a fall. The normal sensing path can also start a check-in.
2. Let the WILi prompt finish. When its check-in microphone is listening, say: “I fell pretty hard. My ankle hurts and I can't stand up.” The stored transcript is the actual recognition result, with `freewili-local-speech` provenance. Do not replace it with the intended script.
3. Check that the incident requests help and preserves the exact recorded statement in the local log and initial alert. AI handoff generation must not delay the literal statement or turn it into a diagnosis.
4. Maya accepts automatically. The wearer notice attributes the reply to Maya, and the same reply enters the board's speech queue. Local dispatch provenance remains recorded in the incident metadata. Acceptance does not mean departure or safety.
5. Maya reports departure and then arrival. The departure line is “I'm coming downstairs now. Don't try to stand.” The board speaks the attributed local simulation and the wearer notices carry that attribution. No real responder message or location is being claimed.
6. Maya records an explicitly simulated outcome. Inspect the resolved incident and care brief: the original wearer words remain unchanged, clinical source records remain separate, and the outcome says no real arrival or patient assessment is claimed.

RED is an explicit request for help and skips the normal confirmation window. In the current stock bridge, automatic microphone capture starts from the `CONFIRMING` check-in prompt; RED by itself is not a verified post-help voice-recording path. It can rehearse help → Maya progress → outcome. BLUE is the separate everyday wellbeing conversation and is disabled during an active incident.

YELLOW is enabled only in idle simulated dispatch. In live mode it has no rehearsal action. Holding it across startup or an audio upload does not replay a press. The protocol and generated button-to-voice-to-resolution loop have offline tests; the first physical YELLOW press still needs observation in the actual rehearsal.

Maya's normal pacing is:

| Transition | Default delay |
| --- | --- |
| Help requested → accepted | 4 seconds |
| Accepted → departing | 8 seconds |
| Departing → on scene | 16 seconds |
| On scene → resolved | 12 seconds |

These delays use the incident's latest update time. A newly prepared handoff can shift that time. Acceptance requires a locally delivered simulated alert. Acceptance, departure, and arrival do not wait for wearer phone delivery or voice acknowledgments. Resolution waits for queued/playing responder speech, with at most 30 additional seconds; missing playback is recorded honestly rather than assumed audible.

Avoid `LIFELINE_SIMULATED_STEP_MS=1000` for the phone rehearsal: four fast phases can finish before the wearer lane's default five-second gap permits its next message. Obsolete acceptance/departure/arrival notices then cancel, leaving only the latest eligible notice. Normal pacing permits each phase update, but a slow or unknown real send can still prevent receipt. Read the phone and playback evidence separately from the simulated timeline.

After the loop, the console can rehearse: “What medications and allergies are recorded, and do we have current vital signs?” The answer must retain both requested record categories and their source IDs, report current vitals as unavailable, and keep historical Finch vital measurements dated. Its generation label is actual `ai`, `degraded`, or `policy_refusal`; a fallback must not be presented as verified AI. This console question is not a simulated native message from Maya.

When a human responder is available again, live dispatch uses their approved exact conversation. Accept with 👍 on the current alert or `ON IT <incident ID>`, then `DEPART <incident ID>`, `ARRIVED <incident ID>`, and `RESOLVED <incident ID> <concrete outcome>`. A plain natural progress phrase requires a native reply target. Never relabel this one-phone fallback as a completed human responder rehearsal.
