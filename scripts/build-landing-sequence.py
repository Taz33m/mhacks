"""Extract deliberately authored Higgsfield shots into a scroll-owned WebP sequence.

Run from the repository root after saving the source shots in output/lifeline-sequence.
Revision 8 adds a dedicated speech insert and expands speech/request scroll space.
"""
import json
import base64
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from PIL import Image, ImageOps, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'output/lifeline-sequence'
DEST = ROOT / 'public/media/story'
# Scene boundaries are an editorial contract. Reverse scroll uses the same poses.
SCENES = [
    dict(id='ordinary', name='Ordinary life', clip='standing', offset=0, duration=4, count=40, start=0, end=.14),
    # Start at the first unmistakably concerned pose; retain the matching impact cut.
    dict(id='imbalance', name='Failed recovery', clip='imbalance-v4', offset=5.1, duration=.9, count=30, start=.14, end=.28, mobile_start=.86, mobile_end=1),
    dict(id='impact', name='Braced landing', clip='impact-v4', offset=0, duration=2.5, count=10, start=.28, end=.35, mobile_start=1, mobile_end=1),
    # The original seated opening smiles. Enter after that reset, then run into words.
    dict(id='checkin', name='The check-in', clip='seated', offset=1.65, duration=1.35, count=40, start=.35, end=.49),
    dict(id='words', name='Their own words', clip='speaking-v8', offset=0, duration=4, count=40, start=.49, end=.57),
    dict(id='responder', name='A person responds', clip='responder-v4', offset=0, duration=8, count=60, start=.57, end=.77),
    dict(id='waiting', name='Waiting, connected', clip='seated', offset=6, duration=4, count=40, start=.77, end=.88),
]
# Preserve every other beat's scroll distance while adding 55vh for speech.
for scene in SCENES:
    scene['start'] = round((scene['start'] + (.10 if scene['start'] >= .57 else 0)) / 1.10, 8)
    scene['end'] = round((scene['end'] + (.10 if scene['end'] >= .57 else 0)) / 1.10, 8)
for scene in SCENES:
    if not (SOURCE / f"{scene['clip']}.mp4").is_file():
        raise SystemExit(f"Missing source: {scene['clip']}.mp4")
for rendition in ['desktop', 'mobile']:
    (DEST / rendition).mkdir(parents=True, exist_ok=True)

index = 0
with tempfile.TemporaryDirectory(prefix='lifeline-sequence-') as scratch:
    for scene in SCENES:
        scene['first'] = index
        folder = Path(scratch) / str(index)
        folder.mkdir()
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(SOURCE / f"{scene['clip']}.mp4"),
            '-ss', str(scene['offset']), '-t', str(scene['duration']), '-vf', f"fps={scene['count'] / scene['duration']},scale=1280:720:flags=lanczos",
            '-frames:v', str(scene['count']), str(folder / '%04d.png')], check=True)
        frames = sorted(folder.glob('*.png'))
        if len(frames) != scene['count']:
            raise SystemExit(f"{scene['name']}: expected {scene['count']} frames; got {len(frames)}")
        for frame in frames:
            original = Image.open(frame).convert('RGB')
            for rendition, size, quality in [('desktop', (1280, 720), 84)]:
                image = ImageOps.fit(original, size, Image.Resampling.LANCZOS)
                image.save(DEST / rendition / f'frame_{index:04d}.webp', 'WEBP', quality=quality, method=6)
            index += 1
        # Mobile is authored as a portrait crop from the full-resolution source,
        # rather than magnifying a downsampled wide image until the face disappears.
        portrait = folder / 'portrait'
        portrait.mkdir()
        focal_start, focal_end = scene.get('mobile_start', .86), scene.get('mobile_end', .86)
        focal = str(focal_start)
        if focal_start != focal_end:
            focal = f"({focal_start}+({focal_end}-{focal_start})*min(max((t-{scene['offset']})/{scene['duration']}\\,0)\\,1))"
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(SOURCE / f"{scene['clip']}.mp4"),
            '-ss', str(scene['offset']), '-t', str(scene['duration']), '-vf',
            f"fps={scene['count'] / scene['duration']},crop=ih*9/16:ih:(iw-ih*9/16)*{focal}:0,scale=648:1152:flags=lanczos",
            '-frames:v', str(scene['count']), str(portrait / '%04d.png')], check=True)
        mobile_frames = sorted(portrait.glob('*.png'))
        if len(mobile_frames) != scene['count']:
            raise SystemExit(f"{scene['name']}: incomplete portrait frames")
        for local, frame in enumerate(mobile_frames):
            Image.open(frame).convert('RGB').save(DEST / 'mobile' / f"frame_{scene['first'] + local:04d}.webp",
                'WEBP', quality=80, method=6)
        print(f"{scene['name']}: {scene['first']:04d}–{index - 1:04d}", flush=True)

shutil.copyfile(DEST / 'desktop/frame_0000.webp', DEST / 'opening.webp')
shutil.copyfile(DEST / 'desktop' / f'frame_{index - 1:04d}.webp', DEST / 'held.webp')
# The current main process may predate the media routes. Its landing still gets
# the exact final still without restarting hardware or requiring a new route.
landing = ROOT / 'public/landing.html'
inline_poster = 'data:image/webp;base64,' + base64.b64encode((DEST / 'held.webp').read_bytes()).decode('ascii')
landing.write_text(re.sub(r'(id="story-poster"[^>]*?src=")[^"]+', lambda match: match[1] + inline_poster, landing.read_text()))
manifest = dict(revision=8, totalFrames=index, holdStart=round(.98 / 1.10, 8), reframeEnd=1,
    renditions=dict(desktop=dict(width=1280, height=720), mobile=dict(width=648, height=1152)),
    scenes=[{k: scene[k] for k in ['id', 'name', 'first', 'count', 'start', 'end', 'clip', 'offset', 'duration']} for scene in SCENES])
(DEST / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')

# Contact sheets show every tenth pose, including the frame on each side of a cut.
samples = sorted(set(list(range(0, index, 10)) + [scene['first'] for scene in SCENES]
    + [39, 49, 59, 69, 71, 73, 75, 77, 79, 80, 169, 179, 189, 199, 209, 219, 220, index - 1]))
sheet = Image.new('RGB', (4 * 384, ((len(samples) + 3) // 4) * 240), '#f8f7f4')
draw = ImageDraw.Draw(sheet)
for pos, number in enumerate(samples):
    frame = Image.open(DEST / 'desktop' / f'frame_{number:04d}.webp').resize((384, 216), Image.Resampling.LANCZOS)
    x, y = (pos % 4) * 384, (pos // 4) * 240
    sheet.paste(frame, (x, y)); draw.text((x + 8, y + 220), f'Frame {number:04d}', fill='#45413a')
sheet.save(SOURCE / 'contact-sheet.jpg', quality=92)
for rendition in ['desktop', 'mobile']:
    assets = list((DEST / rendition).glob('*.webp'))
    total = sum(asset.stat().st_size for asset in assets)
    print(f'{rendition}: {len(assets)} frames, {total / 1024 / 1024:.2f} MiB', flush=True)
print('Frame 0259 is the hold. Website choreography does not advance it.', flush=True)
