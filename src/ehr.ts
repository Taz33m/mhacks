import type { ConversationMessage, Evidence, Incident, Responder, TimelineEvent } from './contracts.ts';
import type { PatientRecordSnapshot } from './patient-record.ts';
import type { WellbeingView } from './wellbeing.ts';

export interface EhrMeasurements {
  detector: string; assessedAt: number; peakAccelerationG: number; waistLinearG: number;
  waistAngularSpeedRadS: number; quietDurationMs: number; quietSampleCount: number; separationMs: number;
  captureClock: 'device-monotonic' | 'host-receipt'; bodyTimingUncertaintyMs: number; waistTimingUncertaintyMs: number;
}
export type EhrIncident = Pick<Incident, 'id' | 'phase' | 'version' | 'createdAt' | 'updatedAt' | 'ownerId'
  | 'handoff' | 'outcome' | 'resolutionActor' | 'healthRevision' | 'handoffGeneration'> & {
    dispatchMode: 'live' | 'simulated'; evidence: Pick<Evidence, 'kind' | 'summary'> & { measurements: EhrMeasurements | null };
  };
export type EhrIncidentSummary = Omit<EhrIncident, 'version' | 'ownerId' | 'handoff' | 'resolutionActor'> & { ownerName: string | null };
export interface EhrSelectedIncident {
  incident: EhrIncident; ownerName: string | null; clinicalRevision: string | null;
  timeline: TimelineEvent[]; conversation: ConversationMessage[];
}
export interface EhrWorkspace {
  schemaVersion: 1; generatedAt: number;
  context: { scope: 'current' | 'incident'; incidentId: string | null; revision: string | null };
  patientRecord: PatientRecordSnapshot | null;
  care: { subject: { name: string; recordLink: 'unlinked' }; wellbeing: WellbeingView;
    incidents: EhrIncidentSummary[]; selectedIncident: EhrSelectedIncident | null };
  sources: { hospital: string; observations: string };
}
const hospitalSource = 'FinchNode (read-only)';
const observationSource = 'LIFELINE care log';

function incidentView(i: Incident): EhrIncident {
  const a = i.evidence.assessment;
  const measurements: EhrMeasurements | null = a ? { detector: a.detector, assessedAt: a.assessedAtMs,
    peakAccelerationG: a.impact.totalG, waistLinearG: a.supportingWaist.linearG,
    waistAngularSpeedRadS: a.supportingWaist.angularSpeed, quietDurationMs: a.quietWaist.durationMs,
    quietSampleCount: a.quietWaist.sampleCount, separationMs: a.supportingWaist.separationMs,
    captureClock: a.impact.captureClock, bodyTimingUncertaintyMs: a.alignmentAtAssessment.bodyUncertaintyMs,
    waistTimingUncertaintyMs: a.alignmentAtAssessment.waistUncertaintyMs } : null;
  return { id: i.id, phase: i.phase, version: i.version, createdAt: i.createdAt, updatedAt: i.updatedAt,
    dispatchMode: i.dispatchMode ?? 'live', evidence: { kind: i.evidence.kind, summary: i.evidence.summary, measurements },
    ownerId: i.ownerId, handoff: i.handoff, outcome: i.outcome, resolutionActor: i.resolutionActor,
    ...(i.healthRevision ? { healthRevision: i.healthRevision } : {}),
    ...(i.handoffGeneration ? { handoffGeneration: i.handoffGeneration } : {}) };
}
function eventDetail(event: TimelineEvent): string {
  let data: Record<string, unknown> | null = null;
  try { const parsed: unknown = JSON.parse(event.detail); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>; }
  catch { /* Plain policy descriptions already contain no transport envelope. */ }
  if (!data) return event.detail;
  const text = (value: unknown) => typeof value === 'string' ? value : null;
  switch (event.type) {
    case 'CHECKIN_REPLY': return [text(data.transcript), text(data.decision)].filter(Boolean).join(' · ');
    case 'WEARER_REPORT': case 'RESPONDER_REPORT': case 'CONVERSATION_MESSAGE':
      return text(data.transcript) ?? (text(data.reaction) ? `Reported reaction: ${data.reaction}` : 'Human report recorded.');
    case 'HANDOFF_PREPARED': return `Handoff prepared · ${text(data.generation) ?? 'generation unknown'} · saved clinical revision ${text(data.clinicalRevision) ?? 'unavailable'}.`;
    case 'HEALTH_CONTEXT_BOUND': return `Clinical context saved · revision ${text(data.revision) ?? 'unavailable'} · ${Array.isArray(data.recordIds) ? data.recordIds.length : 0} source records.`;
    case 'CONVERSATION_PLAYBACK': return `Wearable playback: ${text(data.status) ?? 'unknown'}.`;
    case 'QUESTION_RECEIVED': return `Responder question: ${text(data.question) ?? 'not retained'}. Received for preparation; no answer delivery is established.`;
    case 'ANSWER_QUEUED': return `Record question: ${text(data.question) ?? 'not retained'} · ${text(data.generation) ?? 'generation unknown'} · clinical revision ${text(data.healthRevision) ?? 'unavailable'}. Queued does not establish receipt.`;
    default: return 'Local care event recorded.';
  }
}

/** Read-only projection; private transport identities and safety controls never enter the clinical workspace. */
export function buildEhrWorkspace(input: {
  patientRecord: PatientRecordSnapshot | null; incidentId: string | null; wearerName: string;
  wellbeing: WellbeingView; incidents: Incident[]; selectedIncident: Incident | null;
  timeline: TimelineEvent[]; conversation: ConversationMessage[]; responders: Responder[]; now?: number;
}): EhrWorkspace {
  const owner = (i: Incident) => input.responders.find(r => r.id === i.ownerId)?.name ?? null;
  const incidents = [...input.incidents].sort((a, b) => b.createdAt - a.createdAt).slice(0, 12).map(i => {
    const { version, ownerId, handoff, resolutionActor, ...summary } = incidentView(i);
    return { ...summary, ownerName: owner(i) };
  });
  const selected = input.selectedIncident;
  return { schemaVersion: 1, generatedAt: input.now ?? Date.now(),
    context: { scope: input.incidentId ? 'incident' : 'current', incidentId: input.incidentId,
      revision: input.patientRecord?.revision ?? null },
    patientRecord: input.patientRecord ? structuredClone(input.patientRecord) : null,
    care: { subject: { name: input.wearerName, recordLink: 'unlinked' }, wellbeing: structuredClone(input.wellbeing), incidents,
      selectedIncident: selected ? { incident: incidentView(selected), ownerName: owner(selected), clinicalRevision: selected.healthRevision ?? null,
        timeline: input.timeline.filter(event => event.incidentId === selected.id).slice(-150).map(event => ({
          id: event.id, incidentId: event.incidentId, type: event.type, actor: event.actor, at: event.at, detail: eventDetail(event),
        })),
        conversation: input.conversation.filter(message => message.incidentId === selected.id).slice(-100).map(message => ({
          id: message.id, incidentId: message.incidentId, speaker: message.speaker, speakerName: message.speakerName,
          text: message.text, source: message.source, at: message.at, delivery: message.delivery,
          ...(message.detail ? { detail: message.detail } : {}),
        })),
      } : null },
    sources: { hospital: hospitalSource, observations: observationSource },
  };
}
