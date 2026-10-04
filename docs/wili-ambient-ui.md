# WILi ambient communication

The original WILi's 320×240 screen uses five primitives: a wearer pulse, expanding connection rings, voice bars, a blue message bubble and a responder avatar. The screens use the stock firmware's image API. No firmware flash, location inference or incident-policy change is involved.

`python3 scripts/prepare-wili-ui.py` builds content-addressed RGB565 `.FWI` files in `output/wili-ui`, a contact sheet, and a standalone interactive preview in `output/wili-ui-preview`. Serve that preview with `python3 -m http.server 8892 --bind 127.0.0.1 --directory output/wili-ui-preview`. Its fictional Maya sequence never contacts the backend or records audio.

The foreground stock bridge loads generated screens automatically when `output/wili-ui/manifest.json` exists. Use `--ui-dir` for another generated directory or `--no-ui` to retain text presentation. At startup it caches at most two configured responder display names in a private temporary directory; phone numbers and transcripts are excluded. An uncached name uses generic responder art. Rebuild assets and restart the bridge to change artwork. Image installation runs before sensor and microphone streams start; it never deletes unrelated device files.

| Actual event | Screen |
| --- | --- |
| No active incident | Here with you; hold-blue hint only when wellbeing voice is enabled |
| Detected / confirming | Concentric check-in pulse; green and red controls |
| Microphone enabled | Listening bars from validated PCM RMS; quiet samples yield quiet bars |
| Bounded recording awaiting recognition | Processing dots |
| Correlated successful recognition | I heard you; a brief blue bubble, then the current phase |
| Help requested | Reaching out; abstract pulses, without map or distance |
| Responder acknowledges | Arriving bubble becomes actual responder initials |
| Responder explicitly confirms departure | On the way |
| Responder speech playback command accepted | Speaker identity and levels measured from the prepared WAV |
| Responder explicitly confirms on-scene | Two connected dots |
| Explicit resolution / check-in closure | Distinct complete/closed screens, then the ready screen after three seconds |
| Wellbeing recording reaches its bound | Release to finish; does not continue to claim listening |

Recognition acknowledges a transcript; it does **not** prove that Photon delivered an iMessage. The display therefore does not say “Sent.” Likewise, playback command acceptance and the known clip duration do not prove physical audibility. Responded, on the way, on scene and complete remain separate backend states.

All display commands execute on the existing serial-owning worker. PCM callbacks update only the presentation model. The image client suppresses commands during file transfer and near a recording deadline, limits updates to five per second, and reduces animation to one update per second when a command takes over 150 ms. Failed image commands restore the existing text presentation. Sensor gaps during existing audio playback remain real gaps.

Offline validation: `python3 native/freewili/ambient_ui_test.py`, `node --test src/stock-worker.test.ts native/freewili/stock-recovery.test.ts native/freewili/wellbeing-audio.test.ts native/freewili/conversation-audio.test.ts`, and `npm run typecheck`. The native `.FWI` format is also compared against the installed official SDK converter. Physical interaction and speaker audibility still require observation on the device.
