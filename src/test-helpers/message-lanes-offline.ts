// Test-only preload: exercises the real server and Photon adapter using an
// in-memory native client. It cannot connect to Spectrum or any external API.
import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
import type { PhotonClient, PhotonSpace, PhotonMessage } from '../providers/photon.ts';
import { patientFixture } from './patient-fixture.ts';

const log = process.env.LIFELINE_TEST_TRANSPORT_LOG!;
const record = (event: string, phone: string) => appendFileSync(log, JSON.stringify({ event, phone, at: Date.now() }) + '\n');
let sequence = 0;
export async function offlinePhotonFactory(): Promise<PhotonClient> {
  let stopped = false, notify = () => {};
  let injected = false;
  const queue: PhotonMessage[] = [];
  const inject = (id: string, text: string) => {
    queue.push({ id, platform: 'imessage', direction: 'inbound', sender: { id: '+12025550101', service: 'iMessage' },
      space: { id: 'any;-;+12025550101', phone: 'isolated-test-line', type: 'dm' },
      content: { type: 'text', text }, timestamp: new Date() }); notify();
  };
  const timers: ReturnType<typeof setTimeout>[] = [];
  const space = (phone: string): PhotonSpace => ({
    id: `any;-;${phone}`, phone: 'isolated-test-line', type: 'dm',
    send: async text => {
      record('submission-start', phone);
      if (phone === '+12025550100' && process.env.LIFELINE_TEST_INBOUND_QUESTION !== '1')
        await new Promise(resolve => setTimeout(resolve, 4000));
      record('submission-finish', phone);
      if (process.env.LIFELINE_TEST_INBOUND_QUESTION === '1' && phone === '+12025550101' && !injected) {
        injected = true;
        const code = text.match(/\bLF-[A-Z0-9-]+\b/)![0];
        timers.push(setTimeout(() => inject('offline-question', 'What medications are recorded?'), 20));
        timers.push(setTimeout(() => inject('offline-accept', `ON IT ${code}`), 160));
      }
      return { id: `offline-send-${++sequence}`, space: { id: `any;-;${phone}`, phone: 'isolated-test-line', type: 'dm' } };
    },
  });
  return { openDm: async phone => space(phone),
    messages: (async function* () {
      while (!stopped) {
        if (queue.length) { yield [null, queue.shift()!] as const; continue; }
        await new Promise<void>(resolve => { notify = resolve; });
      }
    })(), stop: async () => { stopped = true; timers.forEach(clearTimeout); notify(); } };
}

globalThis.fetch = async (input, init) => {
  if (String(input).startsWith('https://api.finchnode.com/demo/'))
    return new Response(JSON.stringify(patientFixture), { headers: { 'Content-Type': 'application/json' } });
  if (String(input) === 'https://model.example/v1/chat/completions') {
    const request = JSON.parse(String(init?.body));
    const question = request.max_tokens === 512;
    if (question) { record('generation-start', 'offline-model'); await new Promise(resolve => setTimeout(resolve, 2500)); }
    const plan = question
      ? { facts: [{ recordId: 'med-1', fields: ['name', 'dosage'] }], incidentFields: [], unavailable: [] }
      : { facts: [{ recordId: 'med-1', fields: ['name', 'dosage'] }, { recordId: 'allergy-1', fields: ['substance', 'reaction'] },
          { recordId: 'condition-1', fields: ['name'] }], incidentFields: ['evidence', 'createdAt'], unavailable: ['location', 'currentVitals'] };
    if (question) record('generation-finish', 'offline-model');
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }),
      { headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error('External network disabled in message-lane test.');
};

registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (url === new URL('../providers/index.ts', import.meta.url).href) {
    const source = String(result.source);
    if (!source.includes('const defaults = createProviders();')) throw new Error('Test preload could not inject offline Photon factory.');
    return { ...result, source: `import { offlinePhotonFactory } from '${import.meta.url}';\n` +
      source.replace('const defaults = createProviders();', 'const defaults = createProviders({ photonFactory: offlinePhotonFactory });') };
  }
  return result;
} });
