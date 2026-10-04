import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationMessage, Evidence, HealthContext, Incident } from '../contracts.ts';
import { patientFixture } from '../test-helpers/patient-fixture.ts';
import { createProviders, FINCH_DEMO_URL } from './index.ts';

const incident: Incident = {
  id: 'LF-FALL', phase: 'HELP_REQUESTED', version: 1, createdAt: 1000, updatedAt: 1000,
  evidence: { kind: 'synthetic', summary: 'Labelled rehearsal observation' },
  checkinId: 'checkin', checkinDeadline: 2000, progressDeadline: null, ownerId: null,
  handoff: '', outcome: null, resolutionActor: null,
};
type Row = { id: string } & Record<string, unknown>;
type Rows = { medications?: Row[]; conditions?: Row[]; allergies?: Row[] };
const med = (id: string, name: string, status?: string): Row => ({ id, resourceType: 'MedicationRequest', name, dosage: 'Recorded fixture dosage', ...(status === undefined ? {} : { status }) });
const condition = (id: string, name: string, extra: Record<string, unknown> = {}): Row => ({ id, resourceType: 'Condition', name, status: 'active', ...extra });
function providerFor(rows: Rows) {
  const payload = { ...patientFixture, data: { ...patientFixture.data,
    medications: rows.medications ?? [], conditions: rows.conditions ?? [], allergies: rows.allergies ?? patientFixture.data.allergies } };
  // No LLM configuration: the deterministic section must not depend on a model.
  return createProviders({ env: {}, now: () => 1234, fetch: (async url => {
    assert.equal(String(url), FINCH_DEMO_URL, 'only the stubbed Finch read is expected');
    return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch });
}
async function brief(rows: Rows, target: Incident = incident, observations: ConversationMessage[] = []): Promise<string> {
  const provider = providerFor(rows);
  return (await provider.buildHandoffDetailed(target, await provider.loadHealth(), observations)).text;
}
function fallLines(text: string): string[] {
  const lines = text.split('\n'), start = lines.indexOf('Fall-relevant:');
  return start < 0 ? [] : lines.slice(start + 1, lines.indexOf('Health context:'));
}

test('an active blood-pressure medication is flagged with its citation between the wearer quote and health context', async () => {
  const wearer: ConversationMessage = { id: 'wearer-quote-1', incidentId: incident.id, speaker: 'wearer', speakerName: 'Tazeem',
    text: 'I slipped and hit my hip.', source: 'freewili-local-speech', at: 1800, delivery: 'recorded' };
  const rows = { medications: [med('rec_lisinopril', 'Lisinopril 10 mg tablet', 'active')] };
  const text = await brief(rows, incident, [wearer]);
  assert.deepEqual(fallLines(text), ['Lisinopril 10 mg tablet (blood pressure) — can cause dizziness or low blood pressure [rec_lisinopril]']);
  const lines = text.split('\n'), start = lines.indexOf('Fall-relevant:');
  assert.ok(text.indexOf('Tazeem: “I slipped and hit my hip.”') < text.indexOf('Fall-relevant:'));
  assert.equal(lines[start - 1], 'Quoted statements are not verified diagnoses or safety determinations.', 'section directly follows the quote block');
  assert.equal(lines[start + 2], 'Health context:');
  assert.match(text, /^medications: Lisinopril 10 mg tablet; dosage: Recorded fixture dosage; status: active \[rec_lisinopril\]$/m, 'health context is unchanged');
  for (const eventType of ['reported-seizure', 'sustained-shaking'] as const) {
    const other: Incident = { ...incident, evidence: { ...incident.evidence, eventType } };
    assert.doesNotMatch(await brief(rows, other), /Fall-relevant:/, `${eventType} incidents are not labelled as falls`);
  }
});

test('completed or stopped blood thinners, allergies and refuted diagnoses are never flagged', async () => {
  const text = await brief({
    medications: [med('rec_warfarin', 'Warfarin 5 mg tablet', 'completed'), med('rec_apixaban', 'Apixaban 5 mg tablet', 'stopped')],
    conditions: [condition('rec_osteo', 'Osteoporosis', { verificationStatus: 'refuted' })],
    allergies: [{ id: 'rec_aspirin_allergy', resourceType: 'AllergyIntolerance', substance: 'Aspirin', reaction: 'Fixture hives', status: 'active' }],
  });
  assert.doesNotMatch(text, /Fall-relevant:|blood thinner|bleeding risk|fracture risk/);
  assert.match(text, /Historical\/non-active records not selected: medications 2/, 'historical rows remain accounted for');
});

test('records without fall-relevant matches, or no available records, omit the section entirely', async () => {
  for (const rows of [{}, { medications: [med('rec_metformin', 'Metformin 500 mg tablet', 'active')],
    conditions: [condition('rec_htn', 'Hypertension'), condition('rec_di', 'Diabetes insipidus')] }]) {
    const text = await brief(rows);
    assert.doesNotMatch(text, /Fall-relevant:/);
    assert.match(text, /\nDetected [^\n]+\nHealth context:\n/);
  }
  const unavailable: HealthContext = { summary: 'Health record unavailable.', recordIds: [], retrievedAt: 1000, available: false };
  assert.doesNotMatch(await providerFor({}).buildHandoff(incident, unavailable), /Fall-relevant:/);
});

test('at most four flags render, most urgent first, while every record stays in health context', async () => {
  const medications = [
    med('rec_a_lisinopril', 'Lisinopril 10 mg tablet', 'active'), med('rec_b_metoprolol', 'Metoprolol succinate 25 mg tablet', 'active'),
    med('rec_c_oxycodone', 'Oxycodone 5 mg tablet', 'active'), med('rec_d_insulin', 'Insulin glargine 100 unit/mL', 'active'),
    med('rec_e_warfarin', 'Warfarin 5 mg tablet', 'active'),
  ];
  const conditions = [condition('rec_f_afib', 'Atrial fibrillation'), condition('rec_g_osteo', 'Osteoporosis'), condition('rec_h_diabetes', 'Type 2 diabetes mellitus')];
  const text = await brief({ medications, conditions });
  assert.deepEqual(fallLines(text), [
    'Warfarin 5 mg tablet (blood thinner) — bleeding risk — urgent evaluation if the head was hit [rec_e_warfarin]',
    'Insulin glargine 100 unit/mL (diabetes) — low blood sugar can cause falls [rec_d_insulin]',
    'Osteoporosis — higher fracture risk [rec_g_osteo]',
    'Oxycodone 5 mg tablet (sedating) — drowsiness raises fall risk [rec_c_oxycodone]',
  ]);
  const context = text.slice(text.indexOf('Health context:'));
  for (const row of [...medications, ...conditions]) assert.ok(context.includes(`[${row.id}]`), `health context keeps ${row.id}`);
});

test('a matched row with a missing or unfamiliar status keeps that status visible instead of reading as active', async () => {
  const text = await brief({ medications: [med('rec_apixaban', 'Apixaban 5 mg tablet'), med('rec_gabapentin', 'Gabapentin 300 mg capsule', 'on-hold')] });
  assert.deepEqual(fallLines(text), [
    'Apixaban 5 mg tablet (blood thinner) — bleeding risk — urgent evaluation if the head was hit; status: unknown [rec_apixaban]',
    'Gabapentin 300 mg capsule (sedating) — drowsiness raises fall risk; status: on-hold [rec_gabapentin]',
  ]);
});

const assessment = {
  detector: 'wili-waist-provisional-v1', assessedAtMs: 6000, selectedImpactG: 1.65,
  impact: { source: 'body-wili', sessionId: 'body-session', sequence: 1, sensorTime: 1000, captureClock: 'host-receipt', alignedAtMs: 1000, hostReceivedMs: 1001,
    accelerationG: [0, 0, 1.99], totalG: 1.99, fullScaleG: 2, quality: 'measured', saturated: false },
  supportingWaist: { source: 'waist-airpod', sessionId: 'waist-session', sensorLocation: 'Left', sequence: 2, sensorTime: 1050, alignedAtMs: 1050, hostReceivedMs: 1051,
    linearG: 0.7, angularSpeed: 1.5, separationMs: 50 },
  quietWaist: { source: 'waist-airpod', sessionId: 'waist-session', firstSequence: 3, lastSequence: 50, fromAlignedAtMs: 3600, toAlignedAtMs: 6000, durationMs: 2400,
    sampleCount: 48, maxLinearG: .01, maxAngularSpeed: .02, maxCaptureGapMs: 50, maxReceiveGapMs: 50 },
  alignmentAtAssessment: { bodyClock: 'host-receipt', bodyUncertaintyMs: 5, waistUncertaintyMs: 5 },
};
// Cast once so detector type changes elsewhere cannot break this file; the handoff validates rendered fields at runtime.
const observed = (impact: Record<string, unknown>): Incident => ({ ...incident, evidence: { kind: 'cross-body', summary: 'Full detector audit retained separately',
  assessment: { ...assessment, impact: { ...assessment.impact, ...impact } } as unknown as Evidence['assessment'] } });

test('a saturated impact renders as a sensor-limit lower bound instead of the clipped value', async () => {
  const provider = providerFor({}), health = await provider.loadHealth();
  const render = async (impact: Record<string, unknown>) => (await provider.buildHandoffDetailed(observed(impact), health)).text;
  const clipped = await render({ saturated: true });
  assert.match(clipped, /^Possible fall: ≥2\.00 g impact \(sensor limit\) with waist movement 50 ms apart, then 2\.4 s of stillness\.$/m);
  assert.doesNotMatch(clipped, /1\.99 g|Full detector audit/);
  assert.match(await render({ saturated: true, fullScaleG: 8 }), /^Possible fall: ≥8\.00 g impact \(sensor limit\) with/m);
  assert.match(await render({ saturated: true, fullScaleG: undefined }), /^Possible fall: ≥2\.00 g impact \(sensor limit\) with/m, 'missing full scale falls back to 2 g');
  assert.match(await render({ saturated: false }), /^Possible fall: 1\.99 g impact with waist movement 50 ms apart/m);
});
