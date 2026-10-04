"""Isolated public bundle regressions; no deployment or live files are touched."""
from pathlib import Path
import importlib.util
import json
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('cloudflare_landing', Path(__file__).with_name('build-cloudflare-landing.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class PublicBundleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.public = self.root / 'public'
        for name in builder.PUBLIC_FILES:
            path = self.public / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'Generated public asset fixture')
        (self.public / 'media/story/manifest.json').write_text(json.dumps({
            'revision': 9, 'totalFrames': 2, 'renditions': {'desktop': {}, 'mobile': {}}}))
        for rendition in ['desktop', 'mobile']:
            for index in range(2):
                path = self.public / f'media/story/{rendition}/frame_{index:04d}.webp'
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'Generated frame fixture')
        (self.public / 'landing.html').write_text('<!doctype html><a href="/dashboard">Enter the care workspace</a><a href="/ehr">Open record ↗</a>')
        self.dest = self.root / 'output/cloudflare-landing'

    def test_rebuild_discards_stale_operational_files_and_ignores_unlisted_source_files(self):
        self.dest.mkdir(parents=True)
        for name in ['app.js', '.env', 'patient-record.json', 'data.sqlite', 'media/story/desktop/frame_9999.webp']:
            path = self.dest / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('Generated stale fixture, not real private data')
        for name in ['app.js', 'fonts/private.json', 'media/brand/extra.js']:
            (self.public / name).write_text('Generated excluded source fixture')
        report = builder.build(self.root)
        actual = {path.relative_to(self.dest).as_posix() for path in self.dest.rglob('*') if path.is_file()}
        self.assertNotIn('app.js', actual)
        self.assertNotIn('.env', actual)
        self.assertNotIn('patient-record.json', actual)
        self.assertNotIn('data.sqlite', actual)
        self.assertNotIn('fonts/private.json', actual)
        self.assertNotIn('media/brand/extra.js', actual)
        self.assertNotIn('media/story/desktop/frame_9999.webp', actual)
        self.assertEqual(actual, set(builder.PUBLIC_FILES) | builder.GENERATED_FILES | {
            f'media/story/{r}/frame_{i:04d}.webp' for r in ['desktop', 'mobile'] for i in range(2)})
        self.assertEqual(report['files'], len(actual))
        self.assertEqual(report['sequenceRevision'], 9)
        html = (self.dest / 'index.html').read_text()
        self.assertNotIn('/dashboard', html)
        self.assertNotIn('href="/ehr"', html)
        self.assertIn('href="#how-it-works"', html)
        self.assertIn('href="#hospital-context"', html)
        self.assertFalse(list((self.root / 'output').glob('.cloudflare-landing-*')))

    def test_missing_required_asset_preserves_previous_successful_bundle(self):
        self.dest.mkdir(parents=True)
        (self.dest / 'index.html').write_text('Previous successful fixture landing')
        (self.public / 'media/story/mobile/frame_0001.webp').unlink()
        with self.assertRaises(ValueError):
            builder.build(self.root)
        self.assertEqual((self.dest / 'index.html').read_text(), 'Previous successful fixture landing')

    def test_managed_destination_symlink_is_refused_without_touching_its_target(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'keep.txt').write_text('Unrelated fixture file')
        self.dest.parent.mkdir()
        self.dest.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            builder.build(self.root)
        self.assertEqual((outside / 'keep.txt').read_text(), 'Unrelated fixture file')
        self.assertTrue(self.dest.is_symlink())

    def test_source_symlink_cannot_copy_an_unrelated_file_into_the_public_bundle(self):
        outside = self.root / 'outside.txt'
        outside.write_text('Generated excluded fixture')
        source = self.public / 'styles.css'
        source.unlink()
        source.symlink_to(outside)
        with self.assertRaises(ValueError):
            builder.build(self.root)
        self.assertFalse(self.dest.exists())

    def test_complete_allowlist_rejects_even_a_small_unexpected_generated_file(self):
        stage = self.root / 'stage'
        stage.mkdir()
        (stage / 'index.html').write_text('Generated landing')
        (stage / 'incident.json').write_text('Generated excluded event fixture')
        with self.assertRaises(ValueError):
            builder.validate_bundle(stage, {'index.html'})


if __name__ == '__main__':
    unittest.main()
