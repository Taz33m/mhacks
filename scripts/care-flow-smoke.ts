import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCareReply } from '../src/care-reply.ts';
import { createWellbeingReply } from '../src/wellbeing-reply.ts';
import { Wellbeing } from '../src/wellbeing.ts';
import { createIncidentSmokeProviders } from './incident-flow-smoke.ts';

// Reuse the loopback-only inference gate. No messaging or voice credentials enter this rehearsal.
const env = Object.fromEntries(['LIFELINE_LLM_API_KEY', 'LIFELINE_LLM_BASE_URL', 'LIFELINE_LLM_MODEL']
  .map(key => [key, process.env[key]]));
const providers = createIncidentSmokeProviders(env);
const started = performance.now();
const health = await providers.loadHealth();
assert.ok(health.available && health.patientRecord?.synthetic && health.patientRecord.environment === 'demo',
  'Available fictional Finch records are required for the care rehearsal.');
const original = JSON.stringify(health.patientRecord);
const dir = await mkdtemp(join(tmpdir(), 'lifeline-care-flow-'));
const w = new Wellbeing(join(dir, 'care.sqlite'), { wearerName: 'Rehearsal wearer', phone: '+15555550101' });
const care = createCareReply({ loadHealth: async () => health,
  answerPatientQuestionDetailed: providers.answerPatientQuestionDetailed,
  companion: createWellbeingReply({ env }),
});
const results: { question: string; text: string; generation: string; elapsedMs: number; revision?: string | null; sourceRecordIds?: string[] }[] = [];
try {
  for (const [index, question] of ["I'm feeling lonely today.", 'What allergies are in my record?',
    'What medications are recorded?', 'What are the current vitals?', 'Should I take aspirin?'].entries()) {
    assert.equal(w.recordVoice({ eventId: `generated-care-${index}`, sessionId: 'generated-rehearsal',
      conversationId: w.conversationId, transcript: question }), true);
    const pending = w.replyNeeded()!, began = performance.now();
    const reply = await care.generate(pending, w.view().messages);
    const queued = reply.recordContext
      ? w.queueRecordReply(pending.id, reply.text, reply.generation, reply.recordContext, reply.patientRecord)
      : reply.generation !== 'policy_refusal' && w.queueReply(pending.id, reply.text, reply.generation);
    assert.equal(queued, true, 'The grounded reply must fit the actual daily outbox contract.');
    const action = w.claimAction()!;
    assert.ok(action && w.actionPermitted(action, false));
    assert.equal(w.actionPermitted(action, true), false, 'An active incident blocks everyday care submission.');
    w.finishAction(action.id, 'cancelled', 'Isolated rehearsal: external messages intentionally disabled.');
    if (index === 0) {
      assert.equal(reply.recordContext, undefined);
      assert.equal(reply.generation, 'ai', 'A social template does not pass the local AI rehearsal.');
    } else {
      assert.equal(reply.recordContext!.revision, health.patientRecord.revision);
      assert.match(reply.text, /^From your health record:/);
      if (index === 4) assert.equal(reply.generation, 'policy_refusal');
      else if (index === 3) {
        assert.equal(reply.generation, 'degraded', 'Current vitals must remain a deterministic unknown, not invented inference.');
        assert.match(reply.text, /not available.*historical/i);
        assert.equal(reply.recordContext!.sourceRecordIds.length, 0);
      } else {
        assert.equal(reply.generation, 'ai', 'Clinical templates do not pass the local AI rehearsal.');
        assert.ok(reply.recordContext!.sourceRecordIds.length > 0);
      }
    }
    results.push({ question, text: reply.text, generation: reply.generation,
      elapsedMs: Math.round(performance.now() - began), ...(reply.recordContext ? {
        revision: reply.recordContext.revision, sourceRecordIds: reply.recordContext.sourceRecordIds,
      } : {}) });
  }
  assert.equal(JSON.stringify(health.patientRecord), original, 'Clinical source remains immutable; no journal writeback.');
  const journal = w.careJournal();
  assert.equal(journal.hospitalRecords.snapshots.length, 4);
  assert.equal(journal.lifelineObservations.messages.filter(m => m.speaker === 'wearer').length, 5);
  const report = { status: 'passed', rehearsal: { input: 'generated-text-replay', health: 'real Finch synthetic endpoint',
    inference: 'configured local model', physicalAcquisition: false, externalMessages: false },
    clinicalRevision: health.patientRecord.revision, results,
    checks: { sourceSeparation: true, immutableClinicalSource: true, incidentPreemption: true,
      savedSnapshots: journal.hospitalRecords.snapshots.length }, elapsedMs: Math.round(performance.now() - started) };
  await mkdir(resolve('output/verification'), { recursive: true });
  await writeFile(resolve('output/verification/care-flow-current.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, elapsedMs: report.elapsedMs,
    generations: results.map(result => result.generation), externalMessages: false }));
} finally { w.close(); await rm(dir, { recursive: true, force: true }); }
