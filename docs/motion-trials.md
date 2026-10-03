# Motion capture and offline replay

The dashboard records the motion detector's inputs and state changes so the same trial can be replayed independently with both sensors, the chest iPhone alone, and the waist AirPod alone. Replay is an offline debugging tool. It does not create incidents, contact responders, call providers, or publish sensor data to a running server.

`capture: "native-stream"` means the recorder captured packets accepted at the authenticated native-stream interface. It does not prove device placement, a bodily event, or a correct scenario label. The operator supplies the labels. Protocol fixtures can also be accepted at that interface; keep their provenance distinct from observations of physical devices.

## Record a self-contained trial

1. Start the backend and pair the native clients using [native-setup.md](native-setup.md). The intended placements are the chest iPhone and waist AirPod. Confirm which AirPod actually reports motion, and check each sensor's freshness and alignment on the dashboard.
2. Finish any active incident. In **Motion trials**, enter a short **Trial label**, choose a **Scenario label**, and click **Begin recording**. Starting clears calibration, recent motion, and clock estimates. Connected sources are recorded without invented initial samples. The first accepted sample from each source triggers a new recorded clock exchange.
3. Hold the mounted sensors still for at least one continuous second, then click **Calibrate standing** while recording. Check that the required sensors show **Calibrated** and a fresh signal. Calibration requires sufficiently continuous, low-motion samples; a failed attempt does not manufacture a calibration event. The event lists only sources that actually calibrated successfully. Both sources need current clock estimates for cross-body assessment.
4. Perform the planned observation and leave enough recording time afterward for the detector's quiet-motion window. Keep sensor placement and trial conditions in your accompanying notes. Use only controlled staging appropriate for the team and equipment; recording a label does not validate a fall.
5. Click **Stop recording**, wait for **STOPPED**, then **Download JSONL**. The server also keeps the complete file in `data/trials/trial-<id>.jsonl`. Recording stops automatically at ten minutes or the recorder's size/backpressure limit; its final reason is part of the file.

Stopping capture keeps monitoring and incident response active. It does not clear an incident. **Reset demo** during a trial is recorded as `motion.reset`, so replay reproduces the loss of calibration and the reset cooldown. A calibration from before **Begin recording** cannot be used for replay.

## Replay local files

From the repository directory, with Node 24 or later:

```sh
npm run replay:motion -- data/trials/trial-<id>.jsonl
npm run replay:motion -- --output /tmp/lifeline-replay.json data/trials/trial-<id>.jsonl another-trial.jsonl
```

The CLI writes a JSON report to stdout and optionally saves the same report with `--output`. To get pure JSON when redirecting, suppress npm's own script banner:

```sh
npm run --silent replay:motion -- data/trials/trial-<id>.jsonl > /tmp/lifeline-replay.json
```

No backend needs to run. No token or provider key is needed. The report explicitly has `kind: "offline-motion-replay"` and `live: false`, plus SHA-256 hashes of each input and the detector source. Each file is replayed independently; do not concatenate files from different host clock epochs. All three modes use the detector in the current checkout, so differences from recorded output may reflect code changes as well as the available sensors.

The report includes:

- Sample counts, reporting bud/phone identity, session IDs, host span, average received cadence, within-session sensor cadence, timing gaps over 500 ms, and missing sequence values. Cadence is an average over the recorded window, including pauses; it is not a promised device sampling rate.
- Recorded clock exchanges and counts of usable/unusable pongs in each mode. A pong before that trial's first sample cannot establish a replay session and is counted unusable. The fresh exchange after the first sample supplies reproducible alignment; no samples or offsets are synthesized.
- Recorded successful calibration sources compared with what replay can calibrate from the captured samples. Freshness, calibration, and alignment coverage are counted at the recorded assessment times.
- Candidate timestamps, kinds, and source sessions for each mode. Comparisons with the recorded candidate check presence, kind, and source sessions. They do not compare explanatory prose or infer correctness.

Statuses make incomplete evidence explicit: `unscored-no-samples`, `unscored-no-calibration`, or `unscored-no-assessments`. The report still shows metadata and any detector diagnostics available. `replayed` means the recorded inputs were evaluated; it is not a validated accuracy score. Calibration mismatches and missing alignment remain visible in the detailed report even when other sources are usable.

### What the three modes compare

| Mode | Available evidence and prototype rule |
| --- | --- |
| `combined` | Chest impact followed by continuous quiet motion, plus calibrated waist tilt and quiet motion with current clock alignment when the waist stream is fresh. It uses the chest-only fallback if the waist is unavailable. A fresh but uncalibrated or unaligned waist stream prevents a cross-body candidate. |
| `chest-only` | That iPhone's own impact, tilt, and continuous quiet motion. Waist packets are excluded. |
| `waist-only` | That AirPod's own impact, tilt, and continuous quiet motion. Chest packets are excluded. |

These are prototype comparisons with different available features. They do not establish an accuracy gain from two sensors. Solo candidates can differ intentionally from the recorded combined output; those differences are marked as ablation discrepancies. The CLI produces no accuracy percentages, physical diagnosis, or inferred ground truth.

Initial thresholds are 2.5 g total acceleration, 60° calibrated tilt, and about 2.8 seconds of low motion (at most 0.15 g user acceleration and 0.35 rad/s rotation). Quiet motion cannot bridge an arrival gap over 200 ms, including at the end of the window. With a usable clock estimate, samples captured at least 500 ms before receipt or more than 100 ms into the future remain recorded but cannot supply calibration or incident evidence. Cross-body assessment also requires clock uncertainty at most 100 ms and an estimate less than 15 seconds old. These settings need evaluation on mounted-device trials.

To evaluate the sensing hypothesis, capture separate repeatable standing, phone-drop, sit, bend, and controlled staged-event trials with calibration inside each recording. Preserve placement and timing notes, separate protocol fixtures from physical observations, and keep evaluation recordings separate from those used to tune thresholds. A stream dropout is a missing-data condition, not evidence of safety.

## Recorded format and validation

Each non-empty JSONL line is one ordered event:

```json
{"type":"assessment","atMs":4200,"at":1790000004200,"payload":{"candidate":null}}
```

`atMs` is host monotonic milliseconds and drives the injected replay clock. `at` is a wall-clock timestamp used for display. Equal host timestamps are allowed; decreasing timestamps are rejected. Device `sensorTime` is seconds and is aligned only through recorded ping/pong exchanges.

| Event | Payload |
| --- | --- |
| `trial.start` | `{version:1,id,label,scenario,initialSources,capture:"native-stream"}` |
| `source.connected` / `source.disconnected` | Explicit `source`; no motion packet required |
| `clock.ping` | Recorded `ClockPing`, with explicit `source` |
| `clock.pong` | Recorded `ClockPong`, with explicit `source` and matching pending ping |
| `motion.sample` | Accepted `MotionSample`, with matching explicit `source` |
| `calibration` | `{sources:[...]}` containing successfully calibrated sources |
| `motion.reset` | Explicit `{clocks:boolean,cooldown:boolean}` |
| `assessment` | `{candidate:Evidence\|null}`; only these events call `candidate()` during replay |
| `trial.stop` | `{reason:"..."}` |

The parser rejects unsafe session IDs, reporting-bud changes within a session, non-increasing sequence/device time, stale session reappearance, non-finite numeric values, malformed vectors, unknown event types, invalid scenarios, events outside trial boundaries, and unfinished trials. Errors identify the exact file and line. Do not hand-add clocks or calibration to repair missing evidence; recapture a complete trial.

Inputs are bounded to 32 regular local files, 128 MiB per file, 256 MiB combined, 64 KiB per line, 250,000 lines per file, and 500,000 combined records. Files must be valid UTF-8 JSONL. The output destination cannot overwrite an input recording. Stop capture before replaying so file contents are stable.

## Older sample-only recordings

Files under `data/recordings/` can contain only raw `MotionSample` packets plus `receivedAt` and `hostMonotonicMs`. The CLI accepts this legacy format for cadence, gaps, sessions, and packet validation. It reports `unscored`, with `candidates: null` for every mode, because trial boundaries, clock exchanges, calibration, and assessment history are missing. It never infers those missing events.

The locally observed legacy Right AirPod recording `waist-airpod-4FFAA6BD-FB0E-46FE-9395-D0E54C13F6A9.jsonl` contains 1,113 accepted samples over 24.623 seconds: average received cadence 45.162 Hz, maximum host-arrival interval 213.047 ms, no host-arrival gap over 500 ms, and no skipped sequence values. It contains no chest samples, clock exchanges, or calibration and remains unscored. These are transport metadata for a brief acquisition; sustained off-ear continuity, waist mounting, cross-body performance, and physical incident detection remain unverified.

Historical download endpoints can return a raw file after restart, when the in-memory trial view is unavailable. An interrupted file can lack `trial.stop`; the replay parser rejects it as unfinished rather than assuming the capture completed.
