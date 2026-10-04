const historicalStatuses = new Set(['historical', 'completed', 'inactive', 'resolved', 'stopped', 'discontinued', 'cancelled', 'canceled', 'entered-in-error']);
const medicationSections = new Set(['medications', 'medicationAdministrations', 'medicationDispenses']);

/** A source status is not evidence of current use or a dose taken. */
export function medicationStatus(record) {
  const status = typeof record?.fields?.status === 'string' ? record.fields.status.trim().toLowerCase() : '';
  return status === 'active' ? 'current' : historicalStatuses.has(status) ? 'historical' : 'unknown';
}
const normalize = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '';

/** Group only the exact normalized name/strength; never merge brands or doses. */
export function groupMedicationRecords(records = []) {
  const groups = new Map();
  for (const record of records) {
    if (!medicationSections.has(record?.section)) continue;
    const name = typeof record.fields?.name === 'string' && record.fields.name.trim() ? record.fields.name : record.label || 'Medication name unavailable';
    const normalized = normalize(record.fields?.name);
    // An unidentified row must not acquire another row's medication identity.
    const key = JSON.stringify([normalized || `unidentified:${record.id}`, normalize(record.fields?.strength)]);
    if (!groups.has(key)) groups.set(key, { key, name, records: [], currentPrescriptions: [], historicalPrescriptions: [], unknownPrescriptions: [], administrations: [], dispenses: [] });
    const group = groups.get(key); group.records.push(record);
    if (record.section === 'medicationAdministrations') group.administrations.push(record);
    else if (record.section === 'medicationDispenses') group.dispenses.push(record);
    else group[`${medicationStatus(record) === 'current' ? 'current' : medicationStatus(record) === 'historical' ? 'historical' : 'unknown'}Prescriptions`].push(record);
  }
  return [...groups.values()];
}

export function measurementDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return null;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendar = new Date(0); calendar.setUTCFullYear(year, month - 1, day); calendar.setUTCHours(0, 0, 0, 0);
  if (calendar.toISOString().slice(0, 10) !== value.slice(0, 10)) return null;
  const at = Date.parse(value); return Number.isFinite(at) ? at : null;
}
export const vitalKey = record => JSON.stringify([record?.fields?.name || record?.label || 'Unnamed vital',
  typeof record?.fields?.unit === 'string' && record.fields.unit.trim() ? record.fields.unit : null]);

/** Original rows only: no freshness, diagnoses, scalar BP parsing or unit conversion. */
export function careHighlights(snapshot) {
  const records = Array.isArray(snapshot?.records) ? snapshot.records : [];
  const latest = new Map();
  for (const record of records.filter(row => row.section === 'vitals')) {
    const at = measurementDate(record.fields?.date);
    if (at === null || record.fields?.value === null || record.fields?.value === undefined || record.fields?.value === '') continue;
    const key = vitalKey(record), previous = latest.get(key);
    if (!previous || at > previous.at) latest.set(key, { at, record });
  }
  return {
    allergies: records.filter(row => row.section === 'allergies'),
    medications: groupMedicationRecords(records).filter(group => group.currentPrescriptions.length),
    conditions: records.filter(row => row.section === 'conditions'),
    vitals: [...latest.values()].map(item => item.record),
    missingCategories: ['allergies', 'medications', 'conditions', 'vitals'].filter(category =>
      !records.some(row => row.category === category || row.section === category)
      || ['unavailable', 'out-of-scope', 'revoked'].includes(snapshot?.categories?.[category]?.state)),
  };
}
