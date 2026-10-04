import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { ConversationMessage, Incident } from '../contracts.ts';
import { patientFixture } from '../test-helpers/patient-fixture.ts';
import { createProviders, FINCH_DEMO_URL } from './index.ts';

const mixedQuestion = 'What medications and allergies are recorded, and do we have current vital signs?';
const incident: Incident = { id: 'LF-MIXED', phase: 'HELP_REQUESTED', version: 1, createdAt: 1000, updatedAt: 1000,
  evidence: { kind: 'synthetic', summary: 'Labelled compound-question fixture' }, checkinId: 'test', checkinDeadline: 2000,
  progressDeadline: null, ownerId: null, handoff: '', outcome: null, resolutionActor: null };
const wearer: ConversationMessage = { id: 'wearer-report', incidentId: incident.id, speaker: 'wearer', speakerName: 'Fixture wearer',
  text: 'My ankle hurts and I can’t stand up.', source: 'freewili-local-speech', at: 1000, delivery: 'recorded' };
type Plan = { facts: { recordId: string; fields: string[] }[]; incidentFields: string[]; unavailable: string[] };
const mixedPlan = (): Plan => ({ facts: [
  { recordId: 'med-1', fields: ['name', 'dosage', 'frequency'] },
  { recordId: 'allergy-1', fields: ['substance', 'reaction'] },
], incidentFields: [], unavailable: ['currentVitals'] });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function setup(options: { plan?: Plan | string | null; timeout?: boolean; inspect?: (body: any) => void; payload?: unknown } = {}) {
  let calls = 0;
  const provider = createProviders({ timeoutMs: options.timeout ? 2 : 12000,
    env: { LIFELINE_LLM_API_KEY: 'offline', LIFELINE_LLM_BASE_URL: 'https://model.example/v1', LIFELINE_LLM_MODEL: 'offline' },
    fetch: (async (url, init) => {
      if (String(url) === FINCH_DEMO_URL) return json(options.payload ?? patientFixture);
      assert.equal(String(url), 'https://model.example/v1/chat/completions'); calls++;
      const body = JSON.parse(String(init?.body)); options.inspect?.(body);
      if (options.timeout) {
        await delay(8);
        assert.equal(init?.signal?.aborted, true, 'Injected fetch must exercise the actual bounded abort signal.');
        throw init!.signal!.reason;
      }
      if (options.plan === null) return new Response('Unavailable', { status: 503 });
      const plan = options.plan ?? mixedPlan();
      return json({ choices: [{ message: { content: typeof plan === 'string' ? plan : JSON.stringify(plan) } }] });
    }) as typeof fetch });
  return { provider, calls: () => calls };
}
function assertMixedFacts(answer: string) {
  assert.match(answer, /Fictional regimen.*\[med-1\]/);
  assert.match(answer, /Fictional substance.*\[allergy-1\]/);
  assert.match(answer, /Current vital signs (?:not provided|are not available)/);
  assert.doesNotMatch(answer, /\[vital-1\]|\[condition-1\]|\[admin-1\]|\[dispense-1\]/);
}

test('incident and before-incident compound questions select all named categories and explicit current-vitals unknowns', async () => {
  const fixture = setup({ inspect: body => {
    const input = JSON.parse(body.messages[1].content), schema = body.response_format.json_schema.schema;
    assert.equal(body.max_tokens, 512);
    assert.equal(schema.properties.facts.items.properties.fields.maxItems, 4);
    assert.equal(schema.properties.facts.maxItems, 3);
    assert.deepEqual(new Set(schema.properties.facts.items.properties.recordId.enum), new Set(['med-1', 'med-old', 'allergy-1']));
    assert.deepEqual(new Set(input.records.map((record: { category: string }) => record.category)), new Set(['medications', 'allergies']));
    assert.deepEqual(new Set(input.requestedCategories), new Set(['medications', 'allergies']));
    assert.equal(input.currentVitalsRequested, true);
    assert.equal(input.localReports, undefined);
    assert.ok(!(schema.properties.incidentFields.items.enum ?? []).includes('wearerReports'));
    assert.doesNotMatch(body.messages[1].content, /Historical fictional weight|Fictional dose|Fictional dispensing|Fictional Patient/);
    assert.match(body.messages[0].content, /every requested category|Each requested category/);
    assert.match(body.messages[0].content, /at most four fields/);
  } });
  const health = await fixture.provider.loadHealth(), original = JSON.stringify(health);
  const answer = await fixture.provider.answerQuestionDetailed(incident, health, mixedQuestion, [wearer]);
  const recordAnswer = await fixture.provider.answerPatientQuestionDetailed(health, mixedQuestion);
  assert.equal(answer.generation, 'ai'); assert.equal(recordAnswer.generation, 'ai');
  assertMixedFacts(answer.text); assertMixedFacts(recordAnswer.text);
  assert.equal(fixture.calls(), 2, 'Patient-record mixed questions must reach generation rather than return early at vitals.');
  assert.equal(JSON.stringify(health), original);
});

test('real abort-signal timeout fallback preserves medications, allergies and unavailable current vitals for both workflows', async () => {
  const fixture = setup({ timeout: true }), health = await fixture.provider.loadHealth(), original = JSON.stringify(health);
  for (const answer of [await fixture.provider.answerQuestionDetailed(incident, health, mixedQuestion),
    await fixture.provider.answerPatientQuestionDetailed(health, mixedQuestion)]) {
    assert.equal(answer.generation, 'degraded'); assertMixedFacts(answer.text);
    assert.match(answer.text, /historical measurements with their own dates/);
    assert.doesNotMatch(answer.text, /AI-composed/);
  }
  assert.equal(fixture.calls(), 2); assert.equal(JSON.stringify(health), original);
});

test('missing category/unknown selectors, repeated facts and noisy or truncated plans degrade to complete requested source facts', async () => {
  const complete = mixedPlan();
  const plans: (Plan | string)[] = [
    { ...complete, facts: complete.facts.filter(fact => fact.recordId === 'med-1') },
    { ...complete, facts: complete.facts.filter(fact => fact.recordId === 'allergy-1') },
    { ...complete, unavailable: [] },
    { ...complete, facts: [{ recordId: 'med-1', fields: Array(20).fill('name') }, complete.facts[1]] },
    { ...complete, facts: [complete.facts[0], complete.facts[0], complete.facts[1]] },
    { ...complete, facts: [...complete.facts, { recordId: 'vital-1', fields: ['name', 'value'] }] },
    '{"facts":[{"recordId":"med-1","fields":["name"',
  ];
  for (const plan of plans) {
    const fixture = setup({ plan }), health = await fixture.provider.loadHealth();
    const answer = await fixture.provider.answerQuestionDetailed(incident, health, mixedQuestion);
    assert.equal(answer.generation, 'degraded'); assertMixedFacts(answer.text);
    assert.doesNotMatch(answer.text, /AI-composed/);
  }
});

test('mixed wearer report, medications, allergies and current-vitals fallback keeps local quotes separate from all clinical categories', async () => {
  const fixture = setup({ plan: null }), health = await fixture.provider.loadHealth();
  const answer = await fixture.provider.answerQuestionDetailed(incident, health,
    'What did the wearer say, what medications and allergies are recorded, and do we have current vital signs?', [wearer]);
  assert.equal(answer.generation, 'degraded'); assertMixedFacts(answer.text);
  assert.ok(answer.text.includes(`“${wearer.text}”`));
  assert.match(answer.text, /\[conversation:wearer-report\]/);
  assert.match(answer.text, /local observations, not hospital records/);
  assert.match(answer.text, /From the health record/);
});

test('historical and current vital requests remain distinct, including explicit mixed requests', async () => {
  const historicalPlan: Plan = { facts: [{ recordId: 'vital-1', fields: ['name', 'value'] }], incidentFields: [], unavailable: ['currentVitals'] };
  const fixture = setup({ plan: historicalPlan }), health = await fixture.provider.loadHealth();
  const currentOnly = await fixture.provider.answerPatientQuestionDetailed(health, 'What are the current vital signs?');
  assert.equal(currentOnly.generation, 'degraded'); assert.equal(fixture.calls(), 0);
  assert.doesNotMatch(currentOnly.text, /\[vital-1\]|74/);
  const mixed = await fixture.provider.answerPatientQuestionDetailed(health, 'What historical vital signs were recorded, and do we have current vital signs?');
  assert.equal(mixed.generation, 'ai');
  assert.match(mixed.text, /Historical vitals.*value: 74.*date: 2026-07-18.*\[vital-1\]/);
  assert.match(mixed.text, /Current vital signs not provided/);
  const fallback = setup({ plan: null }), other = await fallback.provider.loadHealth();
  const currentMedsAndOldVitals = await fallback.provider.answerPatientQuestionDetailed(other, 'What current medications and historical vitals are recorded?');
  assert.match(currentMedsAndOldVitals.text, /\[med-1\]/); assert.match(currentMedsAndOldVitals.text, /\[vital-1\]/);
  assert.doesNotMatch(currentMedsAndOldVitals.text, /Current vital signs are not available/);
});

test('missing requested category remains unknown alongside present categories and current-vitals notice', async () => {
  const payload = structuredClone(patientFixture); payload.data.allergies = [];
  const fixture = setup({ plan: null, payload }), health = await fixture.provider.loadHealth();
  const answer = await fixture.provider.answerPatientQuestionDetailed(health, mixedQuestion);
  assert.equal(answer.generation, 'degraded');
  assert.match(answer.text, /\[med-1\]/); assert.match(answer.text, /No supporting raw records returned for allergies; missing data is unknown/);
  assert.match(answer.text, /Current vital signs are not available/);
  assert.doesNotMatch(answer.text, /no allergies|allergy-free/i);
});

test('focused record answers discard unrequested missing-data padding and preserve explicitly requested unknowns', async () => {
  const unknowns = ['location', 'currentVitals', 'responderEta', 'liveRecordFreshness'];
  const cases = [
    { question: 'Which allergies are recorded?', facts: [mixedPlan().facts[1]], expected: [] },
    { question: mixedQuestion, facts: mixedPlan().facts, expected: ['Current vital signs not provided.'] },
    { question: 'What allergies are recorded, where is the wearer, when will the responder arrive, and how recent are the records?',
      facts: [mixedPlan().facts[1]], expected: ['Location not provided.', 'Responder ETA not provided.', 'Record freshness is not established'] },
  ];
  for (const entry of cases) {
    const fixture = setup({ plan: { facts: entry.facts, incidentFields: [], unavailable: unknowns } });
    const health = await fixture.provider.loadHealth();
    for (const answer of [await fixture.provider.answerQuestionDetailed(incident, health, entry.question),
      await fixture.provider.answerPatientQuestionDetailed(health, entry.question)]) {
      assert.equal(answer.generation, 'ai');
      assert.match(answer.text, /\[allergy-1\]/);
      for (const notice of ['Location not provided.', 'Current vital signs not provided.', 'Responder ETA not provided.', 'Record freshness is not established']) {
        assert.equal(answer.text.includes(notice), entry.expected.includes(notice), entry.question);
      }
      assert.equal(answer.text.includes('Unavailable information:'), entry.expected.length > 0);
    }
  }
});
