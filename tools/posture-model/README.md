# Posture model (chest accelerometer)

Offline posture classifier for a chest-worn 3-axis accelerometer, matching the FREE-WiLi chest unit. Not wired into the live LIFELINE runtime.

- **Data:** public [UCI MHEALTH](https://archive.ics.uci.edu/dataset/319/mhealth+dataset) dataset, 10 people, chest accelerometer only, downsampled 50 → 25 Hz, converted to g.
- **Features:** 2 s windows (1 s step), ~30 per window: per-axis statistics, magnitude, tilt of each axis against gravity, inter-axis correlation, low/high frequency energy.
- **Model:** random forest (300 trees).
- **Classes:** upright (standing and sitting merged), lying, walking, bending forward, crouching.
- **Validation:** leave-one-person-out; every person is scored by a model trained only on the other nine.

## Result

| Metric | Value |
| --- | --- |
| Leave-one-person-out accuracy | **96.3%** (3,498 windows) |
| Worst single person | 85.3% |
| Upright / lying | 100% / 100% recall |
| Bending forward / walking / crouching | 97.4% / 91.6% / 88.4% recall |

With sitting and standing as separate classes, accuracy is 79.4%: the upper body is upright in both, so a chest sensor alone cannot separate them. Separating them needs a second body segment (e.g. the waist sensor); that has not been measured.

Results are on the public dataset, not on LIFELINE hardware recordings.

## Run

```sh
pip install numpy pandas scikit-learn
python tools/posture-model/train_posture.py
```

Downloads MHEALTH on first run (~75 MB, not committed) and writes `results.json`.
