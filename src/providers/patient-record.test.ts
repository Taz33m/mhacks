import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviders, FINCH_DEMO_URL } from './index.ts';
import { patientFixture } from '../test-helpers/patient-fixture.ts';
import type { Incident } from '../contracts.ts';
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const incident: Incident = { id: 'LF-PATIENT', phase: 'HELP_REQUESTED', version: 1, createdAt: 1000, updatedAt: 1000, evidence: { kind: 'synthetic', summary: 'Labelled test observation' }, checkinId: 'test', checkinDeadline: 2000, progressDeadline: null, ownerId: null, handoff: '', outcome: null, resolutionActor: null };

test('provider requests five categories and exposes structured synthetic records, never manufactured current vitals', async () => {
  const provider = createProviders({ env: {}, now: () => 1234, fetch: (async url => { assert.equal(String(url), FINCH_DEMO_URL); return response(patientFixture); }) as typeof fetch });
  const health = await provider.loadHealth();
  assert.equal(health.available, true); assert.equal(health.patientRecord!.fetchedAt, 1234);
  assert.equal(health.patientRecord!.records.length, 8);
  assert.equal(health.patientRecord!.records.filter(record => record.category === 'medications').length, 4);
  assert.match(health.summary, /Historical vitals.*date: 2026-07-18/);
  assert.match(health.summary, /medicationAdministrations/); assert.match(health.summary, /medicationDispenses/);
  assert.match((await provider.answerPatientQuestionDetailed(health, 'What are her current vital signs?')).text, /not available/);
  const handoff = await provider.buildHandoffDetailed(incident, health);
  assert.equal(handoff.generation, 'degraded'); assert.equal(handoff.healthRevision, health.patientRecord!.revision);
  assert.equal(await provider.buildHandoff(incident, health), handoff.text);
});

test('restored clinical snapshot answers through templates and AI without process cache or a new patient read', async () => {
  const initial = createProviders({ env: {}, fetch: (async () => response(patientFixture)) as typeof fetch });
  const restored = JSON.parse(JSON.stringify(await initial.loadHealth()));
  let calls = 0;
  const restarted = createProviders({ env: { LIFELINE_LLM_API_KEY: 'offline', LIFELINE_LLM_BASE_URL: 'https://model.example/v1', LIFELINE_LLM_MODEL: 'offline' }, fetch: (async (url, init) => {
    assert.equal(String(url), 'https://model.example/v1/chat/completions'); calls++;
    const input = JSON.parse(String(init?.body));
    const subject = JSON.parse(input.messages[1].content);
    assert.ok(subject.records.some((row: { id: string }) => row.id === 'allergy-1'));
    return response({ choices: [{ message: { content: JSON.stringify({ facts: [{ recordId: 'allergy-1', fields: ['substance', 'reaction'] }], incidentFields: [], unavailable: [] }) } }] });
  }) as typeof fetch });
  const answer = await restarted.answerQuestionDetailed(incident, restored, 'What allergies were recorded?');
  assert.equal(answer.generation, 'ai'); assert.match(answer.text, /Historical fictional rash; status: active; recordedDate: 2021-03-15 \[allergy-1\]/);
  assert.equal(calls, 1);
  const fallback = createProviders({ env: {}, fetch: (async () => { throw new Error('No new reads allowed'); }) as typeof fetch });
  const historical = await fallback.answerPatientQuestionDetailed(restored, 'What historical vitals were recorded?');
  assert.equal(historical.generation, 'degraded'); assert.match(historical.text, /Historical vitals.*date: 2026-07-18.*\[vital-1\]/);
});

test('record-only AI receives no incident and historical vitals always retain measurement date/unit/status', async () => {
  let calls = 0;
  const provider = createProviders({ env: { LIFELINE_LLM_API_KEY: 'offline', LIFELINE_LLM_BASE_URL: 'https://model.example/v1', LIFELINE_LLM_MODEL: 'offline' }, fetch: (async (url, init) => {
    if (String(url) === FINCH_DEMO_URL) return response(patientFixture);
    calls++; const input = JSON.parse(String(init?.body));
    assert.equal(input.response_format.json_schema.schema.properties.incidentFields.maxItems, 0);
    assert.equal(Object.hasOwn(input.response_format.json_schema.schema.properties.incidentFields.items, 'enum'), false, 'empty enum is invalid JSON Schema');
    assert.equal(JSON.parse(input.messages[1].content).incident, null);
    return response({ choices: [{ message: { content: JSON.stringify({ facts: [{ recordId: 'vital-1', fields: ['name', 'value'] }], incidentFields: [], unavailable: [] }) } }] });
  }) as typeof fetch });
  const health = await provider.loadHealth();
  const answer = await provider.answerPatientQuestionDetailed(health, 'What historical vitals were recorded?');
  assert.equal(answer.generation, 'ai'); assert.match(answer.text, /Historical vitals.*value: 74; status: final; date: 2026-07-18T15:30:00Z; unit: kg \[vital-1\]/);
  const count = calls;
  assert.equal((await provider.answerPatientQuestionDetailed(health, 'Should I give a medicine?')).generation, 'policy_refusal');
  assert.equal(calls, count, 'clinical advice never reaches the model');
});

test('record-only questions reject invented incident fields even without an empty schema enum', async () => {
  const provider = createProviders({ env: { LIFELINE_LLM_API_KEY: 'offline', LIFELINE_LLM_BASE_URL: 'https://model.example/v1', LIFELINE_LLM_MODEL: 'offline' }, fetch: (async url => {
    if (String(url) === FINCH_DEMO_URL) return response(patientFixture);
    return response({ choices: [{ message: { content: JSON.stringify({ facts: [{ recordId: 'allergy-1', fields: ['substance', 'recordedDate'] }], incidentFields: ['evidence'], unavailable: [] }) } }] });
  }) as typeof fetch });
  const health = await provider.loadHealth();
  const answer = await provider.answerPatientQuestionDetailed(health, 'What allergies are recorded, and when were they documented?');
  assert.equal(answer.generation, 'degraded');
  assert.match(answer.text, /From the health record:/);
  assert.doesNotMatch(answer.text, /Observed evidence|Incident created/);
});

test('each detailed handoff reports its actual AI or degraded provenance and retained clinical revision', async () => {
  let modelCalls = 0;
  const provider = createProviders({ env: { LIFELINE_LLM_API_KEY: 'offline', LIFELINE_LLM_BASE_URL: 'https://model.example/v1', LIFELINE_LLM_MODEL: 'offline' }, fetch: (async url => {
    if (String(url) === FINCH_DEMO_URL) return response(patientFixture);
    modelCalls++;
    if (modelCalls > 1) return new Response('Unavailable', { status: 503 });
    return response({ choices: [{ message: { content: JSON.stringify({ facts: [{ recordId: 'allergy-1', fields: ['substance'] }, { recordId: 'med-1', fields: ['name'] }, { recordId: 'condition-1', fields: ['name'] }], incidentFields: ['evidence'], unavailable: ['currentVitals'] }) } }] });
  }) as typeof fetch });
  const health = await provider.loadHealth();
  const first = await provider.buildHandoffDetailed(incident, health), second = await provider.buildHandoffDetailed(incident, health);
  assert.equal(first.generation, 'ai'); assert.equal(second.generation, 'degraded');
  assert.equal(first.healthRevision, health.patientRecord!.revision); assert.equal(second.healthRevision, first.healthRevision);
  assert.match(first.text, /\[allergy-1\]/); assert.match(second.text, /Health context:/);
});
