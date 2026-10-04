"""Package the marketing landing and its assets for Cloudflare Pages direct upload."""
from pathlib import Path
import hashlib
import json
import re
import shutil

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / 'public'
DEST = ROOT / 'output/cloudflare-landing'
DEST.mkdir(parents=True, exist_ok=True)

# Copy an explicit asset set; operational code, state, and credentials stay local.
for name in ['styles.css', 'landing.js']:
    shutil.copyfile(PUBLIC / name, DEST / name)
for name in ['fonts', 'media/story']:
    shutil.copytree(PUBLIC / name, DEST / name, dirs_exist_ok=True)
for name in ['media/lifeline-logo.png', 'media/ehr-workspace.png']:
    shutil.copyfile(PUBLIC / name, DEST / name)

html = (PUBLIC / 'landing.html').read_text()
def public_action(match):
    return match[0].replace('href="/dashboard"', 'href="#how-it-works"').replace(
        'Enter the care workspace', 'Explore how LIFELINE works').replace('Care workspace', 'How it works')
html = re.sub(r'<a\b[^>]*href="/dashboard"[^>]*>.*?</a>', public_action, html, flags=re.S)
html = html.replace('href="/ehr"', 'href="#hospital-context"').replace(
    'aria-label="Open the read-only patient workspace"', 'aria-label="Explore read-only care context"').replace(
    'Open record ↗', 'Explore care context ↗')
(DEST / 'index.html').write_text(html)
(DEST / '404.html').write_text('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LIFELINE</title><body><p>This page is unavailable. <a href="/">Return to LIFELINE.</a></p></body></html>')
(DEST / '_headers').write_text('''/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Cache-Control: no-cache
/media/story/desktop/*
  Cache-Control: public, max-age=31536000, immutable
/media/story/mobile/*
  Cache-Control: public, max-age=31536000, immutable
/fonts/*
  Cache-Control: public, max-age=31536000, immutable
''')

assets = [p for p in DEST.rglob('*') if p.is_file()]
assert len(assets) < 20000
assert all(p.stat().st_size < 25 * 1024 * 1024 for p in assets)
assert all(p.suffix not in ['.mp4', '.env', '.ts'] for p in assets)
assert '/dashboard' not in html
assert 'href="/ehr"' not in html
report = {
    'directory': str(DEST), 'files': len(assets),
    'bytes': sum(p.stat().st_size for p in assets),
    'landingSha256': hashlib.sha256(html.encode()).hexdigest(),
    'sequenceRevision': json.loads((DEST / 'media/story/manifest.json').read_text())['revision'],
    'scope': 'Marketing landing; public actions explain the product. Connected care workspace stays local.',
}
(ROOT / 'output/cloudflare-landing-build.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
