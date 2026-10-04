# Patient conversations

Patient iMessage conversations now support native Spectrum polls with text/voice fallback:
- Daily feeling check: good, lonely, not feeling well.
- A pain report asks duration, then effect on daily activity.
- Loneliness offers conversation, help drafting a message, or quiet.
- Clinical record questions retain source validation and compact formatting.

A choice is a patient report, not a diagnosis. Help requests route to the existing incident policy; positive answers never cancel a safety check. Selecting a help choice by number or voice resolves to its displayed wording before policy evaluation.

The conversation and accepted prompts are stored in SQLite. Only the approved patient chat and the latest accepted choice set authorize native votes. Deselections are ignored. A native vote is not used as a message-reply target, since Spectrum does not support replying to a vote; follow-ups retain the same DM identity.

Spectrum 12.10.1 receives empty poll titles from the service. `scripts/patch-spectrum-polls.mjs` adds a bounded compatibility fallback so its poll parser does not discard votes. `postinstall` applies the version-checked, idempotent patch. When the service title is missing, the application matches the complete option set against the persisted accepted prompt. Questions are also sent as ordinary text because the native poll UI displays only choices.

Verified in Messages: scripted back-pain report → native duration choices → vote recorded → native impact choices. Text and voice option numbers are covered by deterministic tests. Existing WILi microphone acquisition is unchanged.
