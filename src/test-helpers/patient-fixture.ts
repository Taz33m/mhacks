// Reduced fictional fixture using the public demo envelope and section shapes.
const base = { source: 'synthetic-hospital', sourceName: 'Synthetic hospital', sourceUpdatedAt: '2026-08-25T16:58:00Z', syncedAt: '2026-08-25T17:00:00Z', codes: [{ system: 'example:test', code: 'test', display: 'Fictional code' }] };
const demographic = { ...base, id: 'demo-1', resourceType: 'Patient', sourceRecordId: 'Patient/synthetic-001', name: 'Fictional Patient', birthDate: '1988-04-17', gender: 'female' };
export const patientFixture = {
  id: 'patient-demo-001', object: 'health_record', synthetic: true, environment: 'demo', categories: ['demographics', 'medications', 'conditions', 'allergies', 'vitals'],
  consent: { status: 'simulated', receiptIds: [], expiresAt: null, receipts: [] },
  data: {
    demographics: { ...demographic, records: [{ ...demographic }] },
    medications: [
      { ...base, id: 'med-1', resourceType: 'MedicationRequest', sourceRecordId: 'MedicationRequest/1', name: 'Fictional regimen', dosage: 'Synthetic recorded regimen', frequency: 'Daily', status: 'active', startDate: '2026-07-18', endDate: null },
      { ...base, id: 'med-old', resourceType: 'MedicationRequest', sourceRecordId: 'MedicationRequest/old', name: 'Fictional regimen', dosage: 'Previous synthetic regimen', status: 'completed', endDate: '2026-07-17' },
    ],
    medicationAdministrations: [{ ...base, id: 'admin-1', resourceType: 'MedicationAdministration', sourceRecordId: 'MedicationAdministration/1', name: 'Fictional dose', status: 'completed', date: '2026-07-18T16:00:00Z', dosage: 'Recorded synthetic dose', route: 'Oral', performer: 'Fictional clinician' }],
    medicationDispenses: [{ ...base, id: 'dispense-1', resourceType: 'MedicationDispense', sourceRecordId: 'MedicationDispense/1', name: 'Fictional dispensing', status: 'completed', quantity: 30, quantityUnit: 'tablet', daysSupply: 30, handedOverDate: '2026-07-18T18:00:00Z', dosageInstructions: ['Recorded synthetic instructions'] }],
    conditions: [{ ...base, id: 'condition-1', resourceType: 'Condition', name: 'Fictional condition', status: 'active', onsetDate: '2021-03-12', recordedDate: '2021-03-15' }],
    allergies: [{ ...base, id: 'allergy-1', resourceType: 'AllergyIntolerance', substance: 'Fictional substance', reaction: 'Historical fictional rash', severity: 'mild', status: 'active', recordedDate: '2021-03-15' }],
    vitals: [{ ...base, id: 'vital-1', resourceType: 'Observation', sourceRecordId: 'Observation/1', name: 'Historical fictional weight', value: '74', unit: 'kg', status: 'final', date: '2026-07-18T15:30:00Z' }],
  },
  meta: { dataAsOf: '2026-08-25T17:00:00Z', preparedAt: '2026-08-25T17:00:00Z', syncStatus: 'simulated', lastSuccessfulSyncAt: null, availableCategories: ['demographics', 'medications', 'conditions', 'allergies', 'vitals'], missingCategories: [] as string[], warnings: [{ code: 'synthetic_data', message: 'Fictional records; synchronization simulated.', retryable: false }], sources: [{ system: 'synthetic-hospital', status: 'simulated', synthetic: true, lastSuccessfulSyncAt: null }], categoryOutcomes: [{ category: 'vitals', state: 'simulated', returnedRecordCount: 999, isStale: null, lastAttempt: { status: 'simulated' } }] },
};
