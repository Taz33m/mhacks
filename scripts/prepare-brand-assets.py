"""Package supplied identity artwork and browser icon formats without redrawing it."""
from pathlib import Path
import base64
import json
import shutil
import subprocess
import struct
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / 'public'
DEST = PUBLIC / 'media/brand'
DEST.mkdir(parents=True, exist_ok=True)
SOURCE = PUBLIC / 'media/lifeline-logo.png'
BOARD = Path('/Users/tazeemmahashin/Downloads/Lifeline Brand Identity System Board (1).png')
if BOARD.exists():
    shutil.copyfile(BOARD, DEST / 'identity-board.png')
if not (DEST / 'identity-board.png').exists():
    raise SystemExit('The supplied identity board is missing.')
shutil.copyfile(SOURCE, DEST / 'lifeline-logo-original.png')

# The SVG wraps the exact supplied pixels as a luminance mask. It does not
# reconstruct the three shapes or substitute AI-generated artwork.
encoded = base64.b64encode(SOURCE.read_bytes()).decode('ascii')
def mark(fill, background=''):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 640 640">
<defs><mask id="triad" x="0" y="0" width="640" height="640" maskUnits="userSpaceOnUse" style="mask-type:luminance"><image x="-306" y="-306" width="1254" height="1254" href="data:image/png;base64,{encoded}"/></mask></defs>
{background}<path fill="{fill}" mask="url(#triad)" d="M0 0H640V640H0Z"/>
</svg>'''

(DEST / 'lifeline-mark.svg').write_text(mark('#1F1F1F'))
(DEST / 'lifeline-mark-white.svg').write_text(mark('#FAF8F4'))
(PUBLIC / 'favicon.svg').write_text(mark('#FAF8F4', '<rect width="640" height="640" rx="140" fill="#1F1F1F"/>'))

# Export the SVG through the browser's renderer, then package its PNG sizes
# in a standard ICO container. The supplied raster artwork remains unchanged.
subprocess.run(['node', str(ROOT / 'scripts/export-brand-icons.mjs')], check=True)
icon_images = [(size, (PUBLIC / f'favicon-{size}.png').read_bytes()) for size in (16,32)]
offset = 6 + len(icon_images) * 16
entries = []
for size,data in icon_images:
    entries.append(struct.pack('<BBBBHHII', size, size, 0, 0, 1, 32, len(data), offset))
    offset += len(data)
(PUBLIC / 'favicon.ico').write_bytes(struct.pack('<HHH',0,1,len(icon_images)) + b''.join(entries) + b''.join(data for size,data in icon_images))

tokens = {
    'charcoal': '#1F1F1F', 'ivory': '#FAF8F4',
    'activation': {'peach': '#FFC6A5', 'lilac': '#D8B7F3', 'periwinkle': '#A8ABFF',
                   'blue': '#96BEF4', 'mint': '#98DDC6'},
    'typeface': 'Aspekta', 'weight': 500,
    'note': 'Charcoal and ivory follow the supplied board. Activation hex values are web specifications sampled visually from its gradient.'
}
(DEST / 'color-tokens.json').write_text(json.dumps(tokens, indent=2) + '\n')
with zipfile.ZipFile(DEST / 'lifeline-brand-kit.zip', 'w', zipfile.ZIP_DEFLATED) as kit:
    for name in ['lifeline-logo-original.png', 'lifeline-mark.svg', 'lifeline-mark-white.svg',
                 'identity-board.png', 'color-tokens.json']:
        kit.write(DEST / name, name)
    for name in ['favicon.svg', 'favicon.ico', 'favicon-16.png', 'favicon-32.png', 'apple-touch-icon.png']:
        kit.write(PUBLIC / name, 'icons/' + name)
    for name in ['aspekta-variable.woff2', 'Aspekta-LICENSE.txt']:
        kit.write(PUBLIC / 'fonts' / name, 'type/' + name)
print('Prepared supplied logo, identity board, SVG wrappers, browser icons and downloadable brand kit.')
