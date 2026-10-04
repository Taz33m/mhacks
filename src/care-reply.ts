import { patientFollowup } from './patient-followup.ts';
import type { HealthContext } from './contracts.ts';
import type { PatientRecordSnapshot } from './patient-record.ts';
import { answerPatientQuestionDetailed as defaultPatientAnswer, loadHealth as defaultLoadHealth, type DetailedAnswer } from './providers/index.ts';
import { createWellbeingReply } from './wellbeing-reply.ts';
import type { WellbeingMessage, WellbeingPendingMessage, WellbeingRecordContext } from './wellbeing.ts';

export interface CareReply {
  text: string; generation: 'ai' | 'degraded' | 'policy_refusal';
  recordContext?: WellbeingRecordContext; patientRecord?: PatientRecordSnapshot;
}
export interface CareReplyOptions {
  companion?: ReturnType<typeof createWellbeingReply>;
  loadHealth?: () => Promise<HealthContext>;
  answerPatientQuestionDetailed?: (health: HealthContext, question: string) => Promise<DetailedAnswer>;
}
const MAX_REPLY = 6000;
const OMITTED = 'Additional source lines omitted to fit this message. Ask about one category for more detail.';
const UNAVAILABLE = 'Your health record is unavailable right now.';
const FAILED_ANSWER = 'I could not prepare a source-verified record answer. Please ask again about the recorded fields.';
const forbiddenControls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

/** Intent gates source access; it never interprets diary statements as clinical facts. */
export function isClinicalCareRequest(value: string): boolean {
  return value.trim().replace(/’/g, "'").split(/(?<=[.!?])\s+|[\r\n]+/).some(text => {
    const request = text.includes('?') || /^(?:please\s+)?(?:what|which|how|why|when|where|can|could|may|do|does|did|am|are|is|have|should|would|tell|show|list|read|check|explain|summariz\w*|look up|remind|diagnose|prescribe|treat|recommend\s+(?:a\s+)?(?:dose|treatment|medicine))\b/i.test(text)
      || /^(?:i(?:'m| am) wondering|i(?:'d| would) like to know|i (?:wonder|want to know|need to know))\b/i.test(text);
    if (!request) return false;
    const clinicalText = text.replace(/\btreat(?:ing)?\s+(?:myself|yourself|ourselves|themselves)\b/gi, '');
    const clinical = /\b(?:medicat\w*|meds|medicines?|drugs?|prescri\w*|allerg\w*|diagnos\w*|doses?|dosage|dosing|treat\w*|administer\w*|vitals?|vital signs|heart rate|blood pressure|oxygen saturation|blood sugar|medical|clinical|ehr|finch(?:node)?|aspirin|ibuprofen|insulin|antibiotics?|tablets?|pills?)\b/i.test(clinicalText);
    const sourceCue = /\b(?:record(?:ed|s)?|patient|hospital|health|medical|clinical|ehr|finch(?:node)?)\b/i.test(text);
    const condition = /\bconditions?\b/i.test(text) && (sourceCue || /\b(?:my|your|his|her|their)\s+(?:health\s+)?conditions?\b|\bconditions?\s+(?:do|does)\s+(?:i|he|she|they)\s+have\b|\bconditions?\s+(?:are|were)\s+(?:listed|known|recorded)\b/i.test(text));
    const measurement = /\b(?:temperature|weight|oxygen)\b/i.test(text) && sourceCue;
    const personalRecord = /\b(?:my|patient(?:['’]s)?|hospital|medical|clinical|health|finch(?:node)?|demo)\s+(?:patient\s+)?records?\b/i.test(text);
    return clinical || condition || measurement || personalRecord;
  });
}

function validSnapshot(value: unknown): value is PatientRecordSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as PatientRecordSnapshot;
  if (p.provider !== 'finchnode' || p.synthetic !== true || p.environment !== 'demo'
    || typeof p.revision !== 'string' || !p.revision.trim() || p.revision.length > 256 || /[\x00-\x1f\x7f]/.test(p.revision)
    || (p.subject !== null && (typeof p.subject !== 'string' || p.subject.length > 256 || /[\x00-\x1f\x7f]/.test(p.subject)))
    || !Number.isFinite(p.fetchedAt) || p.fetchedAt < 0
    || !['available', 'partial', 'unavailable', 'revoked'].includes(p.status)
    || !Array.isArray(p.records) || p.records.length > 2000) return false;
  const ids = new Set<string>();
  return p.records.every(record => {
    if (!record || typeof record.id !== 'string' || !record.id.trim() || record.id.length > 256
      || /[\[\]\x00-\x1f\x7f]/.test(record.id) || ids.has(record.id)
      || !record.fields || typeof record.fields !== 'object' || Array.isArray(record.fields)) return false;
    if (record.section === 'demographics' && record.fields.name !== undefined && record.fields.name !== null
      && (typeof record.fields.name !== 'string' || !record.fields.name.trim() || record.fields.name.length > 2000
        || /[\x00-\x1f\x7f]/.test(record.fields.name))) return false;
    ids.add(record.id); return true;
  });
}
function subjectName(snapshot: PatientRecordSnapshot): string | null {
  const name = snapshot.records.find(record => record.section === 'demographics')?.fields.name;
  return typeof name === 'string' ? name : null;
}
function context(snapshot: PatientRecordSnapshot | null, latest: WellbeingPendingMessage, retrievedAt: number | null): WellbeingRecordContext {
  return { source: 'finchnode-synthetic', synthetic: true, subjectId: snapshot?.subject ?? null,
    subjectName: snapshot ? subjectName(snapshot) : null, revision: snapshot?.revision ?? null,
    sourceRecordIds: [], retrievedAt, truncated: false, requestMessageId: latest.id };
}
function boundLines(prefix: string, answer: string): { text: string; truncated: boolean } {
  const complete = `${prefix}\n${answer.trim()}`;
  if (complete.length <= MAX_REPLY) return { text: complete, truncated: false };
  const lines = [prefix]; let length = prefix.length;
  for (const line of answer.trim().split(/\r?\n/)) {
    if (length + 1 + line.length + 1 + OMITTED.length > MAX_REPLY) break;
    lines.push(line); length += 1 + line.length;
  }
  return { text: [...lines, OMITTED].join('\n'), truncated: true };
}
function inventedRecordClaim(text: string): boolean {
  return /\b(?:your|my|their|his|her|the|medical|clinical|hospital|finch(?:node)?)\s+(?:(?:medical|clinical|health)\s+)?(?:records?|chart|ehr)\b.{0,60}\b(?:shows?|says?|lists?|contains?|notes?|indicates?|reports?)\b|\b(?:according to|checked|reviewed|accessed|looked up)\b.{0,60}\b(?:records?|chart|ehr)\b|\b(?:in|from)\s+your\s+(?:(?:medical|health)\s+)?(?:records?|chart|ehr)\b|\byou have\b.{0,40}\b(?:allerg\w*|diabet\w*|hypertension|a prescription|an? (?:infection|fracture|disease|condition))\b|\b(?:you are allergic to|you're allergic to)\b|\b(?:finch(?:node)?|synthetic|fictional)\b.{0,40}\b(?:records?|patient|allerg\w*|medicat\w*)\b/i.test(text);
}

/** Clinical questions use the existing grounded record engine, never the companion model. */
export function createCareReply(options: CareReplyOptions = {}) {
  const companion = options.companion ?? createWellbeingReply();
  const loadHealth = options.loadHealth ?? defaultLoadHealth;
  const patientAnswer = options.answerPatientQuestionDetailed ?? defaultPatientAnswer;
  async function generate(latest: WellbeingPendingMessage, history: WellbeingMessage[]): Promise<CareReply> {
    if (/^(?:on it|on my way|arrived|depart|decline)[.!]*$/i.test(latest.text.trim()))
      return { text: 'No active incident to update.', generation: 'degraded' };
    if (!isClinicalCareRequest(latest.text)) {
      const followup = patientFollowup(latest.text, history);
      if (followup) return { text: followup, generation: 'degraded' };
      const reply = await companion.generate(latest, history.filter(message => !message.recordContext));
      if (inventedRecordClaim(reply.text)) return { text: 'Thanks for sharing. What has your day been like?', generation: 'degraded' };
      return reply;
    }
    let health: HealthContext;
    try { health = structuredClone(await loadHealth()); }
    catch { return { text: UNAVAILABLE, generation: 'degraded', recordContext: context(null, latest, null) }; }
    if (!validSnapshot(health.patientRecord))
      return { text: UNAVAILABLE, generation: 'degraded', recordContext: context(null, latest, null) };
    // Separate copies keep the answer's retained snapshot independent of inference
    // and of the mutable dashboard cache while the asynchronous call is pending.
    const patientRecord = structuredClone(health.patientRecord);
    const recordContext = context(patientRecord, latest, patientRecord.fetchedAt);
    if (!health.available || !['available', 'partial'].includes(patientRecord.status))
      return { text: UNAVAILABLE, generation: 'degraded', recordContext: context(null, latest, null) };
    const prefix = 'From your health record:';
    const failed = (): CareReply => ({ text: `${prefix}\n${FAILED_ANSWER}`, generation: 'degraded', recordContext, patientRecord });
    try {
      const answer = await patientAnswer(health, latest.text);
      if (!answer || !['ai', 'degraded', 'policy_refusal'].includes(answer.generation)
        || typeof answer.text !== 'string' || !answer.text.trim() || answer.text.length > 100_000 || forbiddenControls.test(answer.text)) return failed();
      const knownIds = new Set(patientRecord.records.map(record => record.id));
      // Only exact bracketed IDs from this snapshot may become source evidence.
      // An ID merely mentioned as ordinary text or a name is not a citation.
      const citations = [...answer.text.matchAll(/\[([^\]\r\n]*)\]/g)].map(match => match[1]);
      if (citations.some(id => !knownIds.has(id))) return failed();
      const bounded = boundLines(prefix, answer.text.replace(/^From the health record:\n/, ''));
      recordContext.truncated = bounded.truncated;
      const retainedCitations = new Set(bounded.text.split(/\r?\n/).slice(1).flatMap(line => {
        const match = line.match(/\[([^\]\r\n]*)\]\s*$/); return match ? [match[1]] : [];
      }));
      recordContext.sourceRecordIds = patientRecord.records.filter(record => retainedCitations.has(record.id)).map(record => record.id);
      return { text: bounded.text, generation: answer.generation, recordContext, patientRecord };
    } catch { return failed(); }
  }
  return { generate };
}
