import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { SCENARIOS, TWIN_SCHEMA, traceFor, gaitDays } from '../../public/twin/kinematics.js';

// Explicit opt-in only. Incompatible schema and dedicated directory prevent a live replay.
if (!process.argv.includes('--offline-only')) throw new Error('Use --offline-only; never submit these traces to /motion.');
const directory = resolve('output/digital-twin');
await mkdir(directory, { recursive: true });
for (const scenario of Object.keys(SCENARIOS)) {
  const samples = traceFor(scenario);
  await writeFile(join(directory, `${scenario}.json`), JSON.stringify({ schema: TWIN_SCHEMA,
    provenance: 'synthetic-kinematic', notForTraining: true, sampleHz: 60,
    limitations: ['No contact-force or tissue model', 'No clinical validation', 'No fitted/rigged source mesh', 'No connection to live detection'], samples }, null, 2));
}
await writeFile(join(directory, 'gait-days.json'), JSON.stringify({ schema: TWIN_SCHEMA, provenance: 'synthetic-illustrative', notForTraining: true, days: gaitDays() }, null, 2));
console.log('Offline exports saved to output/digital-twin. Live detector and hardware unchanged.');
