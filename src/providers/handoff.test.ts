import test from 'node:test';
import assert from 'node:assert/strict';
import type { Incident } from '../contracts.ts';
import { DEFAULT_WILI_THRESHOLDS, type WiliAssessmentFeatures } from '../wili-assessment.ts';
import { patientFixture } from '../test-helpers/patient-fixture.ts';
import { createProviders, FINCH_DEMO_URL } from './index.ts';

const incident: Incident = {
  id: 'LF-PHONE', phase: 'HELP_REQUESTED', version: 1, createdAt: 1000, updatedAt: 1000,
  evidence: { kind: 'synthetic', summary: 'Labelled rehearsal observation' },
  checkinId: 'checkin', checkinDeadline: 2000, progressDeadline: null, ownerId: null,
  handoff: '', outcome: null, resolutionActor: null,
};
const env = { LIFELINE_LLM_API_KEY: 'offline', LIFELINE_LLM_BASE_URL: 'https://model.example/v1', LIFELINE_LLM_MODEL: 'offline' };
type Selection = { facts: { recordId: string; fields: string[] }[]; incidentFields: string[]; unavailable: string[] };
const facts = [
  { recordId: 'allergy-1', fields: ['substance', 'reaction'] },
  { recordId: 'med-1', fields: ['name', 'dosage', 'frequency'] },
  { recordId: 'condition-1', fields: ['name'] },
];
const selection = (): Selection => ({ facts: structuredClone(facts), incidentFields: ['evidence', 'createdAt'], unavailable: ['location', 'currentVitals'] });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function providerFor(payload: unknown, plan: Selection | null = selection(), inspect?: (body: Record<string, any>) => void) {
  return createProviders({ env, now: () => 1234, fetch: (async (url, init) => {
    if (String(url) === FINCH_DEMO_URL) return json(payload);
    assert.equal(String(url), 'https://model.example/v1/chat/completions');
    inspect?.(JSON.parse(String(init?.body)));
    return plan ? json({ choices: [{ message: { content: JSON.stringify({ ...plan, answer: 'Untrusted model prose must not render' }) } }] })
      : new Response('Unavailable', { status: 503 });
  }) as typeof fetch });
}

test('phone handoff includes primary clinical facts once and leaves full metadata in the immutable record', async () => {
  const provider = providerFor(patientFixture, selection(), body => {
    const schema = body.response_format.json_schema.schema;
    assert.deepEqual(schema.properties.incidentFields.items.enum, ['evidence', 'createdAt']);
    assert.deepEqual(new Set(schema.properties.facts.items.properties.recordId.enum), new Set(['med-1', 'med-old', 'allergy-1', 'condition-1']));
    const allowed = schema.properties.facts.items.properties.fields.items.enum;
    assert.ok(allowed.includes('dosage') && allowed.includes('reaction'));
    assert.ok(!allowed.includes('sourceUpdatedAt') && !allowed.includes('birthDate') && !allowed.includes('value'));
    assert.ok(!allowed.includes('startDate') && !allowed.includes('endDate'), 'current regimens do not need date metadata in their selectable fields');
    const input = JSON.parse(body.messages[1].content);
    assert.deepEqual(new Set(input.requiredPrimaryRecordIds), new Set(['med-1', 'allergy-1', 'condition-1']));
    assert.doesNotMatch(body.messages[1].content, /Synthetic hospital|Historical fictional weight|Fictional Patient|syncedAt|sourceUpdatedAt/);
    assert.match(body.messages[0].content, /responder handoff for a phone/);
  });
  const health = await provider.loadHealth(), original = JSON.stringify(health);
  const handoff = await provider.buildHandoffDetailed(incident, health);
  assert.equal(handoff.generation, 'ai');
  assert.equal(handoff.healthRevision, health.patientRecord!.revision);
  assert.equal(JSON.stringify(health), original);
  assert.match(handoff.text, /allergies: Fictional substance; reaction: Historical fictional rash; status: active \[allergy-1\]/);
  assert.match(handoff.text, /medications: Fictional regimen; dosage: Synthetic recorded regimen; frequency: Daily; status: active \[med-1\]/);
  assert.match(handoff.text, /conditions: Fictional condition; status: active \[condition-1\]/);
  assert.equal(handoff.text.split(incident.evidence.summary).length - 1, 1);
  assert.equal(handoff.text.split('Created 1970-01-01T00:00:01.000Z.').length - 1, 1);
  assert.match(handoff.text, /Historical\/non-active records not selected: medications 1/);
  assert.match(handoff.text, /Location not provided\. Current vital signs not provided/);
  assert.match(handoff.text, /Synthetic Finch records as of 2026-08-25/);
  assert.match(handoff.text, /Detection does not establish a diagnosis/);
  assert.doesNotMatch(handoff.text, /sourceUpdatedAt|syncedAt|recordedDate|onsetDate|1988-04-17|Historical fictional weight|Previous synthetic regimen|Fictional dose|Fictional dispensing|Untrusted model prose/);
  assert.ok(handoff.text.length < 1400, `ordinary fixture handoff was ${handoff.text.length} characters`);
  assert.match(health.summary, /sourceUpdatedAt|Historical vitals/);
});

test('every active, missing-status and unfamiliar-status source row is required, including multiple allergies', async () => {
  const fixture = structuredClone(patientFixture);
  fixture.data.medications.push({ ...fixture.data.medications[0], id: 'med-unknown', status: '' });
  fixture.data.allergies.push({ ...fixture.data.allergies[0], id: 'allergy-2', substance: 'Second recorded substance', status: 'active' });
  fixture.data.conditions.push({ ...fixture.data.conditions[0], id: 'condition-unknown', status: 'pending-review' });
  delete (fixture.data.medications.at(-1)! as Record<string, unknown>).status;
  const full = selection();
  full.facts.push({ recordId: 'med-unknown', fields: ['name'] }, { recordId: 'allergy-2', fields: ['substance'] }, { recordId: 'condition-unknown', fields: ['name'] });
  for (const omit of full.facts.map(fact => fact.recordId)) {
    const incomplete = { ...full, facts: full.facts.filter(fact => fact.recordId !== omit) };
    const provider = providerFor(fixture, incomplete), health = await provider.loadHealth();
    const handoff = await provider.buildHandoffDetailed(incident, health);
    assert.equal(handoff.generation, 'degraded', `omitted required row ${omit}`);
    for (const fact of full.facts) assert.ok(handoff.text.includes(`[${fact.recordId}]`), `fallback lost ${fact.recordId}`);
    assert.match(handoff.text, /status: not returned; unknown \[med-unknown\]/);
    assert.match(handoff.text, /status: pending-review \[condition-unknown\]/);
    assert.doesNotMatch(handoff.text, /Historical\/non-active record —.*\[med-unknown\]/);
  }
  const provider = providerFor(fixture, full), handoff = await provider.buildHandoffDetailed(incident, await provider.loadHealth());
  assert.equal(handoff.generation, 'ai');
  assert.match(handoff.text, /Second recorded substance; reaction: Historical fictional rash; status: active \[allergy-2\]/);
});

test('a selected completed regimen is explicitly historical with its source status and dates', async () => {
  const plan = selection(); plan.facts.push({ recordId: 'med-old', fields: ['name', 'dosage'] });
  const provider = providerFor(patientFixture, plan), handoff = await provider.buildHandoffDetailed(incident, await provider.loadHealth());
  assert.equal(handoff.generation, 'ai');
  assert.match(handoff.text, /medications: Historical\/non-active record — Fictional regimen; dosage: Previous synthetic regimen; endDate: 2026-07-17; status: completed \[med-old\]/);
  assert.doesNotMatch(handoff.text, /Historical\/non-active records not selected/);
});

test('metadata or non-clinical source IDs in a handoff plan degrade without polluting the compact fallback', async () => {
  for (const extra of [
    { recordId: 'med-old', fields: ['sourceUpdatedAt'] },
    { recordId: 'demo-1', fields: ['name'] },
    { recordId: 'vital-1', fields: ['value'] },
    { recordId: 'admin-1', fields: ['dosage'] },
    { recordId: 'allergy-1', fields: ['substance'] }, // Duplicate source row.
  ]) {
    const plan = selection(); plan.facts.push(extra);
    const provider = providerFor(patientFixture, plan), handoff = await provider.buildHandoffDetailed(incident, await provider.loadHealth());
    assert.equal(handoff.generation, 'degraded', JSON.stringify(extra));
    assert.match(handoff.text, /source template fallback/);
    for (const fact of facts) assert.ok(handoff.text.includes(`[${fact.recordId}]`));
    assert.doesNotMatch(handoff.text, /sourceUpdatedAt|Fictional Patient|Historical fictional weight|Fictional dose|Previous synthetic regimen/);
  }
});

test('missing reaction, recorded dose and status remain explicit unknowns even when the model selects only names', async () => {
  const fixture = structuredClone(patientFixture);
  for (const field of ['reaction', 'status']) delete (fixture.data.allergies[0] as Record<string, unknown>)[field];
  for (const field of ['dosage', 'status']) delete (fixture.data.medications[0] as Record<string, unknown>)[field];
  const plan = selection(); plan.facts = plan.facts.map(fact => ({ ...fact, fields: fact.recordId === 'allergy-1' ? ['substance'] : ['name'] }));
  const provider = providerFor(fixture, plan), handoff = await provider.buildHandoffDetailed(incident, await provider.loadHealth());
  assert.equal(handoff.generation, 'ai');
  assert.match(handoff.text, /reaction: not returned; unknown; status: not returned; unknown \[allergy-1\]/);
  assert.match(handoff.text, /dosage: not returned; unknown; status: not returned; unknown \[med-1\]/);
});

test('unconfirmed source verification and partial source availability cannot be hidden by a minimal selection', async () => {
  const fixture = structuredClone(patientFixture);
  (fixture.data.conditions[0] as Record<string, unknown>).verificationStatus = 'unconfirmed';
  fixture.meta.warnings.push({ code: 'incomplete-category', message: 'Synthetic fixture condition records are partial.', retryable: false, category: 'conditions' } as typeof fixture.meta.warnings[number]);
  const provider = providerFor(fixture), handoff = await provider.buildHandoffDetailed(incident, await provider.loadHealth());
  assert.equal(handoff.generation, 'ai');
  assert.match(handoff.text, /conditions: Fictional condition; verificationStatus: unconfirmed; status: active \[condition-1\]/);
  assert.match(handoff.text, /Clinical source is partial; additional records may be missing/);
});

test('concise mode never truncates a selected source value or imposes a row limit that drops primary facts', async () => {
  const fixture = structuredClone(patientFixture), plan = selection();
  const fullSourceValue = `Recorded ${'x'.repeat(1900)} END-OF-SOURCE`;
  fixture.data.medications[0].dosage = fullSourceValue;
  for (let index = 0; index < 25; index++) {
    const id = `allergy-extra-${index}`;
    fixture.data.allergies.push({ ...fixture.data.allergies[0], id, substance: `Recorded substance ${index}` });
    plan.facts.push({ recordId: id, fields: ['substance', 'reaction'] });
  }
  const provider = providerFor(fixture, plan, body => assert.equal(body.response_format.json_schema.schema.properties.facts.maxItems, 29));
  const handoff = await provider.buildHandoffDetailed(incident, await provider.loadHealth());
  assert.equal(handoff.generation, 'ai'); assert.ok(handoff.text.includes(fullSourceValue));
  for (const fact of plan.facts) assert.ok(handoff.text.includes(`[${fact.recordId}]`), `missing ${fact.recordId}`);
});

test('historical-only medication rows may remain outside the primary summary without implying no medications', async () => {
  const fixture = structuredClone(patientFixture); fixture.data.medications = [fixture.data.medications[1]];
  const plan = selection(); plan.facts = plan.facts.filter(fact => fact.recordId !== 'med-1');
  const provider = providerFor(fixture, plan), handoff = await provider.buildHandoffDetailed(incident, await provider.loadHealth());
  assert.equal(handoff.generation, 'ai');
  assert.match(handoff.text, /Historical\/non-active records not selected: medications 1/);
  assert.doesNotMatch(handoff.text, /medications: no records returned|Previous synthetic regimen/);
});

test('a restored incident uses its immutable clinical snapshot after a different patient read', async () => {
  const originalProvider = providerFor(patientFixture, null), original = JSON.parse(JSON.stringify(await originalProvider.loadHealth()));
  const changedFixture = structuredClone(patientFixture); changedFixture.data.medications[0].dosage = 'Different current fixture regimen';
  const provider = providerFor(changedFixture), current = await provider.loadHealth();
  const handoff = await provider.buildHandoffDetailed(incident, original);
  assert.equal(handoff.healthRevision, original.patientRecord.revision);
  assert.notEqual(handoff.healthRevision, current.patientRecord!.revision);
  assert.match(handoff.text, /dosage: Synthetic recorded regimen/);
  assert.doesNotMatch(handoff.text, /Different current fixture regimen/);
});

test('Q&A still receives full selectable records and preserves selected provenance and clinical dates', async () => {
  const plan: Selection = { facts: [{ recordId: 'allergy-1', fields: ['substance', 'sourceName', 'recordedDate'] }], incidentFields: [], unavailable: [] };
  const provider = providerFor(patientFixture, plan, body => {
    const schema = body.response_format.json_schema.schema;
    assert.ok(schema.properties.facts.items.properties.recordId.enum.includes('demo-1'));
    assert.ok(schema.properties.facts.items.properties.fields.items.enum.includes('sourceUpdatedAt'));
    assert.equal(JSON.parse(body.messages[1].content).incident, null);
  });
  const answer = await provider.answerPatientQuestionDetailed(await provider.loadHealth(), 'What allergies are recorded, and when were they documented?');
  assert.equal(answer.generation, 'ai');
  assert.match(answer.text, /sourceName: Synthetic hospital; recordedDate: 2021-03-15; status: active \[allergy-1\]/);
});

const assessment: WiliAssessmentFeatures = {
  detector: 'wili-waist-provisional-v1', assessedAtMs: 6000, thresholds: { ...DEFAULT_WILI_THRESHOLDS }, selectedImpactG: 1.65,
  impact: { source: 'body-wili', sessionId: 'body-session', sequence: 1, sensorTime: 1000, captureClock: 'host-receipt', alignedAtMs: 1000, hostReceivedMs: 1001,
    accelerationG: [0, 0, 1.75], totalG: 1.75, fullScaleG: 2, quality: 'measured', saturated: false },
  supportingWaist: { source: 'waist-airpod', sessionId: 'waist-session', sensorLocation: 'Left', sequence: 2, sensorTime: 1050, alignedAtMs: 1050, hostReceivedMs: 1051,
    linearG: 0.7, angularSpeed: 1.5, separationMs: 50 },
  quietWaist: { source: 'waist-airpod', sessionId: 'waist-session', firstSequence: 3, lastSequence: 50, fromAlignedAtMs: 3600, toAlignedAtMs: 6000, durationMs: 2400,
    sampleCount: 48, maxLinearG: .01, maxAngularSpeed: .02, maxCaptureGapMs: 50, maxReceiveGapMs: 50 },
  alignmentAtAssessment: { bodyClock: 'host-receipt', bodyUncertaintyMs: 5, waistUncertaintyMs: 5 },
};

test('structured WILi observation renders frozen measurements once with honest prototype and clock limits', async () => {
  const observed = { ...incident, evidence: { kind: 'cross-body' as const, summary: 'Full detailed detector audit is retained separately', assessment } };
  const original = JSON.stringify(observed), provider = providerFor(patientFixture);
  const handoff = await provider.buildHandoffDetailed(observed, await provider.loadHealth());
  assert.match(handoff.text, /WILi impact 1\.75 g; waist 0\.70 g \/ 1\.50 rad\/s, 50 ms apart; waist low movement 2\.4 s/);
  assert.match(handoff.text, /Prototype assessment; host-receipt timing, not board capture/);
  assert.doesNotMatch(handoff.text, /Full detailed detector audit|body-session|thresholds|accelerationG/);
  assert.equal(handoff.text.split('WILi impact').length - 1, 1);
  assert.equal(JSON.stringify(observed), original);
  const deviceTimed = { ...observed, evidence: { ...observed.evidence, assessment: { ...assessment, impact: { ...assessment.impact, captureClock: 'device-monotonic' as const } } } };
  assert.match((await provider.buildHandoffDetailed(deviceTimed, await provider.loadHealth())).text, /device-monotonic timing/);
});
