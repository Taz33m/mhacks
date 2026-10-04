// Turns offline replay reports into the detection counts we can honestly quote.
//   npm run --silent replay:motion -- data/trials/trial-A.jsonl data/trials/trial-B.jsonl > /tmp/replay.json
//   npm run summary:detection -- /tmp/replay.json
// Record one trial per scenario (staged-fall, sit, bend, ...) and add a marker right before each
// repetition; each marker counts as one event. Without markers, a whole trial counts as one event.
import { readFileSync } from 'node:fs';

type Trial = { label: string; scenario: string; status: string; candidates?: { atMs: number }[] | null;
  markers?: { atMs: number; label: string }[] };
const WINDOW_MS = 10_000;

const inputs = process.argv.slice(2);
if (!inputs.length) { console.error('Usage: npm run summary:detection -- replay-report.json [...]'); process.exit(1); }
const trials: Trial[] = inputs.flatMap(file => (JSON.parse(readFileSync(file, 'utf8')).files ?? [])
  .flatMap((report: { trials?: Trial[] }) => report.trials ?? []));

const tally = new Map<string, { events: number; hits: number }>();
let unscored = 0;
for (const trial of trials) {
  if (trial.status !== 'replayed' || !Array.isArray(trial.candidates)) { unscored++; continue; }
  const markers = [...(trial.markers ?? [])].sort((a, b) => a.atMs - b.atMs);
  const windows = markers.length
    ? markers.map((m, k) => [m.atMs, Math.min(markers[k + 1]?.atMs ?? Infinity, m.atMs + WINDOW_MS)])
    : [[-Infinity, Infinity]];
  const entry = tally.get(trial.scenario) ?? { events: 0, hits: 0 };
  for (const [from, to] of windows) {
    entry.events++;
    if (trial.candidates.some(c => c.atMs >= from && c.atMs < to)) entry.hits++;
  }
  tally.set(trial.scenario, entry);
}

const falls = tally.get('staged-fall') ?? { events: 0, hits: 0 };
const everyday = [...tally].filter(([scenario]) => scenario !== 'staged-fall');
const falseCheckins = everyday.reduce((n, [, e]) => n + e.hits, 0);
const everydayEvents = everyday.reduce((n, [, e]) => n + e.events, 0);
console.log(`Staged falls detected: ${falls.hits}/${falls.events}`);
console.log(`False check-ins in everyday movements: ${falseCheckins}/${everydayEvents}`
  + (everyday.length ? ` (${everyday.map(([s, e]) => `${s} ${e.hits}/${e.events}`).join(', ')})` : ''));
if (unscored) console.log(`Unscored trials (missing samples or alignment): ${unscored}`);
console.log('Staged movements by the team with the current provisional detector; not real-world fall accuracy.');
