import test from 'node:test';
import assert from 'node:assert/strict';
import type { HealthContext } from './contracts.ts';
import { normalizePatientRecord } from './patient-record.ts';
import { createProviders } from './providers/index.ts';
import { createCareReply, isClinicalCareRequest } from './care-reply.ts';
import { patientFixture } from './test-helpers/patient-fixture.ts';
import type { WellbeingMessage, WellbeingPendingMessage } from './wellbeing.ts';

const latest: WellbeingPendingMessage = { id: 'wearer-question', conversationId: 'WB-offline', speaker: 'wearer',
  text: 'What allergies are in my record?', source: 'photon-imessage', at: 1000, delivery: 'recorded' };
function health(name = 'Morgan Rivera'): HealthContext {
  const fixture = structuredClone(patientFixture);
  fixture.data.demographics.name = name; fixture.data.demographics.records[0].name = name;
  const patientRecord = normalizePatientRecord(fixture, 1000);
  return { summary: 'Labelled synthetic care-question fixture.', recordIds: patientRecord.records.map(record => record.id),
    retrievedAt: 1000, available: true, patientRecord };
}
const noCompanion = { generate: async () => { throw new Error('Clinical lane must never call the companion.'); } };

test('questions and requests about recorded clinical facts or advice route before generic conversation', () => {
  for (const text of ['What medications are recorded?', 'What medicine is recorded?', 'Tell me the allergies in the record.',
    'Show my record', 'Can you read my hospital records?', 'Which conditions are recorded?', 'What is my health condition?', 'What conditions do I have?',
    'What are the current vital signs?', 'What is the recorded temperature?', 'List the last dose administered.',
    'Should I take aspirin?', 'Can I give insulin?', 'How should this injury be treated?', 'Please diagnose this pain.',
    'I wonder what medications are listed.', 'I’m wondering what allergies are recorded.', 'I’d like to know the recorded medications.',
    'Am I allergic to penicillin', 'My meds?', 'I had a quiet day. What allergies are recorded?'])
    assert.equal(isClinicalCareRequest(text), true, text);
});

test('social questions, weather, music and ordinary diary observations remain companion conversation', async () => {
  let loads = 0, answers = 0, calls = 0;
  const care = createCareReply({ loadHealth: async () => { loads++; return health(); },
    answerPatientQuestionDetailed: async () => { answers++; throw new Error('No clinical question.'); },
    companion: { generate: async () => { calls++; return { text: 'Thanks for sharing. How was your visit?', generation: 'ai' }; } } });
  const texts = ['I took my medication.', 'I have allergies.', 'My granddaughter visited.', 'I was diagnosed years ago.',
    'What is the meeting history?', 'What record should I play?', 'What are the weather conditions?', 'What temperature is it outside?',
    'Should I call my granddaughter?', 'I’d like to know how your day went.', 'How should I treat myself this weekend?',
    'I took my medication today. How are you?', 'I feel lonely.'];
  for (const text of texts) {
    assert.equal(isClinicalCareRequest(text), false, text);
    const reply = await care.generate({ ...latest, text }, []);
    assert.equal(reply.generation, 'ai'); assert.equal(reply.recordContext, undefined); assert.equal(reply.patientRecord, undefined);
  }
  assert.equal(calls, texts.length); assert.equal(loads, 0); assert.equal(answers, 0);
});

test('clinical answers disclose the actual fictional subject and retain exact known citation metadata', async () => {
  const source = health(); let question = '', received: HealthContext | null = null;
  const care = createCareReply({ companion: noCompanion, loadHealth: async () => source,
    answerPatientQuestionDetailed: async (bound, text) => {
      received = bound; question = text;
      return { text: 'allergies: Fictional substance; reaction: Historical fictional rash [allergy-1]', generation: 'ai' };
    } });
  const before = JSON.stringify(source), reply = await care.generate(latest, []);
  assert.ok(reply.text.startsWith('From your health record:'));
  assert.equal(reply.generation, 'ai'); assert.equal(question, latest.text); assert.notEqual(received, source);
  assert.deepEqual(reply.recordContext, { source: 'finchnode-synthetic', synthetic: true, subjectId: 'patient-demo-001',
    subjectName: 'Morgan Rivera', revision: source.patientRecord!.revision, sourceRecordIds: ['allergy-1'], retrievedAt: 1000,
    truncated: false, requestMessageId: latest.id });
  assert.deepEqual(reply.patientRecord, source.patientRecord); assert.notEqual(reply.patientRecord, source.patientRecord);
  assert.equal(JSON.stringify(source), before);
});

test('subject name is derived from structured records, never the wearer or an assumed demo name', async () => {
  for (const name of ['Alex Chen', 'Fictional Patient']) {
    const care = createCareReply({ companion: noCompanion, loadHealth: async () => health(name),
      answerPatientQuestionDetailed: async () => ({ text: 'Recorded allergy [allergy-1]', generation: 'degraded' }) });
    const reply = await care.generate(latest, []);
    assert.ok(reply.text.startsWith('From your health record:') && Boolean(name));
    assert.equal(reply.recordContext!.subjectName, name); assert.ok(!reply.text.includes('Morgan Rivera'));
  }
  const missing = health(); missing.patientRecord!.records = missing.patientRecord!.records.filter(record => record.section !== 'demographics');
  const reply = await createCareReply({ companion: noCompanion, loadHealth: async () => missing,
    answerPatientQuestionDetailed: async () => ({ text: 'Recorded allergy [allergy-1]', generation: 'degraded' }) }).generate(latest, []);
  assert.match(reply.text, /^From your health record:/); assert.equal(reply.recordContext!.subjectName, null);
});

test('each answer holds one immutable clinical revision across asynchronous cache and inference changes', async () => {
  const source = health(), original = structuredClone(source.patientRecord!); let release!: () => void, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const pending = createCareReply({ companion: noCompanion, loadHealth: async () => source,
    answerPatientQuestionDetailed: async bound => {
      started(); await gate;
      assert.equal(bound.patientRecord!.revision, original.revision);
      bound.patientRecord!.records[0].fields.name = 'An injected inference mutation';
      return { text: 'Recorded allergy [allergy-1]', generation: 'ai' };
    } }).generate(latest, []);
  await ready; source.patientRecord = health('A different later fixture').patientRecord; source.retrievedAt = 9000;
  release(); const reply = await pending;
  assert.deepEqual(reply.patientRecord, original); assert.equal(reply.recordContext!.revision, original.revision);
  assert.equal(reply.recordContext!.retrievedAt, 1000); assert.equal(reply.recordContext!.subjectName, 'Morgan Rivera');
});

test('non-synthetic, malformed, missing or unavailable records never call either answer model', async () => {
  const invalid = [health(), health(), health(), health(), health()];
  (invalid[0].patientRecord as unknown as { synthetic: boolean }).synthetic = false;
  (invalid[1].patientRecord as unknown as { environment: string }).environment = 'production';
  invalid[2].patientRecord!.records[0].id = 'bad[id]';
  invalid[3].patientRecord!.records.push(structuredClone(invalid[3].patientRecord!.records[0]));
  delete invalid[4].patientRecord;
  const unavailable = health(); unavailable.available = false;
  const revoked = health(); revoked.patientRecord!.status = 'revoked';
  for (const source of [...invalid, unavailable, revoked]) {
    let calls = 0;
    const reply = await createCareReply({ companion: noCompanion, loadHealth: async () => source,
      answerPatientQuestionDetailed: async () => { calls++; throw new Error('Must not answer.'); } }).generate(latest, []);
    assert.equal(calls, 0); assert.equal(reply.text, 'Your health record is unavailable right now.');
    assert.equal(reply.generation, 'degraded'); assert.deepEqual(reply.recordContext!.sourceRecordIds, []);
    if (invalid.includes(source)) { assert.equal(reply.patientRecord, undefined); assert.equal(reply.recordContext!.revision, null); }
  }
  const reply = await createCareReply({ companion: noCompanion, loadHealth: async () => { throw new Error('Unavailable'); } }).generate(latest, []);
  assert.equal(reply.generation, 'degraded'); assert.equal(reply.recordContext!.retrievedAt, null);
});

test('record and advice lanes preserve the real provider engine medical boundary and unknown current vitals', async () => {
  let fetches = 0;
  const providers = createProviders({ env: {}, fetch: (async () => { fetches++; throw new Error('Offline only.'); }) as typeof fetch });
  const care = createCareReply({ companion: noCompanion, loadHealth: async () => health(), answerPatientQuestionDetailed: providers.answerPatientQuestionDetailed });
  for (const question of ['Should I take aspirin?', 'Can I give insulin?', 'Can you diagnose this pain?', 'Are there drug interactions?']) {
    const reply = await care.generate({ ...latest, text: question }, []);
    assert.equal(reply.generation, 'policy_refusal'); assert.match(reply.text, /cannot recommend treatment/);
    assert.deepEqual(reply.recordContext!.sourceRecordIds, []);
  }
  const mixed = await care.generate({ ...latest, text: 'What medications and allergies are recorded, and do we have current vital signs?' }, []);
  assert.equal(mixed.generation, 'degraded'); assert.match(mixed.text, /medications:/); assert.match(mixed.text, /allergies:/);
  assert.match(mixed.text, /Current vital signs are not available/); assert.match(mixed.text, /historical measurements/);
  assert.ok(mixed.recordContext!.sourceRecordIds.includes('med-1')); assert.ok(mixed.recordContext!.sourceRecordIds.includes('allergy-1'));
  assert.ok(!mixed.recordContext!.sourceRecordIds.includes('vital-1')); assert.equal(fetches, 0);
});

test('unknown citation IDs or unsafe answer payloads cannot acquire verified AI provenance', async () => {
  for (const text of ['Recorded allergy [fabricated-source]', 'Recorded allergy [conversation:unrelated-person]',
    'Recorded allergy [allergy-1]\u0000', '', 'x'.repeat(100_001)]) {
    const reply = await createCareReply({ companion: noCompanion, loadHealth: async () => health(),
      answerPatientQuestionDetailed: async () => ({ text, generation: 'ai' }) }).generate(latest, []);
    assert.equal(reply.generation, 'degraded'); assert.match(reply.text, /could not prepare a source-verified record answer/);
    assert.deepEqual(reply.recordContext!.sourceRecordIds, []);
    assert.ok(!reply.text.includes('fabricated-source')); assert.ok(!reply.text.includes('unrelated-person'));
  }
});

test('metadata counts only exact retained source citations, not names or plain ID mentions', async () => {
  const reply = await createCareReply({ companion: noCompanion, loadHealth: async () => health(),
    answerPatientQuestionDetailed: async () => ({ text: 'The text [med-1] is a nickname. Recorded allergy [allergy-1]\nSame allergy [allergy-1]', generation: 'ai' }) }).generate(latest, []);
  assert.deepEqual(reply.recordContext!.sourceRecordIds, ['allergy-1']);
});

test('oversized answers truncate whole lines with explicit omissions and cite only preserved records', async () => {
  const answer = `Recorded allergy [allergy-1]\nmedications: ${'long returned field '.repeat(350)} [med-1]\nClinical snapshot revision: ${health().patientRecord!.revision}.`;
  const reply = await createCareReply({ companion: noCompanion, loadHealth: async () => health(),
    answerPatientQuestionDetailed: async () => ({ text: answer, generation: 'ai' }) }).generate(latest, []);
  assert.ok(reply.text.length <= 6000); assert.match(reply.text, /Additional source lines omitted/);
  assert.match(reply.text, /Recorded allergy \[allergy-1\]/); assert.ok(!reply.text.includes('long returned field'));
  assert.ok(!reply.text.includes('Clinical snapshot revision:'), 'truncation stops rather than skipping a source line and retaining later text');
  assert.equal(reply.recordContext!.truncated, true); assert.deepEqual(reply.recordContext!.sourceRecordIds, ['allergy-1']);
  assert.equal(reply.patientRecord!.records.some(record => record.id === 'med-1'), true, 'the persisted source remains complete');
});

test('clinical answers are removed from later companion context without merging records into the journal', async () => {
  const clinical = await createCareReply({ companion: noCompanion, loadHealth: async () => health(),
    answerPatientQuestionDetailed: async () => ({ text: 'Recorded allergy [allergy-1]', generation: 'ai' }) }).generate(latest, []);
  const social: WellbeingMessage = { ...latest, id: 'social', text: 'My granddaughter visited.' };
  const sourceMessage: WellbeingMessage = { id: 'clinical-answer', speaker: 'lifeline', source: 'agent', at: 1200,
    delivery: 'queued', text: clinical.text, generation: clinical.generation, recordContext: clinical.recordContext };
  const history = [social, sourceMessage], before = JSON.stringify(history);
  const reply = await createCareReply({ loadHealth: async () => { throw new Error('No clinical lookup for thanks.'); },
    companion: { generate: async (_message, received) => {
      assert.deepEqual(received, [social]); assert.ok(!JSON.stringify(received).includes('allergy-1'));
      return { text: 'That sounds like a lovely visit.', generation: 'ai' };
    } } }).generate({ ...latest, text: 'Thanks, my day was pleasant.' }, history);
  assert.equal(reply.recordContext, undefined); assert.equal(JSON.stringify(history), before);
});

test('answer failures stay in the record lane with explicit degraded provenance', async () => {
  const reply = await createCareReply({ companion: noCompanion, loadHealth: async () => health(),
    answerPatientQuestionDetailed: async () => { throw new Error('Unavailable model.'); } }).generate(latest, []);
  assert.equal(reply.generation, 'degraded'); assert.match(reply.text, /source-verified record answer/);
  assert.equal(reply.recordContext!.revision, health().patientRecord!.revision); assert.deepEqual(reply.recordContext!.sourceRecordIds, []);
});

test('the companion cannot invent clinical source access on an ordinary social turn', async () => {
  for (const text of ['Your record lists penicillin as an allergy.', 'According to your medical record, you have diabetes.',
    'I reviewed your hospital chart.', 'You are allergic to penicillin.', 'Finch records show a medication.']) {
    const reply = await createCareReply({ companion: { generate: async () => ({ text, generation: 'ai' }) },
      loadHealth: async () => { throw new Error('Social turn must not load records.'); } }).generate({ ...latest, text: 'My granddaughter visited.' }, []);
    assert.equal(reply.generation, 'degraded'); assert.equal(reply.recordContext, undefined);
    assert.equal(reply.text, 'Thanks for sharing. What has your day been like?');
  }
  const ordinary = await createCareReply({ companion: { generate: async () => ({ text: 'You have had a full day. What did you enjoy?', generation: 'ai' }) } })
    .generate({ ...latest, text: 'My granddaughter visited.' }, []);
  assert.equal(ordinary.generation, 'ai'); assert.match(ordinary.text, /full day/);
});

test('literal structured subject spelling is preserved for persisted metadata validation', async () => {
  const reply = await createCareReply({ companion: noCompanion, loadHealth: async () => health(' Morgan Rivera '),
    answerPatientQuestionDetailed: async () => ({ text: 'Recorded allergy [allergy-1]', generation: 'degraded' }) }).generate(latest, []);
  assert.equal(reply.recordContext!.subjectName, ' Morgan Rivera ');
  assert.equal(reply.recordContext!.retrievedAt, reply.patientRecord!.fetchedAt);
});
