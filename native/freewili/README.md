# FREE-WILi acquisition bridge

This is a hardware-independent adapter and a **custom firmware protocol**, not a claim that stock FREE-WILi firmware supports these packets. No board has been flashed or verified with this bridge. The files under `fixtures/` are synthetic. The current server accepts acquisition and explicit button controls; it does not infer falls from WILi acceleration or issue board audio commands.

The iPhone is a communication device in this architecture. `body-wili` is a separate source from the retained waist AirPod. Raw board acceleration must never be converted into a fabricated `chest-phone` Core Motion packet.

## Transport

Use one explicit USB serial port for firmware implementing `protocol.ts`. The foreground Python standard-library worker configures 115200 baud and DTR, restores the original terminal/modem settings on normal shutdown, and carries bounded bytes. The Node bridge validates NDJSON/session ordering and relays through the authenticated `/motion?source=body-wili` WebSocket. It does not flash, discover ports, install dependencies, restart, or change pairing preferences.

Offline check, with no serial port, sockets, or providers:

```sh
node native/freewili/bridge.ts --check native/freewili/fixtures/synthetic-protocol.ndjson
node --test src/freewili.test.ts src/wili-server.test.ts
```

Once compatible firmware and a real port exist:

```sh
node native/freewili/bridge.ts --port /dev/cu.usbmodemYOUR_DISPLAY_PORT --token-file data/pairing-token
```

The token file must be private (`chmod 600`). Pass `--backend` only as a plain HTTP(S) origin when needed. Credentials stay in the local file and are never printed or passed as shell arguments. Ctrl-C stops the foreground bridge and serial child. Samples dropped during connection/backpressure are counted; they are not replayed as live. Undeliverable controls, malformed packets, or session changes stop the bridge rather than pretending success.

## Device to host

One JSON object per line, at most 4096 UTF-8 bytes. Firmware sends `device.hello` first. The bridge forwards that hello as its first WebSocket frame. Session IDs identify one acquisition session, are at most 80 ASCII letters/digits/underscores/hyphens, and must change after a disconnect/reconnect. A fresh session is required even when the board did not reboot. Sequence starts at zero and increases strictly; capture time also increases strictly. A changed range requires a new session.

```json
{"type":"device.hello","protocolVersion":1,"source":"body-wili","sessionId":"boot-or-acquisition-1","deviceModel":"freewili-og","fullScaleG":8,"capabilities":{"accelerometer":true,"speaker":false,"microphone":false,"buttons":true}}
{"type":"accel.sample","source":"body-wili","sessionId":"boot-or-acquisition-1","sequence":0,"sensorTime":101.001,"captureClock":"device-monotonic","accelerationG":[0,0,1],"fullScaleG":8,"fresh":true,"saturated":false,"quality":"measured"}
```

`sensorTime` is seconds on the board's monotonic acquisition clock. `accelerationG` is the signed X/Y/Z measured acceleration in g, **including gravity**; a stationary board can measure about 1g and an actual freefall sample can measure about 0g. It is not gravity-separated user acceleration. The adapter neither invents orientation/gyro data nor guesses board placement. `fullScaleG` declares the configured per-axis ±2/4/8/16g range. `fresh:true` means a newly acquired sensor reading, not the last cached value. A failed read or unavailable new sample must never become an all-zero packet.

Host receipt is separately recorded as `hostMonotonicMs` and wall time `receivedAt`. Board timestamps alone do not establish alignment. The host sends a clock ping; the device replies using the **same board clock** as `sensorTime`, converted to milliseconds:

```json
{"type":"clock.ping","id":"clock-1","serverSentMs":1234}
{"type":"clock.pong","id":"clock-1","sessionId":"boot-or-acquisition-1","deviceReceivedMs":101100,"deviceSentMs":101101}
```

`FreeWili` bounds pending exchanges/history, rejects replay and backward time, and tracks alignment uncertainty. Readings without current alignment remain diagnostic. Receipt/capture gaps of 500ms are stale; capture timing outside the permitted window cannot be repaired by a recent receipt. A 500ms receive gap clears alignment, and clock estimates expire after 15 seconds. A newly aligned sample is required before `usable` becomes true. `usable` means acquisition quality only: it does not prove fall detection. ±2g range and reported/near-full-scale clipping are explicitly unusable for the proposed impact assessment.

Buttons carry the incident/check-in context most recently received from the server:

```json
{"type":"button.press","source":"body-wili","sessionId":"boot-or-acquisition-1","eventId":"help-1","action":"help","incidentId":null,"checkinId":null}
{"type":"button.press","source":"body-wili","sessionId":"boot-or-acquisition-1","eventId":"cancel-1","action":"cancel","incidentId":"LF-EXAMPLE","checkinId":"current-checkin-id"}
```

`help` with both IDs null is allowed only when no incident is active; it opens an explicit manual request. An active incident requires matching IDs for either action. `cancel` requires a current, unexpired `CONFIRMING` incident. An ambiguous response or an audio acknowledgement never cancels it. Event IDs must be unique; the server persists button deduplication and policy authorization. A successful socket send is not responder ownership.

Acquisition errors have no fabricated sample:

```json
{"type":"device.status","source":"body-wili","sessionId":"boot-or-acquisition-1","status":"sample-unavailable"}
```

Other supported statuses are `sensor-error` and `audio-error`. The current server fails closed on these packets, clears acquisition readiness, and requires a new session. No board implementation of these statuses has been verified yet.

## Host to device and reserved audio acknowledgement

`incident.context` supplies authoritative current IDs/phase and the existing deadline as wall-clock milliseconds. All four identity/phase/deadline fields are null when no active incident exists. Firmware must clear obsolete check-in controls when context changes. It may estimate remaining time using `serverTime`; it must not extend the server deadline.

```json
{"type":"incident.context","sessionId":"boot-or-acquisition-1","incidentId":"LF-EXAMPLE","checkinId":"current-checkin-id","phase":"CONFIRMING","checkinDeadline":1760000020000,"serverTime":1760000000000}
```

The protocol reserves named **preloaded board assets**, not MP3 decoding or remote TTS transport:

```json
{"type":"audio.command","sessionId":"boot-or-acquisition-1","commandId":"play-1","incidentId":"LF-EXAMPLE","checkinId":"current-checkin-id","action":"play","asset":"fall-checkin"}
{"type":"audio.ack","source":"body-wili","sessionId":"boot-or-acquisition-1","eventId":"audio-1","commandId":"play-1","incidentId":"LF-EXAMPLE","checkinId":"current-checkin-id","status":"finished"}
```

`action` is `play` or `stop`; `asset` is `fall-checkin` or `safe-confirmation`. Acknowledgement status is `started`, `finished`, `stopped`, or `failed`. The bridge checks command correlation; an acknowledgement without an issued matching command is invalid. The current server issues no audio commands because asset availability/playback is unverified. There is no microphone PCM transport or speech recognition implementation in this foundation. Advertising microphone capability does not establish that audio is being captured.

## Board implementation order

1. Identify OG vs Wili2 hardware and the actual DISPLAY/MAIN port. These families have different firmware routes; do not assume OneWili commands run on OG.
2. On OG, adapt the workshop `wiliOGbsp` DISPLAY template and retained MAIN image. The verified `lis3dh_process`/`lis3dh_raw_to_mg` path yields raw acceleration; the OG normal-resolution conversion uses the configured range and mg-to-g conversion. Use a wider range such as ±8g, check a genuinely fresh reading, and use one monotonic clock for samples/pongs. The driver's success return alone does not establish a new sample: the bench example checks its sentinel. Verify this on the acquired board before calling it live acquisition.
3. Produce hello, samples, clock replies, and explicit physical button events. Bench-check timing, unplug behavior, fresh session identity, axis units, and saturation before considering a new detector.
4. Load a short PCM prompt using OG's verified `i2s_audio_*` API and keep its sample buffer alive through playback. The current OG driver uses 8kHz PCM; ElevenLabs MP3 bytes cannot be passed directly. Add correlated completion/stop acknowledgements, then test audibility on the real board.
5. Only then add microphone capture. OG's `pdm_microphone_takeRawBuffer`/decode path provides PCM buffers, not STT. Capture, bounded transport, prompt/listening exclusion, and final transcript provenance still need implementation and device verification. Wili2/OneWili offers a different command/event stack; its motion event timing and audio behavior also need board verification.

Official references: [OG BSP](https://github.com/freewili/wiliOGbsp), [OneWili](https://github.com/freewili/onewili). The workshop PDF is the starting point for board-specific build/flash steps; this directory does not ship a verified firmware image.
