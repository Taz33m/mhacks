"""Chest-accelerometer posture classifier, evaluated leave-one-person-out on UCI MHEALTH.

Input mirrors the FREE-WiLi chest unit: one 3-axis accelerometer on the chest, in g, downsampled to 25 Hz.
Classes: upright (standing/sitting merged; a chest sensor alone cannot separate them), lying, walking,
bending forward, crouching.

    pip install numpy pandas scikit-learn
    python train_posture.py            # downloads MHEALTH (~75 MB) on first run
"""
import glob, io, json, re, urllib.request, zipfile
from pathlib import Path
import numpy as np, pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix

HERE = Path(__file__).parent
DATA = HERE / "MHEALTHDATASET"
URL = "https://archive.ics.uci.edu/static/public/319/mhealth+dataset.zip"
CLASSES = {1: "upright", 3: "lying", 4: "walking", 6: "bending forward", 8: "crouching"}
FS, WIN, STEP = 25, 50, 25  # 25 Hz, 2 s windows, 1 s step

if not DATA.exists():
    print("Downloading UCI MHEALTH ...")
    zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(URL).read())).extractall(HERE)

def features(w):
    f = []
    for a in range(3):  # per-axis statistics
        x = w[:, a]
        f += [x.mean(), x.std(), x.min(), x.max(), np.median(x), np.percentile(x, 75) - np.percentile(x, 25)]
    mag = np.linalg.norm(w, axis=1)
    f += [mag.mean(), mag.std(), mag.max() - mag.min()]
    g = w.mean(axis=0); g = g / (np.linalg.norm(g) + 1e-9)
    f += list(np.degrees(np.arccos(np.clip(g, -1, 1))))  # tilt of each axis against gravity
    c = np.corrcoef(w.T); f += [c[0, 1], c[0, 2], c[1, 2]] if np.all(np.isfinite(c)) else [0, 0, 0]
    spec = np.abs(np.fft.rfft(mag - mag.mean())); f += [spec[1:6].sum(), spec[6:].sum()]  # frequency content
    return np.nan_to_num(f)

X, y, person = [], [], []
for path in sorted(glob.glob(str(DATA / "mHealth_subject*.log"))):
    pid = int(re.search(r"subject(\d+)", path).group(1))
    d = pd.read_csv(path, sep=r"\s+", header=None).values
    acc, lab = d[::2, 0:3] / 9.81, d[::2, -1].astype(int)  # chest accel m/s^2 -> g, 50 -> 25 Hz
    lab = np.where(lab == 2, 1, lab)  # sitting -> upright
    for start in range(0, len(lab) - WIN, STEP):
        l = lab[start:start + WIN]
        if l[0] in CLASSES and np.all(l == l[0]):
            X.append(features(acc[start:start + WIN])); y.append(l[0]); person.append(pid)
X, y, person = np.array(X), np.array(y), np.array(person)

preds, per_person = np.empty_like(y), {}
for p in np.unique(person):  # leave one person out
    test = person == p
    model = RandomForestClassifier(n_estimators=300, random_state=0, n_jobs=-1).fit(X[~test], y[~test])
    preds[test] = model.predict(X[test])
    per_person[int(p)] = accuracy_score(y[test], preds[test])

labels = list(CLASSES)
print(f"windows: {len(y)}  people: {len(per_person)}")
print(f"Leave-one-person-out accuracy: {accuracy_score(y, preds):.3f}  (worst person {min(per_person.values()):.3f})")
print(classification_report(y, preds, labels=labels, target_names=[CLASSES[c] for c in labels], digits=3))
print(confusion_matrix(y, preds, labels=labels))
json.dump({"leave_one_person_out_accuracy": accuracy_score(y, preds), "per_person": per_person,
           "classes": [CLASSES[c] for c in labels], "windows": int(len(y)), "sample_rate_hz": FS, "window_s": WIN / FS},
          open(HERE / "results.json", "w"), indent=2)
