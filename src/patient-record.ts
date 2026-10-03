import { createHash } from 'node:crypto';

export const PATIENT_CATEGORIES = ['demographics', 'medications', 'conditions', 'allergies', 'vitals'] as const;
export type PatientCategory = typeof PATIENT_CATEGORIES[number];
export type PatientSection = PatientCategory | 'medicationAdministrations' | 'medicationDispenses';
export type CategoryState = 'available' | 'empty' | 'partial' | 'unavailable' | 'out-of-scope' | 'revoked';
export type ClinicalField = string | number | null | string[];
export type MetadataValue = string | number | boolean | null | MetadataValue[] | { [key: string]: MetadataValue };
export interface PatientClinicalRecord {
  id: string; category: PatientCategory; section: PatientSection; resourceType: string | null; label: string;
  fields: Record<string, ClinicalField>; details: { label: string; value: string }[];
  codes: { system: string | null; code: string | null; display: string | null }[];
  source: string | null; sourceName: string | null; sourceRecordId: string | null;
  sourceUpdatedAt: string | null; syncedAt: string | null;
}
export interface PatientRecordSnapshot {
  revision: string; provider: 'finchnode'; subject: string | null; synthetic: true; environment: 'demo'; fetchedAt: number;
  dataAsOf: string | null; status: 'available' | 'partial' | 'unavailable' | 'revoked';
  requestedCategories: PatientCategory[]; availableCategories: PatientCategory[]; missingCategories: PatientCategory[];
  consent: { status: string; receiptIds: string[]; expiresAt: string | null; revokedAt: string | null; receipts: Record<string, MetadataValue>[] };
  sync: { status: string | null; preparedAt: string | null; lastSuccessfulSyncAt: string | null; sources: Record<string, MetadataValue>[] };
  warnings: { code: string; message: string; retryable: boolean | null; category: string | null }[];
  categories: Record<PatientCategory, { state: CategoryState; recordIds: string[]; detail: string }>;
  records: PatientClinicalRecord[]; simulatedCategoryOutcomes: Record<string, MetadataValue>[];
}

const sectionFields: Record<PatientSection, readonly string[]> = {
  demographics: ['name', 'birthDate', 'gender', 'address', 'phone', 'email'],
  medications: ['name', 'dosage', 'frequency', 'status', 'startDate', 'endDate', 'prescriber', 'reason'],
  medicationAdministrations: ['name', 'status', 'date', 'performer', 'reason', 'dosage', 'route', 'site', 'device', 'note'],
  medicationDispenses: ['name', 'status', 'type', 'quantity', 'quantityUnit', 'daysSupply', 'preparedDate', 'handedOverDate', 'destination', 'receiver', 'dosageInstructions', 'substitution'],
  conditions: ['name', 'status', 'verificationStatus', 'severity', 'category', 'onsetDate', 'recordedDate'],
  allergies: ['substance', 'reaction', 'severity', 'status', 'verificationStatus', 'recordedDate'],
  vitals: ['name', 'value', 'unit', 'status', 'date', 'referenceRange', 'interpretation', 'performer', 'bodySite'],
};
const numericFields = new Set(['quantity', 'daysSupply']);
const dateFields = new Set(['birthDate', 'startDate', 'endDate', 'date', 'preparedDate', 'handedOverDate', 'onsetDate', 'recordedDate']);
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
function string(value: unknown, limit = 2000): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > limit) throw new Error('Invalid Finch text field');
  return value;
}
function date(value: unknown): string | null {
  const result = string(value, 80);
  if (result !== null && (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(result) || !Number.isFinite(Date.parse(result)))) throw new Error('Invalid Finch date');
  return result;
}
function list(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 2000) throw new Error('Invalid Finch list');
  return value;
}
function strings(value: unknown): string[] { return list(value).map(item => string(item) ?? ''); }
function categories(value: unknown): PatientCategory[] {
  return strings(value).filter((item): item is PatientCategory => PATIENT_CATEGORIES.includes(item as PatientCategory));
}
function metadata(value: unknown, depth = 0): MetadataValue {
  if (depth > 6) throw new Error('Invalid Finch metadata depth');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return string(value)!;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return list(value).map(item => metadata(item, depth + 1));
  const raw = object(value);
  if (!raw || Object.keys(raw).length > 200) throw new Error('Invalid Finch metadata');
  return Object.fromEntries(Object.entries(raw).map(([key, field]) => [key, metadata(field, depth + 1)]));
}
function flatMetadata(value: unknown): Record<string, MetadataValue> {
  const raw = object(value);
  if (!raw) throw new Error('Invalid Finch metadata');
  return metadata(raw) as Record<string, MetadataValue>;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Accept only the fictional demo envelope. Consent and freshness remain simulated. */
export function normalizePatientRecord(payload: unknown, fetchedAt: number): PatientRecordSnapshot {
  const raw = object(payload), data = object(raw?.data);
  if (!raw || raw.synthetic !== true || raw.environment !== 'demo' || !data || !Number.isFinite(fetchedAt)) throw new Error('Expected synthetic Finch demo');
  const meta = raw.meta === undefined ? {} : object(raw.meta);
  const access = raw.consent === undefined ? {} : object(raw.consent);
  if (!meta || !access) throw new Error('Invalid Finch envelope metadata');
  const available = categories(meta.availableCategories), missing = categories(meta.missingCategories), scoped = categories(raw.categories);
  const consent = { status: string(access.status) ?? 'unknown', receiptIds: strings(access.receiptIds), expiresAt: date(access.expiresAt), revokedAt: date(access.revokedAt), receipts: list(access.receipts).map(flatMetadata) };
  const revoked = consent.status === 'revoked' || consent.revokedAt !== null;
  const warnings = list(meta.warnings).map(value => {
    const warning = object(value);
    if (!warning || typeof warning.code !== 'string' || typeof warning.message !== 'string'
      || (warning.retryable !== undefined && warning.retryable !== null && typeof warning.retryable !== 'boolean')) throw new Error('Invalid Finch warning');
    return { code: string(warning.code)!, message: string(warning.message)!, retryable: typeof warning.retryable === 'boolean' ? warning.retryable : null, category: string(warning.category) };
  });
  const records: PatientClinicalRecord[] = [], ids = new Map<string, PatientClinicalRecord>();
  const presence = new Set<PatientCategory>();
  const read = (entry: unknown, category: PatientCategory, section: PatientSection) => {
    const row = object(entry), id = string(row?.id, 256);
    if (!row || !id?.trim() || /[\[\]\r\n]/.test(id)) throw new Error('Invalid Finch record ID');
    const fields: Record<string, ClinicalField> = {};
    for (const key of sectionFields[section]) {
      if (!Object.hasOwn(row, key)) continue;
      const value = row[key];
      if (key === 'dosageInstructions') fields[key] = strings(value);
      else if (numericFields.has(key) && typeof value === 'number' && Number.isFinite(value)) fields[key] = value;
      else if (dateFields.has(key)) fields[key] = date(value);
      else fields[key] = string(value);
    }
    const label = fields[section === 'allergies' ? 'substance' : 'name'];
    if (typeof label !== 'string' || !label.trim()) throw new Error('Missing Finch record label');
    const record: PatientClinicalRecord = {
      id, category, section, label, fields, resourceType: string(row.resourceType),
      source: string(row.source), sourceName: string(row.sourceName), sourceRecordId: string(row.sourceRecordId),
      sourceUpdatedAt: date(row.sourceUpdatedAt), syncedAt: date(row.syncedAt),
      codes: list(row.codes).map(value => {
        const code = object(value); if (!code) throw new Error('Invalid Finch code');
        return { system: string(code.system), code: string(code.code), display: string(code.display) };
      }),
      details: list(row.details).map(value => {
        const detail = object(value); if (!detail || typeof detail.label !== 'string' || typeof detail.value !== 'string') throw new Error('Invalid Finch detail');
        return { label: string(detail.label)!, value: string(detail.value)! };
      }),
    };
    const previous = ids.get(id);
    if (previous) {
      if (section !== 'demographics' || previous.section !== section || canonical(previous) !== canonical(record)) throw new Error('Duplicate Finch record ID');
      return;
    }
    ids.set(id, record); records.push(record);
  };
  for (const category of PATIENT_CATEGORIES) {
    if (Object.hasOwn(data, category)) presence.add(category);
    if (category === 'demographics') {
      if (data.demographics === undefined || data.demographics === null) continue;
      const demo = object(data.demographics); if (!demo) throw new Error('Invalid demographics');
      if (demo.id !== undefined) read(demo, category, category);
      for (const entry of list(demo.records)) read(entry, category, category);
    } else {
      if (data[category] !== undefined && !Array.isArray(data[category])) throw new Error('Invalid clinical category');
      for (const entry of list(data[category])) read(entry, category, category);
    }
  }
  for (const section of ['medicationAdministrations', 'medicationDispenses'] as const) {
    if (data[section] !== undefined && !Array.isArray(data[section])) throw new Error('Invalid medication history');
    for (const entry of list(data[section])) read(entry, 'medications', section);
  }
  if (revoked) records.length = 0;
  else if (raw.categories !== undefined) {
    const retained = records.filter(record => scoped.includes(record.category));
    records.splice(0, records.length, ...retained);
  }
  const categoryViews = Object.fromEntries(PATIENT_CATEGORIES.map(category => {
    const recordIds = records.filter(record => record.category === category).map(record => record.id).sort();
    let state: CategoryState;
    if (revoked) state = 'revoked';
    else if (raw.categories !== undefined && !scoped.includes(category)) state = 'out-of-scope';
    else if (missing.includes(category) || (meta.availableCategories !== undefined && !available.includes(category))) state = recordIds.length ? 'partial' : 'unavailable';
    else if (!presence.has(category)) state = recordIds.length ? 'partial' : 'unavailable';
    else if (recordIds.length && warnings.some(warning => warning.category === category)) state = 'partial';
    else state = recordIds.length ? 'available' : 'empty';
    const detail = { available: 'Returned synthetic records; completeness beyond this response is not established.', empty: 'No records returned; absence is not established.', partial: 'Some records returned; category is incomplete.', unavailable: 'Requested category was not available in this response.', 'out-of-scope': 'Category is outside the returned response scope.', revoked: 'Source consent reports revocation; records are unavailable.' }[state];
    return [category, { state, recordIds, detail }];
  })) as PatientRecordSnapshot['categories'];
  const complete = meta.syncStatus !== 'partial' && PATIENT_CATEGORIES.every(category => ['available', 'empty'].includes(categoryViews[category].state));
  const any = PATIENT_CATEGORIES.some(category => ['available', 'empty', 'partial'].includes(categoryViews[category].state));
  const snapshot: PatientRecordSnapshot = {
    revision: '', provider: 'finchnode', subject: string(raw.id, 256), synthetic: true, environment: 'demo', fetchedAt,
    dataAsOf: date(meta.dataAsOf), status: revoked ? 'revoked' : complete ? 'available' : any ? 'partial' : 'unavailable',
    requestedCategories: [...PATIENT_CATEGORIES], availableCategories: PATIENT_CATEGORIES.filter(category => ['available', 'empty', 'partial'].includes(categoryViews[category].state)),
    missingCategories: PATIENT_CATEGORIES.filter(category => !['available', 'empty'].includes(categoryViews[category].state)),
    consent, sync: { status: string(meta.syncStatus), preparedAt: date(meta.preparedAt), lastSuccessfulSyncAt: date(meta.lastSuccessfulSyncAt), sources: list(meta.sources ?? raw.sources).map(flatMetadata) },
    warnings, categories: categoryViews, records: records.sort((a, b) => a.id.localeCompare(b.id)),
    // These are fixture diagnostics only, never evidence of production authorization/freshness.
    simulatedCategoryOutcomes: list(meta.categoryOutcomes).map(flatMetadata),
  };
  const { revision: _revision, fetchedAt: _fetchedAt, ...content } = snapshot;
  snapshot.revision = `finch-${createHash('sha256').update(canonical(content)).digest('hex').slice(0, 32)}`;
  return snapshot;
}
