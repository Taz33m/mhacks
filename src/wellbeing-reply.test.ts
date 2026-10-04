import test from 'node:test';
import assert from 'node:assert/strict';
import { createWellbeingReply } from './wellbeing-reply.ts';
import type { WellbeingMessage, WellbeingPendingMessage } from './wellbeing.ts';

const env = { LIFELINE_LLM_API_KEY: 'offline-test-key', LIFELINE_LLM_BASE_URL: 'http://127.0.0.1:11434/v1', LIFELINE_LLM_MODEL: 'offline-model' };
const latest: WellbeingPendingMessage = { id: 'local-wearer-id', conversationId: 'WB-offline', speaker: 'wearer', text: 'I feel lonely today.',
  source: 'photon-imessage', at: 2000, delivery: 'recorded', replyToMessageId: 'private-native-id', replyChatId: 'private-chat', replyLineId: 'private-line' };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const model = (text: unknown) => json({ choices: [{ message: { content: JSON.stringify({ text }) } }] });

test('local AI receives bounded text-only conversation and reports actual validated generation', async () => {
  const context: WellbeingMessage[] = Array.from({ length: 12 }, (_, i) => ({ id: `old-${i}`, speaker: i % 2 ? 'wearer' : 'lifeline',
    text: `Prior conversation ${i}.`, source: i % 2 ? 'freewili-local-speech' : 'agent', at: i * 100, delivery: 'recorded' }));
  context.push(latest, { id: 'future', speaker: 'wearer', text: 'This arrived while generation was pending.', source: 'freewili-local-speech', at: 3000, delivery: 'recorded' });
  const original = JSON.stringify({ latest, context }); let calls = 0;
  const generator = createWellbeingReply({ env, fetch: (async (url, init) => {
    calls++; assert.equal(String(url), 'http://127.0.0.1:11434/v1/chat/completions');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.max_tokens, 160); assert.equal(body.response_format.json_schema.strict, true);
    const input = JSON.parse(body.messages[1].content);
    assert.equal(input.history.length, 8); assert.equal(input.history[0].text, 'Prior conversation 4.'); assert.equal(input.latest, latest.text);
    assert.deepEqual(Object.keys(input.history[0]).sort(), ['speaker', 'text']);
    for (const hidden of ['private-native-id', 'private-chat', 'private-line', 'local-wearer-id', 'WB-offline', 'This arrived while']) assert.ok(!String(init?.body).includes(hidden));
    assert.equal(body.tools, undefined); assert.match(body.messages[0].content, /No tools or external actions/);
    return model('That sounds difficult. What has been on your mind today?');
  }) as typeof fetch });
  const reply = await generator.generate(latest, context);
  assert.deepEqual(reply, { text: 'That sounds difficult. What has been on your mind today?', generation: 'ai' });
  assert.equal(calls, 1); assert.equal(JSON.stringify({ latest, context }), original);
});

test('unconfigured or hosted model never calls fetch and uses an explicit deterministic fallback', async () => {
  for (const config of [{}, { ...env, LIFELINE_LLM_BASE_URL: 'https://hosted.example/v1' }, { ...env, LIFELINE_LLM_BASE_URL: 'http://person:secret@127.0.0.1/v1' }]) {
    let calls = 0; const generator = createWellbeingReply({ env: config, fetch: (async () => { calls++; throw new Error('Must not call.'); }) as typeof fetch });
    const reply = await generator.generate(latest, [latest]);
    assert.equal(reply.generation, 'degraded'); assert.match(reply.text, /sounds lonely/); assert.equal(calls, 0);
  }
});

test('advice requests do not call the model or invent clinical treatment', async () => {
  for (const text of ['What medication should I take?', 'Can you diagnose this pain?', 'Which dose should I give?', 'Are there drug interactions?']) {
    let calls = 0; const generator = createWellbeingReply({ env, fetch: (async () => { calls++; return model('Unsafe advice.'); }) as typeof fetch });
    const reply = await generator.generate({ ...latest, text }, []);
    assert.equal(reply.generation, 'degraded'); assert.match(reply.text, /can't advise on diagnosis or treatment/); assert.equal(calls, 0);
  }
});

test('multiple follow-ups, fake actions, safety claims, diagnoses and dosing never become validated AI replies', async () => {
  for (const text of ['How was your day? Who did you see?', 'I’ll contact your responder now.', "I've called your family.",
    'Help is coming.', "You're safe now.", 'Your check-in is resolved.', 'Take two tablets now.', 'You have depression.', 'x'.repeat(501), 'bad\u0000reply', '']) {
    const generator = createWellbeingReply({ env, fetch: (async () => model(text)) as typeof fetch });
    const reply = await generator.generate(latest, []);
    assert.equal(reply.generation, 'degraded', text); assert.match(reply.text, /sounds lonely/);
  }
});

test('HTTP errors, oversized payloads, malformed plans and a real abort signal preserve honest fallback provenance', async () => {
  const responses = [new Response('Failure', { status: 503 }), new Response('{}', { headers: { 'content-type': 'text/plain' } }),
    json({ choices: [{ message: { content: '{"text":"Looks fine.","action":"cancel"}' } }] }),
    json({ choices: [{ message: { content: 'Not JSON' } }] }), json({ choices: [] }), json({ choices: [{ message: { content: '{"text":42}' } }] }),
    new Response('x'.repeat(32_001), { headers: { 'content-type': 'application/json' } })];
  for (const response of responses) {
    const reply = await createWellbeingReply({ env, fetch: (async () => response) as typeof fetch }).generate(latest, []);
    assert.equal(reply.generation, 'degraded');
  }
  const generator = createWellbeingReply({ env, timeoutMs: 10, fetch: (async (_url, init) => new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Injected timeout was not enforced.')), 1000);
    init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal!.reason); }, { once: true });
  })) as typeof fetch });
  assert.equal((await generator.generate(latest, [])).generation, 'degraded');
});

test('each answer preserves its own provenance after an earlier successful AI turn', async () => {
  let calls = 0;
  const generator = createWellbeingReply({ env, fetch: (async () => ++calls === 1 ? model('I hear you. What would you like to talk about?') : new Response('Unavailable', { status: 503 })) as typeof fetch });
  assert.equal((await generator.generate(latest, [])).generation, 'ai');
  assert.equal((await generator.generate({ ...latest, text: 'My day was quiet.' }, [])).generation, 'degraded');
});
