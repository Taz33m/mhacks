"""Package only the marketing landing and its explicit assets for Cloudflare Pages."""
from pathlib import Path
import hashlib
import json
import re
import shutil
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_FILES = (
    'twin/lab.html', 'twin/lab.css', 'twin/lab.js', 'twin/kinematics.js', 'vendor/location-engine.js',
    'styles.css', 'landing.js', 'brand.html', 'brand.css', 'brand.js',
    'favicon.svg', 'favicon.ico', 'favicon-16.png', 'favicon-32.png', 'apple-touch-icon.png',
    'fonts/cormorant-regular.ttf', 'fonts/cormorant-italic.ttf', 'fonts/Cormorant-OFL.txt',
    'fonts/dm-sans-regular.ttf', 'fonts/DM-Sans-OFL.txt', 'fonts/aspekta-variable.woff2', 'fonts/Aspekta-LICENSE.txt',
    'media/brand/identity-board.png', 'media/brand/lifeline-mark.svg', 'media/brand/lifeline-mark-white.svg',
    'media/brand/lifeline-brand-kit.zip', 'media/brand/color-tokens.json', 'media/brand/lifeline-logo-original.png',
    'media/lifeline-logo.png', 'media/ehr-workspace.png',
    'media/avatars/doctor-chen.jpg', 'media/avatars/care-team.jpg',
    'media/story/manifest.json', 'media/story/opening.webp', 'media/story/held.webp',
)
GENERATED_FILES = {'index.html', '404.html', '_headers', 'motion-lab/index.html'}
HEADERS = '''/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Cache-Control: no-cache
/media/story/desktop/*
  Cache-Control: public, max-age=31536000, immutable
/media/story/mobile/*
  Cache-Control: public, max-age=31536000, immutable
/fonts/*
  Cache-Control: public, max-age=31536000, immutable
'''


def source_files(public: Path):
    manifest = json.loads((public / 'media/story/manifest.json').read_text())
    count = manifest.get('totalFrames')
    if type(count) is not int or not 1 <= count <= 9999 or set(manifest.get('renditions', {})) != {'desktop', 'mobile'}:
        raise ValueError('Sequence must declare a bounded desktop/mobile frame set.')
    names = set(PUBLIC_FILES)
    names.update(f'media/story/{rendition}/frame_{index:04d}.webp'
                 for rendition in ['desktop', 'mobile'] for index in range(count))
    if len(names) + len(GENERATED_FILES) >= 20000:
        raise ValueError('Public bundle exceeds the file limit.')
    for name in names | {'landing.html'}:
        source = public / name
        if source.is_symlink() or not source.is_file() or not source.resolve().is_relative_to(public.resolve()):
            raise ValueError(f'Required public asset is missing or outside the public directory: {name}')
        if source.stat().st_size >= 25 * 1024 * 1024:
            raise ValueError(f'Public asset exceeds the size limit: {name}')
    return names, manifest


def public_html(public: Path):
    html = (public / 'landing.html').read_text()
    def public_action(match):
        return match[0].replace('href="/dashboard"', 'href="#how-it-works"').replace(
            'Enter the care workspace', 'Explore how LIFELINE works').replace('Care workspace', 'How it works')
    html = re.sub(r'<a\b[^>]*href="/dashboard"[^>]*>.*?</a>', public_action, html, flags=re.S)
    html = html.replace('href="/ehr"', 'href="#hospital-context"').replace(
        'aria-label="Open the read-only patient workspace"', 'aria-label="Explore read-only care context"').replace(
        'Open record ↗', 'Explore care context ↗')
    if '/dashboard' in html or 'href="/ehr"' in html:
        raise ValueError('Public landing still links to an operational workspace.')
    return html


def validate_bundle(directory: Path, expected: set[str]):
    paths = list(directory.rglob('*'))
    if any(path.is_symlink() for path in paths):
        raise ValueError('Public bundle cannot contain symbolic links.')
    assets = [path for path in paths if path.is_file()]
    actual = {path.relative_to(directory).as_posix() for path in assets}
    if actual != expected:
        raise ValueError('Public bundle does not match the complete generated asset allowlist.')
    if len(assets) >= 20000 or any(path.stat().st_size >= 25 * 1024 * 1024 for path in assets):
        raise ValueError('Public bundle exceeds Cloudflare asset limits.')
    return assets


def build(root: Path = ROOT):
    root = root.resolve()
    public, output = root / 'public', root / 'output'
    dest, report_path = output / 'cloudflare-landing', output / 'cloudflare-landing-build.json'
    if public.is_symlink() or output.is_symlink() or dest.is_symlink() or report_path.is_symlink():
        raise ValueError('Managed public build paths cannot be symbolic links.')
    if dest.exists() and not dest.is_dir():
        raise ValueError('The managed build destination must be a directory.')
    names, manifest = source_files(public)
    html = public_html(public)
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.cloudflare-landing-', dir=output) as temporary:
        stage = Path(temporary) / 'bundle'
        stage.mkdir()
        for name in sorted(names):
            target = stage / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(public / name, target)
        (stage / 'index.html').write_text(html)
        (stage / 'motion-lab').mkdir()
        (stage / 'motion-lab/index.html').write_text((public / 'twin/lab.html').read_text().replace('href="/dashboard#motion"', 'href="/#how-it-works"').replace('Live motion ↗', 'The signal ↗'))
        (stage / '404.html').write_text('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LIFELINE</title><body><p>This page is unavailable. <a href="/">Return to LIFELINE.</a></p></body></html>')
        (stage / '_headers').write_text(HEADERS)
        assets = validate_bundle(stage, names | GENERATED_FILES)
        report = {
            'directory': str(dest), 'files': len(assets),
            'bytes': sum(path.stat().st_size for path in assets),
            'landingSha256': hashlib.sha256(html.encode()).hexdigest(),
            'sequenceRevision': manifest['revision'],
            'scope': 'Marketing landing; public actions explain the product. Connected care workspace stays local.',
        }
        # Validate a fresh bundle before replacing only this managed output directory.
        previous = output / f'.cloudflare-landing-old-{uuid.uuid4().hex}' if dest.exists() else None
        if previous:
            dest.rename(previous)
        try:
            stage.rename(dest)
        except OSError:
            if previous:
                previous.rename(dest)
            raise
        if previous:
            shutil.rmtree(previous)
    report_path.write_text(json.dumps(report, indent=2) + '\n')
    return report


if __name__ == '__main__':
    print(json.dumps(build(), indent=2))
