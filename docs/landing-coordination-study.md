# LIFELINE — coordination sequence, made explicit

4 October 2026. Design study; no operational messaging or incident policy changes.

The footage already establishes a person, loss of balance, braced contact, and a wearer waiting. The missing sequence is the information between that person and the responder. Compose this in the browser rather than generating legible phone text inside footage. Keep the last frame and its continuous film-to-card transition.

## What the current product actually supports

The wearer and each approved responder have separate, correlated iMessage conversations. The controller owns the incident and relays attributed reports and state updates. It contacts up to two eligible responders per round; the first valid acceptance establishes one owner. A grounded record question can precede acceptance. Acceptance is distinct from departure; only the owner reports departure, arrival, and an outcome.

`src/providers/photon.ts` explicitly rejects group spaces for bound outbound conversations and replies. An actual shared incident group is a proposed extension, not an existing capability. An HCP is not a distinct runtime permission role. A clinician in the study would be an explicitly approved human responder, not an autonomous clinical agent.

## Exact story and dialogue

Liam, Maya, and Dr. Chen are fictional film characters. The medication example is taken from the saved real-Finch synthetic rehearsal for Morgan Rivera, not a medical record belonging to Liam or the real demonstration wearer. Do not add a left/right ankle claim when the speaker only said “my ankle.” Human judgments stay attributed to the human; AI does not diagnose an injury or choose a treatment.

| Beat | Visible event | Words / evidence | State or consequence |
| --- | --- | --- | --- |
| Wearable speaks first | Hold the seated wearer, then reveal WILi's voice in left negative space. | **“Liam, I'm here. Do you need help?”** | Suspected incident; checking in. This warmer line is proposed film copy; current cached board wording remains unchanged. |
| Wearer requests help | A restrained waveform and exact words enter. | **“I fell. I can't stand up. My ankle hurts. I need help.”** | Explicit help requests escalation; wording is not classified into a diagnosis. |
| Context becomes legible | Words compress into three attributed labels; the original quote stays available. | **Help requested · Unable to stand (reported) · Ankle pain (reported)** | Explain what was heard, without inventing an injury or treating silence as reassurance. |
| Outreach | A message becomes a DOM phone screen; keep the wearer's image underneath during the move. | **LIFELINE: “Liam requested help after a possible fall. He says he can't stand and his ankle hurts. Can you respond?”** | Help requested; nobody owns the response yet. |
| Record question | One incoming human question, one answer; no busy chat stack. | **“What medications are recorded?”** | A contacted, approved responder asks for documented facts. |
| Grounded answer | The answer's evidence travels with its bubble, rather than appearing as a mysterious EHR card. | **“The synthetic demo record lists active Lisinopril 10 mg and Metformin 500 mg.”** Sources: `rec_1e13908b4661e1c29b507bf9`, `rec_a81e05c4c049bf549c1e4fc5`. | Recorded facts, not directions to take or administer medication. The film labels this as a synthetic record example. |
| Human next step | Shared-room version only: the clinician asks for a person to respond. | **Dr. Chen: “Maya, can you go to Liam?”** | A human coordination request; no assignment until Maya explicitly accepts. No diagnosis or medication advice. |
| Explicit acceptance | Maya's message and the ownership label appear together. First restrained spectral bloom; other contacted responder recedes. | **Maya: “I'll take this. ON IT LF-DEMO.”** | **Maya accepted · departure not confirmed.** First valid acceptance wins. |
| Departure | Separate bubble; ownership connection remains solid. | **Maya: “I'm on my way.”** | **Maya en route.** A departure report, not an arrival or resolved incident. |
| Physical action | Pull away from the DOM phone into the existing keys footage. | No new paragraph or card. | The message causes a visible human action. |
| Reassurance | Return to Liam. The same connection terminates at WILi. | **WILi: “Liam, Maya's on her way.”** Screen: **MAYA — ON WAY**. | The wearer hears the reported progress. Avoid a promise of continuous listening or guaranteed arrival. |

The private-chat version uses Maya for the record question and omits Dr. Chen's shared-room request. An additional approved contact remains available; separate state updates explain that Maya owns the response. This faithfully depicts the current product without presenting a group conversation as shipped.

## Make the proposed GC a defined room

The proposed room contains **LIFELINE**, **Maya (nearby responder)**, and **Dr. Chen (approved clinician)**. Liam's wearable speech is relayed as a labelled quote; Liam is not silently enrolled in the room. Every bubble carries a sender. Clinical source evidence appears only in the approved responder context.

Creation is triggered by **HELP_REQUESTED**, not a possible motion event alone. The room is incident-bound, with one original alert and one authoritative state. A clinician's question or “Maya, can you go?” does not assign responsibility. An explicit incident-bound acceptance from Maya does. A competing acceptance cannot create a second owner. “On my way” changes progress only after acceptance. The room closes only after an on-scene owner's recorded outcome; the landing ends earlier, while Maya is en route.

Actual implementation would need group creation/member support, approval and consent for shared clinical information, persisted incident/chat/line membership, sender-based command authorization, group reply/reaction correlation, and the same stale-message, duplicate, reassignment, unknown-send, and restart behavior as the current DMs. Provider support must be verified before building this path. A group mockup alone establishes none of these.

## Scroll direction

Keep source frames 000–079 untouched. Keep the check-in and wearer voice ahead of any phone UI. Around source frames 140–159, hold a stable wearer pose while the quote compacts and the phone enters. Hold a stable early responder pose around 175–185 while the DOM phone carries the question, answer, human request, acceptance, and departure. Allocate extra scroll distance here; do not squeeze six readable messages into the existing few physical frames or uniformly map all 260 images. Source frames 200–219 then advance through the keys action. Return at 220–259. At 259, stop image time and reframe the same canvas into the webpage.

The phone zoom is a browser transform around live message elements. Reverse scrolling reconstructs the same earlier message/state without posting anything. Typing dots and waveforms follow scroll progress, not autoplay timers. Small screens show one question/answer or state change at a time. Reduced motion provides the ordered transcript.

## Evidence used

- Current incident policy: `src/controller.ts` (contact selection, acceptance, progress).
- Current DM boundary: `src/providers/photon.ts` (bound group spaces rejected).
- Clinical wording and source IDs: `output/incident-flow-smoke-result.json`, saved synthetic Finch/local-AI rehearsal. No new clinical fetch or live messages were performed.
- Current visual assets: `public/media/story/manifest.json`, revision 4, 260 frames. No footage regenerated.

The accompanying interactive study exposes the current private-chat route and proposed room as separate alternatives, with identical acceptance/departure rules.
