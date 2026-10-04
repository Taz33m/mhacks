# FREE-WILi wearable bridge

The connected device is the original FREE-WILi, with MainCPU/DisplayCPU firmware v54. The live path reuses the official `freewili==0.0.51` Python SDK; it does not require custom firmware or a flash. The original custom NDJSON transport remains available in `bridge.ts` for compatible future firmware.

```sh
npm run setup:freewili
# Discovery prints MAIN and DISPLAY separately. Select the actual DISPLAY port.
npm run device:freewili -- --port /dev/cu.usbmodem1201
# Optional bounded foreground recovery for transient USB/backend transport loss:
npm run device:freewili -- --port /dev/cu.usbmodem1201 --reconnect
```

Run the backend with `npm start`. Keep the board connected by USB to the Mac. Ctrl-C stops the foreground bridge and disables event streams. The pairing token is read from the private local file, never printed. The waist AirPod continues through the existing Mac application and unchanged route keeper; the iPhone supplies communication only.

`--reconnect` retries the **same explicitly selected port** with 500 ms–5 s backoff for up to 120 seconds per outage. Each prior worker and WebSocket is fully closed before a new worker starts with a fresh device session. The retry budget resets only after an attempt has forwarded real samples over at least 30 seconds of uptime; rapid flapping remains bounded. Missing-port and temporary backend network failures are reported as unavailable. No samples are synthesized, expired check-ins are skipped, and original server deadlines remain authoritative.

Authentication rejection, malformed packets, protocol/policy closure, invalid configuration, and an unexplained SDK worker exit while the selected port stays present are fatal. A disappearance observed before teardown remains recoverable even if the port returns while the old worker closes. Very brief USB failures that escape the availability check can remain an unexplained fatal exit; check the actual cause instead of retrying every SDK error. A changed port name requires selecting the verified DISPLAY path again.

This is a long-running foreground command, without an installed service or scheduled restart. SIGINT/Ctrl-C and SIGTERM cancel both active work and backoff and do not relaunch it. Cleanup normally completes promptly; a worker stuck in a synchronous SDK operation gets at most 15 seconds before forced termination. Omitting `--reconnect` retains the single-attempt command used by the physical voice-smoke harness.

## Physical interaction

- Red button: explicit help, immediately entering help requested.
- Green button: explicit cancellation of the current check-in before its deadline.
- Display: current incident stage and responder name. Accepted and en route are separate stages.
- Speaker: seven cached 8 kHz mono PCM prompts uploaded into `/sounds`: check-in, help requested, accepted, en route, arrived, resolved and explicit-cancellation guidance. The preparation manifest records the actual generation source; local macOS speech is not an ElevenLabs demonstration.
- Microphone: one bounded six-second capture after the check-in prompt, with local Whisper transcription. A positive or ambiguous transcript preserves the timer. A positive transcript asks for the green button; exact help requests escalate.

The optional [ambient communication UI](../../docs/wili-ambient-ui.md) replaces text screens with native blue pulses, measured voice bars, message bubbles and actual responder initials. Build it with `npm run prepare:wili:ui` before starting the foreground bridge. Use `--no-ui` for text presentation. Its standalone preview uses the same 320×240 pixels with fictional people and sends no operational commands.

Stock acceleration reporting pauses for the duration of spoken prompts to reduce playback load on the display processor, then resumes before microphone capture. Buttons remain enabled. The resulting measurement gap is retained and can appear as stale telemetry; it never establishes safety. This is a playback mitigation awaiting listening comparison, not proof of improved audio.

Use the normal configurable check-in window (default 20 seconds) to rehearse playback, listening and recognition; measure whether that sequence completes before the deadline. The optional five-second demo policy can expire before it finishes. Playback-command acceptance does not prove audibility; prompt duration is an estimate used to exclude echo. Raw utterance audio is transient. The backend records the final transcript and policy decision with incident/check-in identity.

## Cached board voice

For ElevenLabs preparation, set `ELEVENLABS_API_KEY` in the private `.env`. Optional `ELEVENLABS_VOICE_ID` and `ELEVENLABS_MODEL_ID` override the defaults (`JBFqnCBsd6RMkjVDRZzb` and `eleven_multilingual_v2`). Board delivery defaults to 0.85 speed; `ELEVENLABS_SPEED` can override it within 0.7–1.2. Prepare before starting the stock bridge:

```sh
npm run prepare:wili:elevenlabs
```

All seven assets and their source, voice/model, timestamps and content checksums are recorded in `output/freewili-audio/manifest.json`. A complete matching verified local cache avoids new provider calls. A preparation failure preserves the prior active assets and does not silently switch provider. `npm run prepare:wili:local` explicitly generates the macOS Samantha fallback; the setup command uses that local path by default.

Observe the generated manifest and actual board playback separately. An API key, a cache hit, an upload or a playback-command result does not establish a live audible ElevenLabs demonstration.

## Motion and timing

The original LIS3DH is currently configured at ±2 g per axis in normal 10-bit mode. Conversion follows the official OG driver: `(signed_raw >> 6) * 4 / 1000` g at ±2 g, with the appropriate sensitivity for other declared ranges. All-zero stock readings are discarded because the original driver can also produce zeros on a failed read. Clipping is retained and excluded from triggering.

Stock frame timestamps are preserved as decimal strings. Their units are not assumed: observed deltas differ from the SDK documentation. `captureClock: host-receipt` explicitly means the Python SDK callback time; clock exchange aligns the gateway host with the backend, not the original sensor acquisition. Sparse stock events do not reset that gateway clock or establish continuous primary motion. Dashboard timing and incident evidence disclose this distinction. Delivered cadence is measured rather than inferred from the requested 33 ms event interval.

The provisional stock detector uses ≥1.65 g acceleration, temporally correlated waist movement/rotation, then 2.4 seconds of waist quiet. Both sources must be usable and aligned; standing waist tilt calibration is optional. Custom monotonic firmware retains its separate ≥2.5 g wider-range profile and rejects ±2 g input. Evidence freezes the actual measurements, source sessions, timing basis and selected threshold. Physical accuracy and false-positive behavior require staged trials; no clinical accuracy is claimed.

## Local speech model

`LIFELINE_WHISPER_MODEL` must be an absolute path to a real trained Whisper model; `WHISPER_CLI` optionally overrides `/opt/homebrew/bin/whisper-cli`. `audio-transcription.ts` resamples 8→16 kHz without changing duration, runs a bounded local process, and cleans private temporary files. Missing speech never closes an incident.

`setup:freewili` installs the pinned tiny.en model; configuring its runtime path remains explicit. Add the actual absolute paths to the private `.env` before starting `device:freewili`:

```dotenv
LIFELINE_WHISPER_MODEL=/absolute/path/to/ggml-tiny.en.bin
# Optional when whisper-cli is installed elsewhere:
WHISPER_CLI=/absolute/path/to/whisper-cli
```

Successful local transcription is attributed to `FREE-WILi microphone · local Whisper` in the console. Prompt submission is not proof that the wearer heard it; test audibility and recognition on the connected board.

```sh
npm run typecheck
npm test
node native/freewili/bridge.ts --check native/freewili/fixtures/synthetic-protocol.ndjson
```

The custom fixture is synthetic, not a physical motion recording. Offline tests do not verify audibility or wearable sensing accuracy.

Official sources: [Python SDK](https://github.com/freewili/freewili-python), [OG driver](https://github.com/freewili/wiliOGbsp/tree/main/bsp/display_cpu/sensors).
