import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEhrWorkspace } from './ehr.ts';
import type { Incident, Evidence, TimelineEvent } from './contracts.ts';
import { normalizePatientRecord } from './patient-record.ts';
import { patientFixture } from './test-helpers/patient-fixture.ts';
import { Wellbeing } from './wellbeing.ts';

function incident(index = 1): Incident {
  return { id: `LF-${index}`, phase: 'RESOLVED', version: 3, createdAt: index, updatedAt: index + 1,
    dispatchMode: 'simulated', evidence: { kind: 'manual', summary: 'Help requested by wearer.' },
    checkinId: 'private-checkin', checkinDeadline: 5000, progressDeadline: null,
    ownerId: 'maya', handoff: 'Saved handoff.', outcome: 'Simulated outcome.', resolutionActor: 'maya',
    healthRevision: 'saved-revision', handoffGeneration: 'degraded' };
}
function assemble(selected = incident(), incidents = [selected], extraEvents: TimelineEvent[] = []) {
  const w = new Wellbeing(':memory:', { phone: '+15555550101', wearerName: 'Actual wearer' });
  try {
    return buildEhrWorkspace({ patientRecord: normalizePatientRecord(structuredClone(patientFixture), 1000),
      incidentId: null, wearerName: 'Actual wearer', wellbeing: w.view(), incidents, selectedIncident: selected,
      timeline: [{ id: 'E-1', incidentId: selected.id, type: 'WEARER_REPORT', actor: 'wearer', at: 10,
        detail: JSON.stringify({ transcript: 'My ankle hurts.', messageId: 'private-message', chatId: 'private-chat' }) }, ...extraEvents],
      conversation: [], responders: [{ id: 'maya', name: 'Maya', phone: '+15555550102', simulated: true }], now: 2000 });
  } finally { w.close(); }
}

test('chart preserves distinct fictional and wearer identities, saved revision, and exact reports without transport controls', () => {
  const original = incident(), workspace = assemble(original), selected = workspace.care.selectedIncident!;
  assert.equal(workspace.care.subject.recordLink, 'unlinked');
  assert.equal(workspace.care.subject.name, 'Actual wearer');
  assert.equal(workspace.patientRecord!.records.find(r => r.category === 'demographics')!.fields.name, 'Fictional Patient');
  assert.equal(selected.clinicalRevision, 'saved-revision');
  assert.notEqual(selected.clinicalRevision, workspace.context.revision);
  assert.equal(selected.timeline[0].detail, 'My ankle hurts.');
  assert.equal(selected.ownerName, 'Maya');
  const text = JSON.stringify(workspace);
  for (const value of ['private-checkin', 'private-message', 'private-chat', '+15555550101', '+15555550102', 'checkinDeadline'])
    assert.equal(text.includes(value), false);
  original.evidence.summary = 'Later mutation'; original.phase = 'HELP_REQUESTED';
  assert.equal(selected.incident.evidence.summary, 'Help requested by wearer.');
  assert.equal(selected.incident.phase, 'RESOLVED');
});

test('received responder questions preserve the question without exposing preparation transport identities', () => {
  const selected = incident();
  const question = '{"question":"What medications are recorded?"}';
  const workspace = assemble(selected, [selected], [{ id: 'E-2', incidentId: selected.id,
    type: 'QUESTION_RECEIVED', actor: 'maya', at: 11,
    detail: JSON.stringify({ question, inboundId: 'private-inbound', incidentVersion: 3,
      source: 'photon-imessage', providerTimestamp: 10 }) }]);
  const description = workspace.care.selectedIncident!.timeline[1].detail;
  assert.ok(description.includes(question));
  assert.match(description, /no answer delivery is established/);
  assert.equal(JSON.stringify(workspace).includes('private-inbound'), false);
});

test('manual requests have no invented fall measurements; measured evidence preserves capture clock and exact units without device sessions', () => {
  assert.equal(assemble().care.selectedIncident!.incident.evidence.measurements, null);
  const measured = incident();
  measured.evidence = { kind: 'cross-body', summary: 'Provisional measured incident.',
    sourceSessions: { 'body-wili': 'private-body-session', 'waist-airpod': 'private-waist-session' },
    assessment: { detector: 'wili-waist-provisional-v1', assessedAtMs: 42,
      impact: { totalG: 1.8, captureClock: 'host-receipt', sessionId: 'private-body-session' },
      supportingWaist: { linearG: .6, angularSpeed: 1.4, separationMs: 30, sessionId: 'private-waist-session' },
      quietWaist: { durationMs: 2300, sampleCount: 57 },
      alignmentAtAssessment: { bodyUncertaintyMs: 16, waistUncertaintyMs: 9 },
    } as Evidence['assessment'] };
  const workspace = assemble(measured), evidence = workspace.care.selectedIncident!.incident.evidence;
  assert.equal(evidence.measurements!.peakAccelerationG, 1.8);
  assert.equal(evidence.measurements!.waistAngularSpeedRadS, 1.4);
  assert.equal(evidence.measurements!.quietDurationMs, 2300);
  assert.equal(evidence.measurements!.captureClock, 'host-receipt');
  assert.equal(evidence.measurements!.bodyTimingUncertaintyMs, 16);
  assert.equal(JSON.stringify(workspace).includes('private-body-session'), false);
  assert.equal(JSON.stringify(workspace).includes('private-waist-session'), false);
  measured.evidence.assessment!.impact.totalG = 9;
  assert.equal(evidence.measurements!.peakAccelerationG, 1.8);
});

test('bounded newest history never substitutes a selected older incident or invents an unknown owner name', () => {
  const older = incident(1); older.ownerId = 'former-responder';
  const workspace = assemble(older, Array.from({ length: 14 }, (_, index) => incident(index + 1)));
  assert.equal(workspace.care.incidents.length, 12);
  assert.equal(workspace.care.incidents[0].id, 'LF-14');
  assert.equal(workspace.care.incidents.at(-1)!.id, 'LF-3');
  assert.equal(workspace.care.selectedIncident!.incident.id, 'LF-1');
  assert.equal(workspace.care.selectedIncident!.ownerName, null);
  assert.equal(workspace.care.selectedIncident!.incident.ownerId, 'former-responder');
});
