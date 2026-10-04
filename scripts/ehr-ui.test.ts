import test from 'node:test';
import assert from 'node:assert/strict';

// The browser module skips DOM initialization in Node; these tests exercise its
// source interpretation without a browser, backend, credentials or cloud calls.
const moduleUrl = new URL('../public/ehr.js', import.meta.url).href;
const { medicationStatus, vitalMetrics, vitalSeries, groupMedicationRecords, careHighlights, answerPresentation, historicalVitalDate, careEventPresentation } = await import(moduleUrl);
const row = (id: string, name: string, unit: string | null, value: string | number | null, date: string | null) => ({
  id, section: 'vitals', label: name, fields: { name, unit, value, date }, syncedAt: '2026-10-04T12:00:00Z',
});

test('recorded medication status separates explicit active, historical and unknown without inferring use', () => {
  assert.equal(medicationStatus({ fields: { status: 'active' } }), 'current');
  for (const status of ['completed', 'inactive', 'stopped', 'discontinued', 'cancelled', 'resolved', 'historical'])
    assert.equal(medicationStatus({ fields: { status } }), 'historical', status);
  for (const status of [undefined, null, '', 'on-hold', 'intended', 'unrecognized-source-status'])
    assert.equal(medicationStatus({ fields: { status } }), 'unknown', String(status));
  assert.equal(medicationStatus({ section: 'medicationAdministrations', fields: { status: 'completed' } }), 'historical');
});

test('vital metric identity retains exact returned units and keeps missing units distinct', () => {
  const records = [row('kg-1', 'Weight', 'kg', '74', '2026-07-18'), row('kg-2', 'Weight', 'kg', '73', '2026-06-18'),
    row('lb-1', 'Weight', 'lb', '160', '2026-06-18'), row('unknown-unit', 'Weight', null, '74', '2026-07-18')];
  const metrics = vitalMetrics(records);
  assert.equal(metrics.length, 3); assert.equal(metrics.find((metric: { unit: string }) => metric.unit === 'kg').count, 2);
  assert.notEqual(metrics[0].key, metrics[1].key);
  const kg = metrics.find((metric: { unit: string }) => metric.unit === 'kg');
  const points = vitalSeries(records, kg.key);
  assert.deepEqual(points.map((point: { id: string }) => point.id), ['kg-2', 'kg-1']);
  assert.deepEqual(points.map((point: { value: number }) => point.value), [73, 74]);
  assert.deepEqual(vitalSeries(records, metrics.find((metric: { unit: string | null }) => metric.unit === null).key), []);
});

test('chart points require actual numeric values and measurement dates, never sync or retrieval timestamps', () => {
  const records = [row('valid-zero', 'Heart rate', 'bpm', '0', '2026-07-18T12:00:00Z'),
    row('valid-number', 'Heart rate', 'bpm', 72, '2026-07-19T12:00:00Z'),
    row('missing-date', 'Heart rate', 'bpm', '74', null), row('invalid-date', 'Heart rate', 'bpm', '74', 'not-a-date'),
    row('impossible-date', 'Heart rate', 'bpm', '74', '2026-02-30'), row('blank-value', 'Heart rate', 'bpm', ' ', '2026-07-18'),
    row('non-numeric', 'Heart rate', 'bpm', '72 / 90', '2026-07-18'), row('infinite', 'Heart rate', 'bpm', Infinity, '2026-07-18')];
  const key = vitalMetrics(records)[0].key, original = JSON.stringify(records);
  const points = vitalSeries(records, key);
  assert.deepEqual(points.map((point: { id: string }) => point.id), ['valid-zero', 'valid-number']);
  assert.equal(points[0].value, 0); assert.equal(points[0].date, '2026-07-18T12:00:00Z');
  assert.equal(points[0].at, Date.parse('2026-07-18T12:00:00Z'));
  assert.equal(JSON.stringify(records), original, 'source rows remain unchanged');
});

test('single historical point stays a single point and unrelated metrics never enter its series', () => {
  const records = [row('weight', 'Weight', 'kg', '74', '2026-07-18'), row('pressure', 'Blood pressure', 'mmHg', '120/80', '2026-07-18'),
    { id: 'prescription', section: 'medications', label: 'Medication', fields: { name: 'Weight', unit: 'kg', value: '99', date: '2026-07-18' } }];
  const metrics = vitalMetrics(records); assert.equal(metrics.length, 2);
  const points = vitalSeries(records, metrics[0].key);
  assert.equal(points.length, 1); assert.equal(points[0].id, 'weight');
  assert.equal(points[0].date, '2026-07-18'); assert.equal(points[0].current, undefined);
  assert.deepEqual(vitalSeries(records, metrics[1].key), []);
});

test('human vital dates preserve the exact source calendar day rather than the local timezone day', () => {
  assert.equal(historicalVitalDate('2026-07-18'), 'Jul 18, 2026');
  assert.equal(historicalVitalDate('2026-07-18T00:00:00Z'), 'Jul 18, 2026');
  assert.equal(historicalVitalDate('2026-07-18T23:30:00-07:00'), 'Jul 18, 2026');
  for (const value of [null, undefined, 'not-a-date', '2026-02-30']) assert.equal(historicalVitalDate(value), 'Date unavailable');
});

test('medications group exact normalized names and strengths while preserving source kinds and regimens', () => {
  const med = (id: string, section: string, name: string, status: string | null, dosage: string, strength?: string) => ({
    id, category: 'medications', section, label: name, fields: { name, status, dosage, strength },
  });
  const active = med('active', 'medications', 'Metformin 500 mg', 'active', '500 mg twice daily');
  const historical = med('old', 'medications', ' metformin  500 mg ', 'completed', '500 mg once daily');
  const admin = med('admin', 'medicationAdministrations', 'METFORMIN 500 MG', 'completed', 'Recorded dose 500 mg');
  const dispense = med('dispense', 'medicationDispenses', 'Metformin 500 mg', 'completed', 'Recorded dispense');
  const higher = med('higher', 'medications', 'Metformin 1000 mg', 'active', '1000 mg twice daily');
  const records = [historical, active, admin, dispense, higher, med('strength-5', 'medications', 'Example', 'active', 'One tablet', '5 mg'),
    med('strength-10', 'medications', 'Example', 'active', 'One tablet', '10 mg')];
  const before = JSON.stringify(records), groups = groupMedicationRecords(records);
  assert.equal(groups.length, 4, 'different literal strengths remain different medications');
  const combined = groups.find((group: { records: { id: string }[] }) => group.records.some(record => record.id === 'active'));
  assert.deepEqual(combined.currentPrescriptions, [active]); assert.deepEqual(combined.historicalPrescriptions, [historical]);
  assert.deepEqual(combined.administrations, [admin]); assert.deepEqual(combined.dispenses, [dispense]);
  assert.equal(combined.currentPrescriptions[0].fields.dosage, '500 mg twice daily', 'never substitute the older regimen');
  assert.equal(JSON.stringify(records), before); assert.strictEqual(combined.records[1], active, 'source rows stay original');
});

test('care highlights require active prescriptions, not active dispense or administration status', () => {
  const records = [
    { id: 'old', category: 'medications', section: 'medications', label: 'Old drug', fields: { name: 'Old drug', status: 'completed' } },
    { id: 'admin', category: 'medications', section: 'medicationAdministrations', label: 'History drug', fields: { name: 'History drug', status: 'active' } },
    { id: 'dispense', category: 'medications', section: 'medicationDispenses', label: 'Dispensed drug', fields: { name: 'Dispensed drug', status: 'active' } },
    { id: 'unknown', category: 'medications', section: 'medications', label: 'Unknown drug', fields: { name: 'Unknown drug', status: 'unfamiliar' } },
    { id: 'active', category: 'medications', section: 'medications', label: 'Active drug', fields: { name: 'Active drug', status: 'active' } },
  ];
  assert.deepEqual(careHighlights({ records }).medications.map((group: { name: string }) => group.name), ['Active drug']);
  const unidentified = groupMedicationRecords([
    { id: 'a', section: 'medications', label: 'Medication', fields: { name: null, status: 'active' } },
    { id: 'b', section: 'medications', label: 'Medication', fields: { name: null, status: 'completed' } },
  ]);
  assert.equal(unidentified.length, 2, 'unknown names cannot acquire a common identity');
});

test('historical vital highlights choose capture dates and exact units, retaining literal pressure values', () => {
  const latest = row('latest', 'Weight', 'kg', '74', '2026-07-18');
  const pressure = row('bp', 'Blood pressure', 'mmHg', '120/80', '2026-07-18');
  const records = [latest, row('older-but-later-sync', 'Weight', 'kg', '73', '2026-06-18'),
    row('lb', 'Weight', 'lb', '160', '2026-07-17'), pressure,
    row('invalid', 'Heart rate', 'bpm', '74', '2026-02-30'), row('no-date', 'Heart rate', 'bpm', '75', null)];
  const before = JSON.stringify(records), summary = careHighlights({ records, categories: { allergies: { state: 'unavailable' } } });
  assert.deepEqual(summary.vitals.map((record: { id: string }) => record.id), ['latest', 'lb', 'bp']);
  assert.strictEqual(summary.vitals[0], latest); assert.equal(summary.vitals[2].fields.value, '120/80');
  assert.equal(summary.vitals[2].systolic, undefined, 'no invented scalar blood pressure');
  assert.ok(summary.missingCategories.includes('allergies')); assert.equal(JSON.stringify(records), before);
});

test('answer disclosure keeps actual facts and missing-data notices, moving verified citations behind detail', () => {
  const allergy = { id: 'allergy-1', section: 'allergies', fields: { substance: 'Penicillin' } };
  const vital = row('vital-1', 'Weight', 'kg', '74', '2026-07-18');
  const answer = 'AI-composed answer from synthetic patient records:\nKnown source facts:\nallergies: Penicillin; reaction: Hives; status: active; recordedDate: 2020-01-01 [allergy-1]\nHistorical vitals: Weight; value: 74; unit: kg; date: 2026-07-18 [vital-1]\nCurrent vital signs are unavailable.\nClinical snapshot revision: revision-1.';
  const result = answerPresentation(answer, { records: [allergy, vital] });
  assert.deepEqual(result.lines, ['Allergy: Penicillin · reaction: Hives · status: active',
    'Historical vitals: Weight; value: 74; unit: kg; date: 2026-07-18', 'Current vital signs are unavailable.']);
  assert.deepEqual(result.records, [allergy, vital]); assert.equal(result.original, answer, 'actual full answer retained');
  const refusal = 'I can relay recorded information, but cannot recommend treatment.';
  assert.deepEqual(answerPresentation(refusal, null).lines, [refusal]);
  assert.deepEqual(answerPresentation('Unrecognized citation [not-a-record]', { records: [allergy] }).records, []);
});

test('care audit headings and known sources are readable while projected facts stay literal', () => {
  const event = Object.freeze({ type: 'ANSWER_QUEUED', actor: 'photon-imessage',
    detail: 'Record question: What allergies are recorded? · ai · clinical revision fixture-1. Queued does not establish receipt.' });
  const before = JSON.stringify(event), view = careEventPresentation(event);
  assert.equal(view.title, 'Record answer queued'); assert.equal(view.actor, 'Photon message');
  assert.equal(view.detail, event.detail); assert.equal(JSON.stringify(event), before);
  assert.equal(careEventPresentation({ type: 'ON_SCENE', actor: 'simulated-dispatch:fixture-maya', detail: 'Generated arrival report.' }).actor, 'Local dispatch');
});

test('a human care report that looks like JSON or HTML is never parsed or rewritten', () => {
  for (const detail of ['{"transcript":"Exact quoted JSON","decision":"help_requested"}', '<img src=x onerror=alert(1)>', 'Legacy plain audit detail']) {
    const view = careEventPresentation({ type: 'WEARER_REPORT', actor: 'freewili-local-speech', detail });
    assert.equal(view.detail, detail); assert.equal(view.title, 'Patient report');
    assert.equal(view.actor, 'WILi microphone / local speech recognition');
  }
});

test('unknown and prototype-key audit metadata remain literal rather than acquiring a mapped meaning', () => {
  for (const type of ['constructor', '__proto__', 'UNKNOWN_EVENT']) {
    const view = careEventPresentation({ type, actor: 'constructor', detail: 'Exact source facts' });
    assert.equal(view.title, type.replaceAll('_', ' ')); assert.equal(view.actor, 'constructor'); assert.equal(view.detail, 'Exact source facts');
  }
  assert.equal(careEventPresentation(null).detail, 'Event detail unavailable.');
});
