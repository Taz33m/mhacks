import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Controller } from '../src/controller.ts';
import type { Action, Incident, Phase, ProviderInbound } from '../src/contracts.ts';
import { handleWearerInbound } from '../src/wearer.ts';
import { handleResponderProgress } from '../src/responder.ts';
import { handleResponderRelay } from '../src/responder-relay.ts';
import { handleResponderQuestion } from '../src/responder-questions.ts';
import { createProviders } from '../src/providers/index.ts';
import type { DetailedAnswer, DetailedHandoff } from '../src/providers/index.ts';

export const GENERATED_WEARER_STATEMENT = 'I fell pretty hard. My ankle hurts and I can’t stand up.';
export const GENERATED_RESPONDER_STATEMENT = 'I’m coming downstairs now. Don’t try to stand.';
export const GENERATED_WEARER_UPDATE = 'My ankle is swelling. I am sitting by the stairs.';
export const GENERATED_OUTCOME = 'Responder stayed with the wearer and arranged an authorized clinical assessment; ankle injury remains unverified.';
const WEARER_PHONE = '+12025550100';
const RESPONDER = { id: 'isolated-responder', name: 'Rehearsal responder', phone: '+12025550101' };
const LINE = 'synthetic-recording-line';
const policy = { checkinMs: 20_000, acceptMs: 60_000, progressMs: 120_000 };
type SmokeProviders = Pick<ReturnType<typeof createProviders>, 'loadHealth' | 'buildHandoffDetailed' | 'answerQuestionDetailed'>;
interface RecordedOutbound { action: Action; messageId: string; chatId: string; lineId: string }
interface QuestionResult { question: string; answer: DetailedAnswer; elapsedMs: number }

export interface IncidentFlowSmokeReport {
  status: 'passed' | 'degraded'; aiRequirementMet: boolean;
  rehearsal: { synthetic: true; transport: 'local-recording'; wearerInput: 'generated-text-replay'; responderInput: 'generated-event-replay'; physicalAcquisition: false; externalMessages: false };
  incident: Pick<Incident, 'id' | 'phase' | 'ownerId' | 'outcome' | 'resolutionActor' | 'handoffGeneration'>;
  phases: Phase[];
  health: { synthetic: true; revision: string; recordIds: string[]; availableCategories: string[]; immutable: true };
  wearer: { text: string; conversationId: string; exactQuoteRelayed: true };
  wearerUpdate: { text: string; conversationId: string; exactQuoteRelayed: true; policyUnchanged: true; handoffRefreshed: true };
  handoff: DetailedHandoff & { elapsedMs: number };
  questions: QuestionResult[];
  recordedOutbox: { type: Action['type']; messageId: string; acceptance: 'synthetic-local-only' }[];
  checks: { nonCommandDidNotAssignOwner: true; acceptanceDidNotDepart: true; sourceSeparation: true; persistedAcrossReopen: true; concreteOutcome: true };
  elapsedMs: number;
}

/** Never forward messaging/voice credentials; live inference is restricted to a local runtime. */
export function createIncidentSmokeProviders(env: Record<string, string | undefined>) {
  const base = env.LIFELINE_LLM_BASE_URL?.trim();
  if (base) {
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash)
      throw new Error('Incident smoke requires a loopback local AI URL; hosted inference is not authorized by this rehearsal.');
  }
  return createProviders({ env: {
    LIFELINE_LLM_API_KEY: env.LIFELINE_LLM_API_KEY,
    LIFELINE_LLM_BASE_URL: base,
    LIFELINE_LLM_MODEL: env.LIFELINE_LLM_MODEL,
  } });
}

/** Fixture acceptance enables actual controller correlation; it never claims cloud delivery. */
function recordOutbox(controller: Controller, records: RecordedOutbound[]): void {
  for (let count = 0; count < 64; count++) {
    const action = controller.claimAction('any', true);
    if (!action) return;
    assert.ok(controller.actionPermitted(action), 'Recording transport must not accept a stale action.');
    const chatId = `any;-;${action.recipientId ? RESPONDER.phone : WEARER_PHONE}`;
    const messageId = `synthetic-recorded-${randomUUID()}`;
    records.push({ action: { ...action }, messageId, chatId, lineId: LINE });
    controller.finishAction(action.id, 'provider_accepted',
      'Synthetic recording transport accepted locally; no cloud submission or recipient delivery.', messageId, { chatId, lineId: LINE });
  }
  throw new Error('Isolated outbox exceeded the finite rehearsal action limit.');
}

function outbound(records: RecordedOutbound[], type: Action['type'], recipientId: string | null): RecordedOutbound {
  const record = records.findLast(record => record.action.type === type && record.action.recipientId === recipientId);
  assert.ok(record, `Missing recorded ${type} for the isolated conversation.`);
  return record;
}

function responderEvent(record: RecordedOutbound, content: Partial<ProviderInbound>): ProviderInbound {
  return { messageId: `generated-inbound-${randomUUID()}`, sender: RESPONDER.phone,
    kind: 'text', chatId: record.chatId, lineId: record.lineId, targetMessageId: record.messageId, ...content };
}

function requireCurrent(controller: Controller): Incident {
  const incident = controller.active(); assert.ok(incident, 'Expected the isolated active incident.'); return incident;
}

/** Actual policy/handler/provider integration, with generated input and a recording-only transport. */
export async function runIncidentFlowSmoke(options: { providers?: SmokeProviders } = {}): Promise<IncidentFlowSmokeReport> {
  const started = performance.now();
  const providers = options.providers ?? createIncidentSmokeProviders(process.env);
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-incident-smoke-'));
  const databasePath = join(directory, 'isolated.sqlite');
  let clock = Date.now();
  const controller = new Controller(databasePath, [RESPONDER], () => clock, policy, { wearerName: 'Rehearsal wearer' });
  const records: RecordedOutbound[] = [];
  try {
    const incident = controller.trigger({ kind: 'synthetic', summary: 'SYNTHETIC incident-flow rehearsal; no physical fall, sensor acquisition, or clinical diagnosis asserted.' });
    assert.equal(incident.phase, 'CONFIRMING');
    const health = controller.bindHealthContext(incident.id, await providers.loadHealth());
    assert.ok(health.available && health.patientRecord?.synthetic && health.patientRecord.environment === 'demo',
      'A real available synthetic Finch snapshot is required; unavailable data cannot pass the EHR rehearsal.');
    const clinicalSnapshot = JSON.stringify(controller.healthContext(incident.id));
    const revision = health.patientRecord.revision;
    recordOutbox(controller, records);

    const checkin = outbound(records, 'wearer_checkin', null);
    const wearerEvent: ProviderInbound = { messageId: `generated-wearer-${randomUUID()}`, sender: WEARER_PHONE,
      kind: 'text', text: GENERATED_WEARER_STATEMENT,
      chatId: checkin.chatId, lineId: checkin.lineId };
    clock += 100;
    assert.equal(handleWearerInbound(wearerEvent, WEARER_PHONE, controller), true);
    assert.equal(requireCurrent(controller).phase, 'HELP_REQUESTED');
    const wearerReport = controller.conversation(incident.id).find(message => message.speaker === 'wearer');
    assert.ok(wearerReport && wearerReport.text === GENERATED_WEARER_STATEMENT);
    recordOutbox(controller, records);
    const alert = outbound(records, 'alert', RESPONDER.id);
    const quote = outbound(records, 'wearer_relay', RESPONDER.id);
    assert.ok(alert.action.text.includes(`“${GENERATED_WEARER_STATEMENT}”`),
      'Urgent alert must carry the literal wearer report before waiting for AI handoff generation.');
    assert.equal(quote.action.text, `Rehearsal wearer: “${GENERATED_WEARER_STATEMENT}”`);

    const handoffStarted = performance.now();
    const handoff = await providers.buildHandoffDetailed(requireCurrent(controller), health, controller.conversation(incident.id));
    const handoffMs = performance.now() - handoffStarted;
    assert.ok(handoff.text.includes(`“${GENERATED_WEARER_STATEMENT}”`), 'Handoff must retain the exact generated ankle statement.');
    assert.ok(handoff.text.includes(`[conversation:${wearerReport.id}]`), 'Wearer quote needs its local conversation citation.');
    assert.match(handoff.text, /local observations, not hospital records/);
    assert.equal(handoff.healthRevision, revision);
    assert.ok(health.patientRecord.records.some(record => ['medications', 'conditions', 'allergies'].includes(record.section)
      && handoff.text.includes(`[${record.id}]`)), 'Handoff must also cite the separate clinical source.');
    controller.setHandoff(incident.id, handoff.text, handoff);
    recordOutbox(controller, records);
    assert.ok(outbound(records, 'handoff', RESPONDER.id).action.text.includes(handoff.text));

    const beforeRelay = requireCurrent(controller);
    const relay = responderEvent(quote, { text: GENERATED_RESPONDER_STATEMENT });
    assert.equal(handleResponderProgress(relay, controller), false);
    assert.equal(handleResponderRelay(relay, controller), true);
    assert.equal(handleResponderRelay(relay, controller), false, 'Duplicate human text must not create a second report.');
    const afterRelay = requireCurrent(controller);
    assert.deepEqual([afterRelay.phase, afterRelay.version, afterRelay.ownerId, afterRelay.progressDeadline],
      [beforeRelay.phase, beforeRelay.version, beforeRelay.ownerId, beforeRelay.progressDeadline], 'Human intent must not assign responsibility or alter timers.');
    assert.equal(afterRelay.ownerId, null);
    assert.equal(controller.conversation(incident.id).find(message => message.speaker === 'responder')?.text, GENERATED_RESPONDER_STATEMENT);

    const questions: QuestionResult[] = [];
    async function ask(question: string): Promise<DetailedAnswer> {
      const inbound = responderEvent(alert, { text: question });
      assert.equal(handleResponderRelay(inbound, controller), false, 'Questions must remain routed to grounded Q&A.');
      let answer: DetailedAnswer | undefined;
      const began = performance.now();
      assert.equal(await handleResponderQuestion(inbound, controller, async (current, text) => {
        answer = await providers.answerQuestionDetailed(current, health, text, controller.conversation(current.id));
        return answer;
      }), true);
      assert.ok(answer);
      questions.push({ question, answer, elapsedMs: performance.now() - began });
      recordOutbox(controller, records);
      const recorded = outbound(records, 'answer', RESPONDER.id);
      assert.ok(recorded.action.text.includes(answer.text));
      assert.equal(recorded.action.replyToMessageId, inbound.messageId);
      const audit = controller.events(incident.id).filter(event => event.type === 'ANSWER_QUEUED').at(-1);
      assert.ok(audit && JSON.parse(audit.detail).generation === answer.generation);
      assert.equal(requireCurrent(controller).ownerId, null, 'Q&A must not authorize ownership.');
      return answer;
    }
    const reportAnswer = await ask('What did the wearer say?');
    assert.ok(reportAnswer.text.includes(`“${GENERATED_WEARER_STATEMENT}”`));
    assert.ok(reportAnswer.text.includes(`[conversation:${wearerReport.id}]`));
    assert.match(reportAnswer.text, /local observations, not hospital records/);
    assert.ok(health.recordIds.every(id => !reportAnswer.text.includes(`[${id}]`)),
      'Wearer-only question must not disclose unrelated clinical record citations.');
    assert.ok(controller.conversation(incident.id).filter(message => message.speaker !== 'wearer')
      .every(message => !reportAnswer.text.includes(`[conversation:${message.id}]`)),
    'Wearer-only question must not disclose unrelated responder report citations.');
    const allergyAnswer = await ask('What allergies are recorded?');
    const allergyRecords = health.patientRecord.records.filter(record => record.section === 'allergies');
    assert.ok(allergyRecords.length && allergyRecords.some(record => allergyAnswer.text.includes(`[${record.id}]`)
      && typeof record.fields.substance === 'string' && allergyAnswer.text.includes(record.fields.substance)),
    'Recorded-allergy answer must cite an actual returned substance, separate from the wearer report.');
    assert.ok(!allergyAnswer.text.includes(`[conversation:${wearerReport.id}]`), 'Allergy-only question must not replace clinical facts with an injury report.');
    const mixedAnswer = await ask('What medications and allergies are recorded, and do we have current vital signs?');
    for (const section of ['medications', 'allergies']) {
      const rows = health.patientRecord.records.filter(record => record.section === section);
      assert.ok(rows.length && rows.some(record => mixedAnswer.text.includes(`[${record.id}]`)),
        `The mixed question must retain supporting ${section} records alongside unavailable current vitals.`);
    }
    assert.match(mixedAnswer.text, /Current vital signs (?:not provided|are not available)/,
      'The mixed answer must distinguish unavailable current vitals from recorded clinical history.');
    assert.ok(health.patientRecord.records.filter(record => record.section === 'vitals')
      .every(record => !mixedAnswer.text.includes(`[${record.id}]`)), 'Unrequested historical vitals must not substitute for current measurements.');
    const refusal = await ask('What medication should I give for the ankle pain?');
    assert.equal(refusal.generation, 'policy_refusal');

    const beforeUpdate = requireCurrent(controller);
    const updateEvent: ProviderInbound = { ...wearerEvent, messageId: `generated-wearer-update-${randomUUID()}`, text: GENERATED_WEARER_UPDATE };
    assert.equal(handleWearerInbound(updateEvent, WEARER_PHONE, controller), true);
    assert.equal(handleWearerInbound(updateEvent, WEARER_PHONE, controller), true);
    const wearerUpdate = controller.conversation(incident.id).find(message => message.text === GENERATED_WEARER_UPDATE);
    assert.ok(wearerUpdate && wearerUpdate.speaker === 'wearer');
    assert.equal(controller.conversation(incident.id).filter(message => message.text === GENERATED_WEARER_UPDATE).length, 1);
    assert.deepEqual(requireCurrent(controller), beforeUpdate, 'Later reports must not change ownership, phase or deadlines.');
    recordOutbox(controller, records);
    assert.equal(outbound(records, 'wearer_relay', RESPONDER.id).action.text, `Rehearsal wearer: “${GENERATED_WEARER_UPDATE}”`);
    const refreshedHandoff = await providers.buildHandoffDetailed(requireCurrent(controller), health, controller.conversation(incident.id));
    assert.ok(refreshedHandoff.text.includes(`“${GENERATED_WEARER_UPDATE}”`));
    assert.ok(refreshedHandoff.text.includes(`[conversation:${wearerUpdate.id}]`));
    controller.setHandoff(incident.id, refreshedHandoff.text, refreshedHandoff);
    assert.ok(requireCurrent(controller).handoff.includes(GENERATED_WEARER_UPDATE));
    recordOutbox(controller, records);
    assert.ok(outbound(records, 'handoff', RESPONDER.id).action.text.includes(GENERATED_WEARER_UPDATE),
      'Updated handoff must also reach the recording transport, rather than being suppressed by the initial handoff key.');

    clock += 100;
    assert.equal(handleResponderProgress(responderEvent(alert, { kind: 'reaction', reaction: '👍' }), controller), true);
    assert.equal(requireCurrent(controller).phase, 'ACKNOWLEDGED');
    assert.equal(requireCurrent(controller).ownerId, RESPONDER.id);
    recordOutbox(controller, records);
    let ownerStatus = outbound(records, 'status', RESPONDER.id);
    assert.match(ownerStatus.action.text, /Departure has not been confirmed/);
    clock += 100;
    assert.equal(handleResponderProgress(responderEvent(ownerStatus, { text: 'leaving' }), controller), true);
    assert.equal(requireCurrent(controller).phase, 'RESPONDER_EN_ROUTE');
    recordOutbox(controller, records);
    ownerStatus = outbound(records, 'status', RESPONDER.id);
    clock += 100;
    assert.equal(handleResponderProgress(responderEvent(ownerStatus, { text: 'arrived' }), controller), true);
    assert.equal(requireCurrent(controller).phase, 'ON_SCENE');
    recordOutbox(controller, records);
    ownerStatus = outbound(records, 'status', RESPONDER.id);
    clock += 100;
    assert.equal(handleResponderProgress(responderEvent(ownerStatus, { text: `RESOLVED ${incident.id} ${GENERATED_OUTCOME}` }), controller), true);
    const resolved = controller.incident(incident.id);
    assert.ok(resolved && resolved.phase === 'RESOLVED');
    assert.equal(resolved.outcome, GENERATED_OUTCOME);
    assert.equal(resolved.resolutionActor, RESPONDER.id);
    assert.equal(controller.active(), null);
    recordOutbox(controller, records);
    assert.equal(JSON.stringify(controller.healthContext(incident.id)), clinicalSnapshot, 'Local observations must not mutate the bound clinical snapshot.');
    assert.equal(JSON.stringify(controller.bindHealthContext(incident.id, { ...health, summary: 'A later retrieval must not replace this incident snapshot.' })), clinicalSnapshot);
    assert.equal(JSON.stringify(health), clinicalSnapshot, 'Context generation must not mutate the supplied clinical snapshot.');
    const phases = controller.events(incident.id).map(event => event.type).filter((type): type is Phase =>
      ['DETECTED', 'CONFIRMING', 'HELP_REQUESTED', 'ACKNOWLEDGED', 'RESPONDER_EN_ROUTE', 'ON_SCENE', 'RESOLVED', 'CANCELLED_FALSE_ALARM'].includes(type));
    assert.deepEqual(phases, ['DETECTED', 'CONFIRMING', 'HELP_REQUESTED', 'ACKNOWLEDGED', 'RESPONDER_EN_ROUTE', 'ON_SCENE', 'RESOLVED']);
    const reopened = new Controller(databasePath, [RESPONDER], () => clock, policy);
    try {
      assert.equal(reopened.incident(incident.id)?.outcome, GENERATED_OUTCOME);
      assert.equal(JSON.stringify(reopened.healthContext(incident.id)), clinicalSnapshot);
      assert.equal(reopened.conversation(incident.id).find(message => message.id === wearerReport.id)?.text, GENERATED_WEARER_STATEMENT);
      assert.equal(reopened.conversation(incident.id).find(message => message.id === wearerUpdate.id)?.text, GENERATED_WEARER_UPDATE);
    } finally { reopened.close(); }
    const aiRequirementMet = handoff.generation === 'ai' && refreshedHandoff.generation === 'ai' && reportAnswer.generation === 'ai' && allergyAnswer.generation === 'ai' && mixedAnswer.generation === 'ai';
    return {
      status: aiRequirementMet ? 'passed' : 'degraded', aiRequirementMet,
      rehearsal: { synthetic: true, transport: 'local-recording', wearerInput: 'generated-text-replay', responderInput: 'generated-event-replay', physicalAcquisition: false, externalMessages: false },
      incident: { id: resolved.id, phase: resolved.phase, ownerId: resolved.ownerId, outcome: resolved.outcome, resolutionActor: resolved.resolutionActor, handoffGeneration: resolved.handoffGeneration },
      phases, health: { synthetic: true, revision, recordIds: health.recordIds, availableCategories: health.patientRecord.availableCategories, immutable: true },
      wearer: { text: GENERATED_WEARER_STATEMENT, conversationId: wearerReport.id, exactQuoteRelayed: true },
      wearerUpdate: { text: GENERATED_WEARER_UPDATE, conversationId: wearerUpdate.id, exactQuoteRelayed: true, policyUnchanged: true, handoffRefreshed: true },
      handoff: { ...handoff, elapsedMs: handoffMs }, questions,
      recordedOutbox: records.map(record => ({ type: record.action.type, messageId: record.messageId, acceptance: 'synthetic-local-only' })),
      checks: { nonCommandDidNotAssignOwner: true, acceptanceDidNotDepart: true, sourceSeparation: true, persistedAcrossReopen: true, concreteOutcome: true },
      elapsedMs: performance.now() - started,
    };
  } finally { controller.close(); await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 2, 'Use the configured local model; incident smoke accepts no hardware, message, or database arguments.');
    const report = await runIncidentFlowSmoke();
    console.log(JSON.stringify(report, null, 2));
    if (!report.aiRequirementMet) process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', synthetic: true, externalMessages: false,
      detail: error instanceof Error ? error.message : 'Incident smoke failed.' }));
    process.exitCode = 1;
  }
}
