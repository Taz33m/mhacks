import test from 'node:test';
import assert from 'node:assert/strict';
import type { Incident, Phase, SensorView, Snapshot } from '../src/contracts.ts';
import type { BodyWiliView } from '../src/freewili.ts';

// Pure presentation tests with generated snapshots only: no DOM, fetch,
// runtime, hardware, clinical inference or provider transport is exercised.
const moduleUrl = new URL('../public/dashboard-view.js', import.meta.url).href;
const { activeIncident, dashboardPresentation, retainWiliReading, workspaceView, motionPresentation, conditionPresentation,
  watchPreview, appendWiliTrace } = await import(moduleUrl);
const at = 1_800_000_000_000;
test('four clinical routes retain old links and reject unknown route keys', () => {
  for (const view of ['motion', 'location', 'status', 'medical']) assert.equal(workspaceView(`#${view}`), view);
  assert.equal(workspaceView('#overview'), 'status');
  assert.equal(workspaceView('#care'), 'medical');
  assert.equal(workspaceView('#dev'), 'developer');
  for (const hash of ['', '#unknown', '#constructor', '#__proto__']) assert.equal(workspaceView(hash), 'motion');
});

test('a manual check-in never becomes a measured fall or injury severity', () => {
  const state = snapshot({ incident: incident(), sensors: [waist({ calibrated: true, tiltDegrees: 70 })] });
  const view = motionPresentation(state);
  assert.equal(view.event, 'Patient check-in');
  assert.equal(view.impact, 'Not recorded');
  assert.equal(view.rotation, 'Not recorded');
  assert.equal(view.quiet, 'Not recorded');
  assert.equal(view.severity, 'Needs assessment');
  assert.equal(view.tilt, '70° from baseline');
  assert.equal(motionPresentation(state, false).tilt, 'Orientation unavailable');
  state.sensors[0].fresh = false;
  assert.equal(motionPresentation(state).tilt, 'Orientation unavailable');
});

test('cross-body assessment keeps frozen measurements distinct from current orientation and a saved outcome', () => {
  const state = snapshot();
  // Generated, partial presentation fixture: no actual hardware or diagnosis.
  state.incident = incident('CONFIRMING', { evidence: { kind: 'cross-body', summary: 'Generated measurement fixture',
    assessment: { detector: 'wili-waist-provisional-v1', impact: { totalG: 1.72 }, supportingWaist: { angularSpeed: 2.5 },
      quietWaist: { durationMs: 2400 } } as Incident['evidence']['assessment'] } });
  const view = motionPresentation(state);
  assert.equal(view.event, 'Possible fall');
  assert.equal(view.impact, '1.72 g');
  assert.equal(view.rotation, '2.50 rad/s');
  assert.equal(view.quiet, '2.4 s');
  assert.equal(view.tilt, 'Orientation unavailable');
  assert.equal(view.severity, 'Needs assessment');
  state.incident.phase = 'RESOLVED';
  assert.equal(motionPresentation(state).impact, 'Not recorded');
  assert.equal(motionPresentation(state).event, 'Monitoring');
});

test('a voice reply is source-attributed and does not imply physiological measurements', () => {
  const current = incident();
  const state = snapshot({ incident: current, conversation: [{ id: 'generated-reply', incidentId: current.id,
    speaker: 'wearer', speakerName: 'Generated wearer', text: 'I cannot stand', source: 'freewili-local-speech', at,
    delivery: 'recorded' }] });
  const condition = conditionPresentation(state);
  assert.equal(condition.response, 'Reply recorded');
  assert.equal(condition.speaking, 'Voice reply recorded');
  assert.equal(condition.source, 'freewili-local-speech');
  assert.equal(condition.at, at);
  assert.equal(Object.hasOwn(condition, 'breathing'), false);
  assert.equal(conditionPresentation(state, false).response, 'Last received state');
  state.incident = incident('CONFIRMING', { id: 'LF-NEXT-GENERATED' });
  assert.equal(conditionPresentation(state).response, 'Awaiting reply');
  assert.equal(conditionPresentation(state).speaking, 'Not observed');
});

test('watch preview is explicitly non-live and does not mutate or populate incident state', () => {
  const state = snapshot({ incident: incident() }), before = JSON.stringify(state);
  conditionPresentation(state); motionPresentation(state);
  assert.equal(watchPreview.live, false);
  assert.equal(watchPreview.source, 'Sample watch observations');
  assert.ok(Object.isFrozen(watchPreview));
  assert.ok(watchPreview.conditions.every((item: object) => Object.isFrozen(item)));
  assert.equal(JSON.stringify(state), before);
  assert.equal(conditionPresentation(state).speaking, 'Not observed');
});

test('chest chart never duplicates retained samples or interpolates quiet gaps, and resets on a new session', () => {
  const first = { sessionId: 'generated-A', totalG: 1.01, receivedAt: at };
  const initial = appendWiliTrace({ sessionId: null, points: [] }, first, at);
  const retained = appendWiliTrace(initial, first, at + 1000);
  assert.equal(retained.points.length, 1);
  const next = appendWiliTrace(retained, { ...first, receivedAt: at + 2000, totalG: 1.9 }, at + 2000);
  assert.equal(next.points.length, 2);
  assert.equal(next.points[1].at - next.points[0].at, 2000);
  const reset = appendWiliTrace(next, { ...first, sessionId: 'generated-B', receivedAt: at + 3000 }, at + 3000);
  assert.equal(reset.points.length, 1);
  const expired = appendWiliTrace(reset, { ...first, sessionId: 'generated-B', receivedAt: at + 40000 }, at + 40000);
  assert.equal(expired.points.length, 1);
});
function incident(phase: Phase = 'CONFIRMING', changes: Partial<Incident> = {}): Incident {
  return { id: 'LF-GENERATED-DASHBOARD', phase, version: 1, createdAt: at, updatedAt: at,
    dispatchMode: 'live', evidence: { kind: 'synthetic', summary: 'Generated presentation fixture; no measured fall.' },
    checkinId: 'private-fixture-checkin', checkinDeadline: at + 20_000,
    progressDeadline: null, ownerId: null, handoff: 'Fictional clinical source, not a wearer symptom report.',
    outcome: null, resolutionActor: null, ...changes };
}
function waist(changes: Partial<SensorView> = {}): SensorView {
  return { source: 'waist-airpod', connected: true, fresh: true, calibrated: false,
    sensorLocation: 'Right', sessionId: 'generated-waist-session', ageMs: 15, sampleHz: 47,
    alignmentUncertaintyMs: 5, totalG: 1, tiltDegrees: null, trace: [], ...changes };
}
function wili(changes: Partial<BodyWiliView> = {}): BodyWiliView {
  return { source: 'body-wili', sensorLocation: 'body', connected: true, fresh: true, usable: true,
    sessionId: 'generated-wili-session', captureClock: 'host-receipt', quality: 'measured',
    receivedAgeMs: 20, captureAgeMs: 20, ageMs: 20, alignmentUncertaintyMs: 6, sampleHz: 1,
    accelerationG: [0, 0, 1], totalG: 1, fullScaleG: 2, saturated: false, rejectedSamples: 0, ...changes };
}
function snapshot(changes: Partial<Snapshot> = {}): Snapshot {
  return { serverTime: at, incident: null, responders: [{ id: 'maya', name: 'Maya', phone: null }],
    policy: { demoMode: false, checkinMs: 20_000, configuredCheckinMs: 20_000 },
    dispatch: { mode: 'live', detail: 'Generated presentation fixture.' }, timeline: [], actions: [],
    sensors: [], conversation: [], providers: {}, wearerMessaging: { configured: false, detail: 'No transport in presentation test.' },
    trial: null, ...changes };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

test('terminal saved incidents leave a calm idle dashboard without changing retained policy evidence', () => {
  for (const phase of ['RESOLVED', 'CANCELLED_FALSE_ALARM'] as const) {
    const saved = incident(phase, { ownerId: 'maya', outcome: 'Generated outcome retained for history.',
      resolutionActor: 'development-operator' });
    const input = freeze(snapshot({ incident: saved })), before = JSON.stringify(input);
    assert.equal(activeIncident(input), null);
    const view = dashboardPresentation(input);
    assert.equal(view.statusLabel, 'No active incident');
    assert.doesNotMatch(view.statusLabel + view.summary + view.nextStep, /rehearsal ended|development reset|patient is safe|all clear/i);
    assert.equal(JSON.stringify(input), before);
    assert.equal(input.incident!.outcome, saved.outcome);
    assert.equal(dashboardPresentation(snapshot()).statusLabel, 'No active incident');
  }
});

test('active policy phases retain distinct human progress while an unknown phase remains unresolved', () => {
  const phases = [
    ['DETECTED', 'Possible incident'], ['CONFIRMING', 'Checking in'], ['HELP_REQUESTED', 'Help requested'],
    ['ACKNOWLEDGED', 'Help accepted'], ['RESPONDER_EN_ROUTE', 'Help is on the way'], ['ON_SCENE', 'Responder on scene'],
  ] as const;
  for (const [phase, label] of phases) {
    const current = incident(phase), input = freeze(snapshot({ incident: current }));
    assert.equal(activeIncident(input), current, 'presentation retains the actual unresolved incident identity');
    assert.equal(dashboardPresentation(input).statusLabel, label);
  }
  const future = { ...incident(), phase: 'FUTURE_UNRESOLVED_PHASE' } as unknown as Incident;
  const input = snapshot({ incident: future });
  assert.equal(activeIncident(input), future);
  assert.notEqual(dashboardPresentation(input).statusLabel, 'No active incident');
});

test('an accepted outbound alert cannot become responder acceptance or ownership', () => {
  const current = incident('HELP_REQUESTED');
  const input = freeze(snapshot({ incident: current, actions: [{ id: 'generated-alert', incidentId: current.id,
    type: 'alert', recipientId: 'maya', text: 'Generated alert text.', status: 'provider_accepted', attempts: 1,
    providerMessageId: 'private-provider-receipt', providerResult: 'Transport accepted only.', nextAttemptAt: at, createdAt: at }] }));
  const view = dashboardPresentation(input);
  assert.equal(view.statusLabel, 'Help requested'); assert.equal(view.ownerState, 'Awaiting acceptance');
  assert.equal(view.ownerName, null);
  assert.doesNotMatch(view.ownerDetail, /Maya has accepted|Maya is on the way|Maya has arrived/i);
  assert.equal(JSON.stringify(view).includes('private-provider-receipt'), false);
  assert.equal(input.incident!.ownerId, null);
});

test('assigned ownership distinguishes acceptance, departure and arrival without inferring progress from message text', () => {
  for (const [phase, state] of [['ACKNOWLEDGED', 'Accepted responsibility'], ['RESPONDER_EN_ROUTE', 'En route'], ['ON_SCENE', 'On scene']] as const) {
    const current = incident(phase, { ownerId: 'maya' });
    const input = snapshot({ incident: current, conversation: [{ id: 'generated-responder-intent', incidentId: current.id,
      speaker: 'responder', speakerName: 'Maya', text: 'I am already there in this generated message.',
      source: 'photon-imessage', at: at + 1, delivery: 'recorded' }] });
    const view = dashboardPresentation(input);
    assert.equal(view.ownerName, 'Maya'); assert.equal(view.ownerState, state);
    assert.equal(view.latestReport, null, 'a responder statement is not reattributed to the wearer');
    assert.equal(input.incident!.phase, phase);
  }
});

test('simulation labels follow the persisted incident mode rather than the current backend profile', () => {
  const demo = dashboardPresentation(snapshot({ incident: incident('ACKNOWLEDGED', { ownerId: 'maya', dispatchMode: 'simulated' }),
    dispatch: { mode: 'live', detail: 'Backend profile changed after incident opened.' } }));
  assert.equal(demo.simulated, true); assert.match(demo.ownerDetail, /^Local responder\./);
  const live = dashboardPresentation(snapshot({ incident: incident('ACKNOWLEDGED', { ownerId: 'maya', dispatchMode: 'live' }),
    dispatch: { mode: 'simulated', detail: 'Backend profile changed after incident opened.' } }));
  assert.equal(live.simulated, false); assert.doesNotMatch(live.ownerDetail, /^Local responder\./);
});

test('wearer reports preserve exact text, source, time and attribution and never use fictional clinical handoff as symptoms', () => {
  const current = incident('CONFIRMING');
  const actualQuote = 'I bumped my knee.\nI am not sure whether I can stand.';
  const input = freeze(snapshot({ incident: current, conversation: [
    { id: 'generated-old-report', incidentId: 'LF-OLD-INCIDENT', speaker: 'wearer', speakerName: 'Another wearer',
      text: 'Unrelated older report.', source: 'photon-imessage', at: at - 1, delivery: 'recorded' },
    { id: 'generated-current-report', incidentId: current.id, speaker: 'wearer', speakerName: 'Actual fixture wearer',
      text: actualQuote, source: 'freewili-local-speech', at: at + 1, delivery: 'recorded' },
    { id: 'generated-responder-report', incidentId: current.id, speaker: 'responder', speakerName: 'Maya',
      text: 'A responder claim that must not replace the wearer quote.', source: 'photon-imessage', at: at + 2, delivery: 'recorded' },
    { id: 'generated-other-incident', incidentId: 'LF-OTHER-INCIDENT', speaker: 'wearer', speakerName: 'Other fixture wearer',
      text: 'An unrelated latest array entry.', source: 'photon-imessage', at: at + 3, delivery: 'recorded' },
  ] }));
  const view = dashboardPresentation(input);
  assert.equal(view.latestReport.text, actualQuote); assert.equal(view.latestReport.at, at + 1);
  assert.equal(view.latestReport.speakerName, 'Actual fixture wearer');
  assert.match(view.latestReport.source, /freewili|wili/i);
  assert.equal(dashboardPresentation(snapshot({ incident: current })).latestReport, null);
  assert.doesNotMatch(view.latestReport.text, /fracture|diagnosis|Fictional clinical/i);
});

test('legacy check-in audit fallback keeps exact wearer speech and skips malformed or unrelated events', () => {
  const current = incident('CONFIRMING'), transcript = 'I feel dizzy, but I have not asked to cancel.';
  const input = snapshot({ incident: current, timeline: [
    { id: 'generated-audit', incidentId: current.id, type: 'CHECKIN_REPLY', actor: 'photon-imessage', at: at + 1,
      detail: JSON.stringify({ transcript, decision: 'unresolved', inboundId: 'private-inbound-id', chatId: 'private-chat-id' }) },
    { id: 'generated-malformed', incidentId: current.id, type: 'CHECKIN_REPLY', actor: 'photon-imessage', at: at + 2, detail: '{invalid json' },
    { id: 'generated-other', incidentId: 'LF-OTHER-INCIDENT', type: 'CHECKIN_REPLY', actor: 'photon-imessage', at: at + 3,
      detail: JSON.stringify({ transcript: 'Unrelated incident speech.', decision: 'help_requested' }) },
  ] });
  const view = dashboardPresentation(input);
  assert.equal(view.latestReport.text, transcript); assert.equal(view.latestReport.at, at + 1);
  assert.match(view.latestReport.source, /photon|imessage/i);
  assert.doesNotMatch(JSON.stringify(view), /private-inbound-id|private-chat-id/);
  assert.equal(input.incident!.phase, 'CONFIRMING', 'report presentation never interprets speech as cancellation');
});

test('identity uses the approved wearer and never the fictional clinical subject or an invented name', () => {
  const named = snapshot({ wearer: { name: 'Approved fixture wearer' }, incident: incident(),
    conversation: [{ id: 'generated-report', incidentId: 'LF-GENERATED-DASHBOARD', speaker: 'wearer', speakerName: 'Recorded fixture wearer',
      text: 'Generated wearer report.', source: 'photon-imessage', at, delivery: 'recorded' }] });
  assert.equal(dashboardPresentation(named).wearerName, 'Approved fixture wearer');
  const unnamed = { ...named, wearer: undefined };
  assert.equal(dashboardPresentation(unnamed).wearerName, 'Recorded fixture wearer');
  const empty = dashboardPresentation(snapshot());
  assert.equal(empty.wearerName, 'Patient'); assert.doesNotMatch(empty.wearerName, /Liam|Fictional Patient/i);
});

test('sensing counts distinguish connections from actual fresh measured data and exclude the communication-only phone', () => {
  const phone = { ...waist(), source: 'chest-phone', sensorLocation: 'phone', calibrated: true } as SensorView;
  const connectedOnly = dashboardPresentation(snapshot({ wili: wili({ fresh: false, usable: false, sampleHz: 0,
    accelerationG: null, totalG: null, quality: 'awaiting-sample' }), sensors: [waist({ fresh: false, sampleHz: 0, totalG: null }), phone] }));
  assert.equal(connectedOnly.connectedSources, 2); assert.equal(connectedOnly.readySources, 0);
  const fresh = dashboardPresentation(snapshot({ wili: wili(), sensors: [waist(), phone] }));
  assert.equal(fresh.connectedSources, 2); assert.equal(fresh.readySources, 2,
    'optional tilt calibration is not needed for the paired motion features');
  for (const changed of [wili({ connected: false }), wili({ fresh: false }), wili({ usable: false }),
    wili({ sampleHz: 0 }), wili({ totalG: null }), wili({ totalG: NaN })])
    assert.equal(dashboardPresentation(snapshot({ wili: changed, sensors: [waist()] })).readySources, 1);
  for (const changed of [waist({ connected: false }), waist({ fresh: false }), waist({ sampleHz: 0 }), waist({ totalG: null }), waist({ totalG: Infinity })])
    assert.equal(dashboardPresentation(snapshot({ wili: wili(), sensors: [changed] })).readySources, 1);
  assert.equal(dashboardPresentation(snapshot()).connectedSources, 0);
});

test('offline cached incident status is explicitly last known and never turns into a safety determination', () => {
  const input = freeze(snapshot({ incident: incident('RESPONDER_EN_ROUTE', { ownerId: 'maya' }), wili: wili(), sensors: [waist()] }));
  const before = JSON.stringify(input), view = dashboardPresentation(input, false);
  assert.equal(view.statusLabel, 'Last known: Help is on the way');
  assert.equal(dashboardPresentation(snapshot(), false).statusLabel, 'Connection interrupted');
  assert.doesNotMatch(view.statusLabel + view.summary + view.nextStep, /patient is safe|all clear|confirmed arrival/i);
  assert.equal(JSON.stringify(input), before);
});

// The retained number is never written back into telemetry or readiness.
test('WILi display retains its actual last reading across quiet intervals without making stale inputs ready', () => {
  const first = freeze(wili());
  const reading = retainWiliReading(first, null, { now: at });
  assert.equal(reading.totalG, 1); assert.deepEqual(reading.accelerationG, [0, 0, 1]);
  const quiet = freeze(wili({ fresh: false, usable: false, totalG: null, accelerationG: null,
    receivedAgeMs: 10_000, sampleHz: 0, quality: 'stale' }));
  const retained = retainWiliReading(quiet, reading, { now: at + 10_000 });
  assert.strictEqual(retained, reading);
  assert.equal(dashboardPresentation(snapshot({ wili: quiet })).readySources, 0);
  assert.equal(quiet.totalG, null); assert.equal(quiet.fresh, false);
  assert.strictEqual(retainWiliReading(quiet, retained, { now: at + 20_000, online: false }), reading);
});

test('WILi display never invents a measured reading and a new device session starts cleanly', () => {
  const missing = wili({ fresh: false, totalG: null, accelerationG: null, receivedAgeMs: null });
  assert.equal(retainWiliReading(missing, null, { now: at }), null);
  const first = retainWiliReading(wili(), null, { now: at });
  assert.equal(retainWiliReading({ ...missing, sessionId: 'different-generated-session' }, first, { now: at }), null);
  const next = retainWiliReading(wili({ sessionId: 'different-generated-session', totalG: 1.2 }), first, { now: at + 1000 });
  assert.equal(next.totalG, 1.2); assert.notEqual(next.sessionId, first.sessionId);
  const offline = retainWiliReading(wili({ totalG: 9 }), first, { now: at + 1000, online: false });
  assert.strictEqual(offline, first);
});
