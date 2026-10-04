# Motion capture and offline replay

The current product uses **FREE-WILi primary acceleration plus a waist-mounted AirPod**. Paired trials record both authenticated input streams in one ordered JSONL file and replay the same provisional combined assessment offline. The iPhone is a communication device; it supplies no motion stream in this mode.

Replay imports the acquisition adapters and detector, with an injected recorded clock. It does not import the server/controller/providers, create an incident, connect to a running backend, or send messages. Generated fixtures exercise software behavior; observed device packets establish acquisition. Neither `capture: "native-stream"` nor an operator scenario label verifies a bodily event or detector accuracy.

## Record a paired trial

1. Pair the WILi and native waist clients using [native-setup.md](native-setup.md). Check the actual reporting AirPod, session identities, freshness and clock alignment. A connected socket without samples does not establish acquisition.
2. Finish any active incident. In **Motion trials**, enter a trial label and scenario, then **Begin recording**. The normal profile creates a version-2 `wili-waist` capture. Initial connected sources and their known sessions are recorded, followed by the retained, actually advertised WILi hello. No initial samples are invented.
3. Recording start clears earlier sensor history and clock estimates, and removes the assessment cooldown. It retains device connectivity and sequence/replay guards. A **fresh same-session standing calibration is preserved** and annotated with its source/session/bud. An ordinary disconnect, reporting-bud/session change or motion gap still invalidates that baseline. Recording does not automatically calibrate.
4. The first subsequently accepted sample from each source forces a new recorded clock exchange. Wait for both streams to regain usable alignment before the labelled observation. A periodic pong before the first captured sample can refer to a retained live session; offline replay counts that exchange as unusable bootstrap alignment, then uses the fresh post-sample exchange.
5. Add explicit operator markers to annotate observation boundaries or notable handling. Markers contain a short label and the host event times. They are annotations, not sensor observations or ground truth. The visible **Device drop** scenario retains the historical API value `phone-drop` for compatibility.
6. Record the planned observation and enough time afterward for the waist quiet window. Preserve placement, handling and staging notes separately. Click **Stop recording**, wait for **Stopped**, then **Download JSONL**. The server also saves `data/trials/trial-<id>.jsonl` privately.

Recording keeps the normal live incident pipeline enabled: an actual eligible paired candidate can open a check-in. Starting is rejected during an active incident; markers and stop remain available during one. Stopping capture does not resolve an incident or stop monitoring. **Reset demo** is captured as `motion.reset`, including its history/calibration loss and assessment cooldown.

The paired acceleration rule does not require standing tilt calibration. Preserved pre-trial calibration is recorded honestly as metadata; replay does not synthesize its vector. Explicit successful calibration events within the trial are reconstructed and compared against the captured waist samples.

Recording stops at ten minutes, 100 MB, or backpressure before dropping queued stream events. The final reason and completion state remain visible. Storage errors and interrupted files remain incomplete.

## Replay local files

With Node 24 or later, from the repository:

```sh
npm run replay:motion -- data/trials/trial-<id>.jsonl
npm run replay:motion -- --output /tmp/lifeline-replay.json data/trials/trial-<id>.jsonl another-trial.jsonl
npm run --silent replay:motion -- data/trials/trial-<id>.jsonl > /tmp/lifeline-replay.json
```

No backend, token or provider key is needed. The CLI writes JSON to stdout and optionally a private output file. Reports declare `kind: "offline-motion-replay"` and `live: false`, and include input hashes and the current detector source hashes. Each file is independent; do not concatenate different host-clock epochs. Candidate discrepancies can reflect changed code or thresholds, unavailable alignment, or missing captured evidence; they are not correctness scores.

Version-2 paired reports include:

- Counts and session IDs for raw `body-wili` acceleration and waist `motion.sample`, plus the actual reporting bud and hello/capability history.
- Host-receive cadence and gaps, declared-clock cadence and gaps, sequence gaps, full-scale range, raw and conservatively inferred saturation counts, and raw framing timestamps retained as decimal strings.
- Recorded clock exchanges, accepted/rejected and unusable pre-sample pongs, aligned/capture-fresh sample counts, and simultaneous fresh alignment coverage at evaluated assessment times.
- Scenario and explicit markers, preserved-calibration annotations, and any recorded successful calibration compared with what captured samples can reproduce.
- Candidate times, exact source sessions and immutable features: primary impact, supporting waist movement, continuous waist quiet, declared timing domain, alignment uncertainty and applied thresholds. Candidate presence and feature discrepancies are reported.
- Assessments explicitly skipped because an incident was already active. These do not call the offline detector and are not counted as negative detector results.

Statuses distinguish `unscored-no-samples`, `unscored-missing-paired-samples`, `unscored-no-assessments` and `unscored-no-paired-alignment`. Missing evidence is listed. `replayed` means inputs were evaluated by the current prototype; it does not establish detection accuracy. There are no paired solo modes or silent single-device fallbacks.

### Timing and range interpretation

Every event has host-monotonic `atMs` and wall-clock `at`, both in milliseconds. Sample `sensorTime` is seconds in its explicitly declared domain. Ping/pong events provide the only clock alignment used by replay.

For the stock OG SDK bridge, `captureClock: "host-receipt"` identifies **gateway receipt**, not board acquisition. Its stock `frameTimestamp` is preserved exactly; replay does not assume that framing value is nanoseconds or convert it into acquisition time. An aligned host-receipt stream does not establish the board's acquisition latency. Device-monotonic custom-protocol packets retain their separate acquisition clock.

Raw WILi acceleration includes gravity. It is never re-labelled as Core Motion fused gravity, quaternion or rotation. Stock 2 g and custom ranges remain distinct. Saturated/clipped packets remain in the recording for diagnostics and cannot supply eligible impact evidence.

The current provisional combined rule requires primary impact, correlated waist movement and continuous subsequent waist quiet with current clock alignment. The stock 2 g host-receipt profile uses its recorded 1.65 g prototype threshold; other supported ranges use the 2.5 g threshold. Supporting waist movement is at least 0.4 g linear acceleration or 1.2 rad/s measured rotation within 750 ms. The quiet window is 2.4 seconds with at most 0.15 g linear acceleration and 0.35 rad/s rotation; it cannot bridge a waist gap over 200 ms. Sparse primary events are retained as sparse events, without inventing primary quiet or interpolated samples. Applied settings are also frozen in each candidate's features.

## Ordered capture format

Each non-empty JSONL line is an ordered event; equal host times are permitted, decreasing times are rejected:

```json
{"type":"assessment","atMs":4200,"at":1790000004200,"payload":{"candidate":null,"evaluated":true,"detector":"wili-waist-provisional-v1"}}
```

| Event | Version-2 payload / interpretation |
| --- | --- |
| `trial.start` | `{version:2,id,label,scenario,capture:"native-stream",captureMode:"wili-waist",initialSources,initialSessions,stateBoundary:"fresh-history-and-clocks",preservedCalibration}` |
| `source.connected` / `source.disconnected` | Explicit `body-wili` or `waist-airpod`; acquisition failure records disconnect as soon as invalidated |
| `device.hello` | Actual advertised WILi model, boot/session, protocol version, range, transport and capabilities |
| `clock.ping` / `clock.pong` | Original clock packet with explicit source; ping event time equals its host send time |
| `accel.sample` | Original accepted raw WILi acceleration packet with explicit `body-wili` source |
| `motion.sample` | Original accepted waist Core Motion packet with explicit `waist-airpod` source |
| `calibration` | `{sources:[...]}` listing successfully calibrated waist sources |
| `motion.reset` | Explicit `{clocks:boolean,cooldown:boolean}` |
| `trial.marker` | `{label:"operator annotation"}` |
| `assessment` | `{candidate:Evidence\|null,evaluated:boolean,detector:"wili-waist-provisional-v1"}` |
| `trial.stop` | `{reason:"..."}` |

Authenticated trial APIs are `POST /api/trials/start {label,scenario}`, `POST /api/trials/marker {label}`, `POST /api/trials/stop`, and `GET /api/trials/<id>/download`. Markers require a current paired recording and a 1–80 character label without control characters. `TrialView.sampleCounts` retains `chest-phone` for compatibility and adds `body-wili`; it also reports `captureMode` and `markerCount`.

The parser enforces trial boundaries, supported versions/sources/scenarios, bounded labels, finite clocks, hello/session/range/transport consistency, valid vectors, monotonic sequence/device time, no retired-session reappearance, actual reporting bud consistency and matching clock exchanges. Errors identify file and line. Missing history is never repaired with fabricated packets, calibration or offsets.

Inputs are bounded to 32 regular local files, 128 MiB per file, 256 MiB combined, 64 KiB per line, 250,000 lines per file and 500,000 combined records, with valid UTF-8 and bounded JSON nesting. Output cannot overwrite an input through a path or alias. Stop recording before replaying. An interrupted recording without `trial.stop` is rejected as unfinished.

## Legacy Core Motion and sample-only files

Version-1 trials remain readable and retain the earlier chest-iPhone/waist-AirPod algorithm. Those recordings reset their calibration at trial start and need successful calibration within the capture. Their three diagnostic modes are:

| Legacy mode | Available evidence and prototype rule |
| --- | --- |
| `combined` | Chest impact plus quiet and calibrated waist tilt/quiet when fresh and aligned; historical chest-only fallback when waist is unavailable |
| `chest-only` | That phone's own impact, tilt and continuous quiet |
| `waist-only` | That AirPod's own impact, tilt and continuous quiet |

These historical ablations use different available features and do not establish an accuracy gain. They describe the earlier detector, not the current WILi product. Paired trials preserve the existing `Source` type for those packets instead of disguising raw board acceleration as a chest phone.

Older `data/recordings/` files can contain raw `MotionSample` **or** raw WILi `accel.sample`, plus `receivedAt` and `hostMonotonicMs`. The CLI accepts each for packet validation, cadence, gaps, sessions and range/saturation metadata. They remain `unscored` with no candidate assessment because hello/clock exchanges, paired history, boundaries and assessment events are absent. Supplying separate raw files together does not manufacture a paired trial.

The legacy Right AirPod file `waist-airpod-4FFAA6BD-FB0E-46FE-9395-D0E54C13F6A9.jsonl` was observed to contain 1,113 samples over 24.623 seconds, with average receive cadence 45.162 Hz and a 213.047 ms maximum receive interval. It remains sample-only transport evidence. Use newly labelled paired recordings to assess the current mounted-device sensing hypothesis; keep generated fixtures and tuning observations distinct from later evaluation observations.
