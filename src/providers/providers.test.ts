import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Incident, ProviderInbound } from '../contracts.ts';
import { CHECKIN_TEXT, FINCH_DEMO_URL, createProviders } from './index.ts';
import { createPhotonAdapter, normalizePhoton, type PhotonClient, type PhotonMessage } from './photon.ts';

const incident: Incident = {
  id: 'A17', phase: 'HELP_REQUESTED', version: 1, createdAt: 1_000, updatedAt: 1_020,
  evidence: { kind: 'cross-body', summary: 'Chest impact and waist posture change' },
  checkinId: 'check-17', checkinDeadline: 1_020, progressDeadline: null, ownerId: null,
  handoff: '', outcome: null, resolutionActor: null,
};
const fixture = {
  synthetic: true, environment: 'demo', meta: { dataAsOf: '2026-08-25T17:00:00Z' },
  data: {
    medications: [{ id: 'med-1', name: 'Example medication', dosage: 'Fixture dosage', status: 'active' }],
    allergies: [{ id: 'allergy-1', substance: 'Penicillin', reaction: 'Fixture rash', status: 'active' }],
    conditions: [],
  },
};
const mp3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0]);
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
function fetchStub(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input, init) => handler(String(input), init)) as typeof fetch;
}
function message(content: unknown, extras: Partial<PhotonMessage> = {}): PhotonMessage {
  return { id: 'incoming-1', platform: 'imessage', direction: 'inbound', sender: { id: '+15551234567' }, content, ...extras };
}

test('missing credentials never create an SDK client, fake delivery, or generate audio', async () => {
  let called = false;
  const providers = createProviders({ env: {}, fetch: fetchStub(() => { throw new Error('must not fetch'); }), photonFactory: async () => { called = true; throw new Error('must not initialize'); } });
  assert.equal((await providers.sendMessage('+15551234567', 'alert')).status, 'failed');
  assert.match(providers.providerStatus().photon.detail, /Unconfigured/);
  assert.equal(await providers.prepareCheckinAudio(), null);
  await (await providers.startPhotonListener(async () => { throw new Error('must not listen'); }))();
  assert.equal(called, false);
});

test('health uses only keyless synthetic fixture, retains IDs, and marks empty entries unknown', async () => {
  const providers = createProviders({ env: {}, now: () => 10_000, fetch: fetchStub((url, init) => {
    assert.equal(url, FINCH_DEMO_URL);
    assert.equal(init?.headers, undefined);
    return json(fixture);
  }) });
  const health = await providers.loadHealth();
  assert.equal(health.available, true);
  assert.deepEqual(health.recordIds, ['med-1', 'allergy-1']);
  assert.match(health.summary, /conditions: no records returned; absence is not established/);
  assert.match(health.summary, /2026-08-25/);
  const handoff = await providers.buildHandoff(incident, health);
  assert.match(handoff, /Location not provided/);
  assert.match(handoff, /ON IT A17/);
  assert.match(handoff, /\[allergy-1\]/);
  assert.match(await providers.answerQuestion(incident, health, 'What allergies were recorded?'), /Fixture rash/);
  assert.match(await providers.answerQuestion(incident, health, 'What medications does she take?'), /Example medication/);
});

test('lookup errors, missing categories and non-synthetic payloads remain unavailable', async () => {
  for (const response of [json({}, 410), json({ ...fixture, synthetic: false }), json({ synthetic: true, environment: 'demo', data: {} })]) {
    const providers = createProviders({ env: {}, fetch: fetchStub(() => response) });
    const health = await providers.loadHealth();
    assert.equal(health.available, false);
    assert.deepEqual(health.recordIds, []);
    assert.match(await providers.answerQuestion(incident, health, 'Does she have allergies?'), /unavailable/);
  }
});

test('malformed Finch nested fields and duplicate IDs cannot become available health context', async () => {
  const invalid = [
    { ...fixture, data: { ...fixture.data, medications: [{ id: 'med-1', name: { text: 'Nested name' } }] } },
    { ...fixture, data: { ...fixture.data, medications: [{ id: 'med-1', name: 'Medication', status: { code: 'active' } }] } },
    { ...fixture, data: { ...fixture.data, medications: [{ id: 'med-1', name: 'Medication', dosage: ['nested dosage'] }] } },
    { ...fixture, data: { ...fixture.data, allergies: [{ id: 'allergy-1', substance: 'Penicillin', severity: 3 }] } },
    { ...fixture, data: { ...fixture.data, conditions: [null] } },
    { ...fixture, data: { ...fixture.data, conditions: [{ id: 'med-1', name: 'Duplicate record ID' }] } },
    { ...fixture, meta: { dataAsOf: { date: '2026-08-25' } } },
  ];
  for (const payload of invalid) {
    const providers = createProviders({ env: {}, fetch: fetchStub(() => json(payload)) });
    const health = await providers.loadHealth();
    assert.equal(health.available, false);
    assert.deepEqual(health.recordIds, []);
    assert.match(providers.providerStatus().finchnode.detail, /unavailable/);
    assert.match(await providers.answerQuestion(incident, health, 'What medications are recorded?'), /unavailable/);
  }
});

test('bounded Finch read rejects oversized and non-JSON bodies', async () => {
  for (const response of [
    new Response('<html>error</html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response('x'.repeat(1_000_001), { headers: { 'Content-Type': 'application/json' } }),
    new Response(JSON.stringify(fixture), { headers: { 'Content-Type': 'application/json', 'Content-Length': '2000000' } }),
  ]) {
    const providers = createProviders({ env: {}, fetch: fetchStub(() => response) });
    assert.equal((await providers.loadHealth()).available, false);
  }
});

test('bounded LLM ranks only known records; model medical prose is never rendered', async () => {
  let requests = 0;
  const providers = createProviders({
    env: { LIFELINE_LLM_API_KEY: 'mock', LIFELINE_LLM_BASE_URL: 'https://model.example/v1', LIFELINE_LLM_MODEL: 'mock-model' },
    fetch: fetchStub((url, init) => {
      if (url === FINCH_DEMO_URL) return json(fixture);
      requests++;
      assert.equal(url, 'https://model.example/v1/chat/completions');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.tools, undefined);
      assert.match(body.messages[1].content, /allergy-1/);
      return json({ choices: [{ message: { content: JSON.stringify({ recordIds: ['allergy-1'], answer: 'Invented diagnosis' }) } }] });
    }),
  });
  const health = await providers.loadHealth();
  const answer = await providers.answerQuestion(incident, health, 'What allergies are recorded?');
  assert.match(answer, /Penicillin/);
  assert.doesNotMatch(answer, /Invented diagnosis/);
  assert.doesNotMatch(answer, /Example medication/);
  const before = requests;
  assert.match(await providers.answerQuestion(incident, health, 'Should I administer a medicine?'), /cannot recommend treatment/);
  assert.equal(requests, before);
});

test('invented LLM record ID falls back to actual records', async () => {
  const providers = createProviders({
    env: { LIFELINE_LLM_API_KEY: 'mock', LIFELINE_LLM_BASE_URL: 'https://model.example/v1', LIFELINE_LLM_MODEL: 'mock' },
    fetch: fetchStub((url) => url === FINCH_DEMO_URL ? json(fixture) : json({ choices: [{ message: { content: '{"recordIds":["invented-record"]}' } }] })),
  });
  const answer = await providers.answerQuestion(incident, await providers.loadHealth(), 'What allergies are recorded?');
  assert.match(answer, /template fallback/);
  assert.doesNotMatch(answer, /invented-record/);
});

test('audio is cached and failures do not repeatedly generate clips', async () => {
  for (const status of [200, 401]) {
    let calls = 0;
    const providers = createProviders({
      env: { ELEVENLABS_API_KEY: 'mock', ELEVENLABS_VOICE_ID: 'voice-1' },
      fetch: fetchStub((url, init) => {
        calls++;
        assert.equal(url, 'https://api.elevenlabs.io/v1/text-to-speech/voice-1?output_format=mp3_44100_128');
        assert.deepEqual(JSON.parse(String(init?.body)), { text: CHECKIN_TEXT, model_id: 'eleven_multilingual_v2' });
        return new Response(mp3, { status, headers: { 'Content-Type': status === 200 ? 'audio/mpeg' : 'application/json' } });
      }),
    });
    const [first, second] = await Promise.all([providers.prepareCheckinAudio(), providers.prepareCheckinAudio()]);
    assert.equal(calls, 1);
    assert.equal(first, second);
    if (status === 200) assert.deepEqual(first, mp3);
    else assert.equal(first, null);
  }
});

test('speech rejects JSON/errors, wrong output format, empty and oversized responses', async () => {
  const responses = [
    json({ error: 'quota unavailable' }),
    new Response(JSON.stringify({ error: 'upstream error' }), { headers: { 'Content-Type': 'audio/mpeg' } }),
    new Response(mp3, { status: 401, headers: { 'Content-Type': 'audio/mpeg' } }),
    new Response(mp3, { headers: { 'Content-Type': 'audio/wav' } }),
    new Response(new Uint8Array(), { headers: { 'Content-Type': 'audio/mpeg' } }),
    new Response(mp3, { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '5000001' } }),
    new Response(new Uint8Array(5_000_001), { headers: { 'Content-Type': 'audio/mpeg' } }),
  ];
  for (const response of responses) {
    let calls = 0;
    const providers = createProviders({
      env: { ELEVENLABS_API_KEY: 'mock', ELEVENLABS_VOICE_ID: 'voice-1' },
      fetch: fetchStub(() => { calls++; return response; }),
    });
    assert.equal(await providers.prepareCheckinAudio(), null);
    assert.equal(await providers.prepareCheckinAudio(), null);
    assert.equal(calls, 1);
    assert.equal(providers.providerStatus().elevenlabs.configured, true);
    assert.match(providers.providerStatus().elevenlabs.detail, /failed; audio unavailable/);
  }
});

test('Photon maps own identity, target IDs, replies, added likes, and explicit removals', () => {
  const target = { id: 'sent-alert-1' };
  assert.deepEqual(normalizePhoton(message({ type: 'reaction', emoji: '👍', target })), {
    messageId: 'incoming-1', sender: '+15551234567', targetMessageId: 'sent-alert-1', kind: 'reaction', reaction: '👍', removed: false,
  });
  assert.equal(normalizePhoton(message({ type: 'reaction', emoji: '👍', target }, { reactionRecord: { selected: false } }))?.removed, true);
  assert.equal(normalizePhoton(message({ type: 'unsend', target: { id: 'reaction-1', content: { type: 'reaction', emoji: '👍', target } } }))?.removed, true);
  assert.deepEqual(normalizePhoton(message({ type: 'reply', target, content: { type: 'text', text: 'ON IT A17' } })), {
    messageId: 'incoming-1', sender: '+15551234567', targetMessageId: 'sent-alert-1', kind: 'text', text: 'ON IT A17',
  });
  assert.equal(normalizePhoton(message({ type: 'reaction', emoji: '👎', target })), null);
  assert.equal(normalizePhoton(message({ type: 'reaction', emoji: '👍', target }, { direction: 'outbound' })), null);
  assert.equal(normalizePhoton(message({ type: 'text', text: 'accept' }, { sender: undefined })), null);
});

test('Photon preserves accepted ID; missing IDs/errors after send are unknown', async () => {
  for (const result of ['id', 'empty', 'error']) {
    let sends = 0;
    const client: PhotonClient = {
      messages: (async function* () {})(), stop: async () => {},
      openDm: async () => ({ send: async () => {
        sends++;
        if (result === 'error') throw new Error('transport failed');
        return result === 'id' ? { id: 'actual-provider-guid' } : undefined;
      } }),
    };
    const adapter = createPhotonAdapter({ projectId: 'mock', projectSecret: 'mock', factory: async () => client });
    const sent = await adapter.sendMessage('+15551234567', 'alert');
    assert.equal(sent.status, result === 'id' ? 'provider_accepted' : 'unknown');
    assert.equal(sent.messageId, result === 'id' ? 'actual-provider-guid' : undefined);
    assert.equal(sends, 1);
  }
});

test('Photon failure before send is confirmed failed; timeout after send is unknown', async () => {
  const before = createPhotonAdapter({ projectId: 'mock', projectSecret: 'mock', factory: async () => { throw new Error('no connection'); } });
  assert.equal((await before.sendMessage('+15551234567', 'alert')).status, 'failed');
  const after = createPhotonAdapter({ projectId: 'mock', projectSecret: 'mock', timeoutMs: 5, factory: async () => ({
    messages: (async function* () {})(), stop: async () => {},
    openDm: async () => ({ send: () => new Promise(() => {}) }),
  }) });
  assert.equal((await after.sendMessage('+15551234567', 'alert')).status, 'unknown');
});

test('listener forwards provider facts without authorizing sender or mutating state', async () => {
  const events: ProviderInbound[] = [];
  let stopCalls = 0;
  const client: PhotonClient = {
    messages: (async function* () {
      yield [undefined, message({ type: 'text', text: 'I am not safe' })] as const;
      yield [undefined, message({ type: 'reaction', emoji: '👍', target: { id: 'actual-alert' } }, { id: 'reaction-17' })] as const;
    })(),
    openDm: async () => undefined, stop: async () => { stopCalls++; },
  };
  const adapter = createPhotonAdapter({ projectId: 'mock', projectSecret: 'mock', factory: async () => client });
  const stop = await adapter.startPhotonListener(async (event) => { events.push(event); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 2);
  assert.equal(events[0].text, 'I am not safe');
  await stop();
  await stop();
  assert.equal(stopCalls, 1);
});
