import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'darwin') throw new Error('Native local setup requires macOS.');
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24+ is required.');
const root = resolve(import.meta.dirname, '..');
if (!existsSync(resolve(root, '.env'))) {
  const example = readFileSync(resolve(root, '.env.example'), 'utf8');
  writeFileSync(resolve(root, '.env'), example.replace('LIFELINE_HOST=127.0.0.1', 'LIFELINE_HOST=0.0.0.0'), { mode: 0o600 });
  console.log('Created private .env for phone access on the local development network.');
}
const dataDir = resolve(root, process.env.LIFELINE_DATA_DIR ?? 'data');
mkdirSync(dataDir, { recursive: true });
const tokenPath = resolve(dataDir, 'pairing-token');
if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(24).toString('hex'), { mode: 0o600 });
const token = readFileSync(tokenPath, 'utf8').trim();
if (!/^[a-zA-Z0-9_-]{20,200}$/.test(token)) throw new Error('Unexpected pairing token format. Existing token was not changed.');
const domain = 'org.lifeline.waistmotion';
const existing = spawnSync('/usr/bin/defaults', ['export', domain, '-'], { encoding: 'utf8' });
let preferences: Record<string, unknown> = {};
if (existing.status === 0) {
  const parsed = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], { input: existing.stdout, encoding: 'utf8' });
  if (parsed.status !== 0) throw new Error('Could not read existing app preferences; they were not changed.');
  preferences = JSON.parse(parsed.stdout);
}
preferences['lifeline.relayHost'] = '127.0.0.1';
preferences['lifeline.pairToken'] = token;
const xml = spawnSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '--', '-'], { input: JSON.stringify(preferences), encoding: 'utf8' });
if (xml.status !== 0) throw new Error('Could not prepare app preferences.');
const imported = spawnSync('/usr/bin/defaults', ['import', domain, '-'], { input: xml.stdout, encoding: 'utf8' });
if (imported.status !== 0) throw new Error('Could not pair the local app.');
console.log('Paired the waist app to this backend. Token remains private.');
const installed = spawnSync('/bin/zsh', ['native/macos/install.sh', '--open'], { cwd: root, stdio: 'inherit' });
if (installed.status !== 0) process.exit(installed.status ?? 1);
console.log('Start the backend with npm start. Enable motion in the waist app after connecting AirPods.');
