#!/usr/bin/env python3
"""LIFELINE CLI adaptation of OrbisEngine's photo-avatar preparation script.

Modified 2026-10-04: explicit paths, optional existing mask, and no hardcoded photo.
The original is retained at .context/photo-avatar/prepare_photo.py.
"""

import argparse
import hashlib
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--mask", type=Path, help="Reuse a reviewed mask without a model download")
    parser.add_argument("--dilate", type=int, default=2)
    args = parser.parse_args()
    if not 0 <= args.dilate <= 32:
        parser.error("--dilate must be between 0 and 32")

    import numpy as np
    from PIL import Image
    from prepare_lhm_person import box_report, person_mask

    source = args.image.resolve()
    rgb = np.asarray(Image.open(source).convert("RGB"))
    height, width = rgb.shape[:2]
    if args.mask:
        mask = np.asarray(Image.open(args.mask).convert("L"))
        if mask.shape != (height, width):
            raise ValueError("Mask and source image dimensions must match")
        mask = ((mask > 127) * 255).astype(np.uint8)
        method = "Reviewed existing mask; no model inference"
    else:
        mask = person_mask(rgb, dilate=args.dilate, method="maskrcnn")
        method = f"Mask R-CNN: highest-score person, largest component, {args.dilate}px dilation"
    report = box_report(mask, width, height)
    if report.get("empty") or not report["portrait"] or report["touchesFrame"]:
        raise ValueError(f"Reference mask is unsuitable: {report}")
    out = args.out.resolve()
    if out.exists() and any((out / name).exists() for name in ("source.png", "mask.png", "prepared.json")):
        raise FileExistsError("Prepared inputs already exist; choose a new output directory")
    out.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgb).save(out / "source.png")
    Image.fromarray(mask).save(out / "mask.png")
    metadata = {
        "inputKind": "still-photo",
        "sourceImage": str(source),
        "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "sourceWidth": width,
        "sourceHeight": height,
        "personBounds": report["box"],
        "touchesFrame": report["touchesFrame"],
        "maskMethod": method,
        "coverage": "Single frontal photo; hidden surfaces will be inferred by LHM.",
    }
    (out / "prepared.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps({"prepared": str(out), "mask": report}, indent=2))


if __name__ == "__main__":
    main()
