import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePatientRecord, PATIENT_CATEGORIES } from './patient-record.ts';
import { patientFixture } from './test-helpers/patient-fixture.ts';
const fixture = () => structuredClone(patientFixture);

test('synthetic snapshot preserves five categories, medication sections, identity, sources and historical dates', () => {
  const view = normalizePatientRecord(fixture(), 1000);
  assert.equal(view.status, 'available'); assert.equal(view.subject, 'patient-demo-001');
  assert.deepEqual(view.requestedCategories, [...PATIENT_CATEGORIES]);
  assert.equal(view.records.filter(r => r.section === 'demographics').length, 1, 'primary demographic alias is deduplicated');
  assert.deepEqual(view.records.filter(r => r.category === 'medications').map(r => r.section).sort(), ['medicationAdministrations', 'medicationDispenses', 'medications', 'medications'].sort());
  const vital = view.records.find(r => r.id === 'vital-1')!;
  assert.equal(vital.fields.date, '2026-07-18T15:30:00Z'); assert.equal(vital.syncedAt, '2026-08-25T17:00:00Z');
  assert.equal(vital.fields.value, '74'); assert.equal(vital.fields.unit, 'kg'); assert.equal(vital.sourceRecordId, 'Observation/1');
  assert.equal(view.records.find(r => r.id === 'dispense-1')!.fields.quantity, 30);
  assert.equal(view.records.find(r => r.id === 'med-old')!.fields.status, 'completed');
  assert.equal(view.sync.sources[0].synthetic, true); assert.equal(view.consent.status, 'simulated');
  assert.equal(view.simulatedCategoryOutcomes[0].returnedRecordCount, 999);
  assert.equal(view.categories.vitals.recordIds.length, 1, 'fixture outcome counts never invent rows');
});

test('content revision survives retrieval and row ordering but changes with clinical values or source dates', () => {
  const baseline = normalizePatientRecord(fixture(), 1000);
  const reordered = fixture(); reordered.data.medications.reverse();
  assert.equal(normalizePatientRecord(reordered, 9000).revision, baseline.revision);
  const changed = fixture(); changed.data.vitals[0].value = '73';
  assert.notEqual(normalizePatientRecord(changed, 1000).revision, baseline.revision);
  const dated = fixture(); dated.meta.dataAsOf = '2026-08-26T17:00:00Z';
  assert.notEqual(normalizePatientRecord(dated, 1000).revision, baseline.revision);
});

test('missing, partial and empty categories preserve unknowns independently', () => {
  const partial = fixture(); partial.meta.missingCategories = ['vitals'];
  assert.equal(normalizePatientRecord(partial, 1).categories.vitals.state, 'partial');
  const missing = fixture(); delete (missing.data as Partial<typeof missing.data>).vitals;
  const view = normalizePatientRecord(missing, 1);
  assert.equal(view.status, 'partial'); assert.equal(view.categories.vitals.state, 'unavailable');
  const empty = fixture(); empty.data.allergies = [];
  const emptyView = normalizePatientRecord(empty, 1);
  assert.equal(emptyView.categories.allergies.state, 'empty'); assert.match(emptyView.categories.allergies.detail, /absence is not established/);
  const sync = fixture(); sync.meta.syncStatus = 'partial';
  assert.equal(normalizePatientRecord(sync, 1).status, 'partial');
  const excluded = fixture(); excluded.meta.availableCategories = ['demographics', 'medications', 'conditions', 'allergies'];
  assert.equal(normalizePatientRecord(excluded, 1).categories.vitals.state, 'partial', 'record rows do not erase source availability metadata');
});

test('scope and revoked consent cannot expose conflicting returned rows', () => {
  const scoped = fixture(); scoped.categories = ['demographics', 'medications'];
  const view = normalizePatientRecord(scoped, 1);
  assert.equal(view.categories.vitals.state, 'out-of-scope'); assert.equal(view.records.some(r => r.category === 'vitals'), false);
  const revoked = fixture(); revoked.consent.status = 'revoked';
  const denied = normalizePatientRecord(revoked, 1);
  assert.equal(denied.status, 'revoked'); assert.equal(denied.records.length, 0);
});

test('malformed clinical fields and conflicting IDs are rejected; non-demo records never enter the view', () => {
  for (const payload of [
    { ...fixture(), synthetic: false }, { ...fixture(), environment: 'sandbox' },
    { ...fixture(), data: { ...fixture().data, medications: [{ id: 'bad', name: 'Literal', dosage: {} }] } },
    { ...fixture(), data: { ...fixture().data, vitals: [{ id: 'bad', name: 'Literal', date: 'not-a-date' }] } },
    { ...fixture(), data: { ...fixture().data, conditions: [{ id: 'med-1', name: 'Conflicting identity' }] } },
    { ...fixture(), data: { ...fixture().data, demographics: { ...fixture().data.demographics, records: [{ ...fixture().data.demographics.records[0], name: 'Conflict' }] } } },
  ]) assert.throws(() => normalizePatientRecord(payload, 1));
});
