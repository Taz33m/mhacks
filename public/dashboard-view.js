const closedPhases = new Set(['RESOLVED', 'CANCELLED_FALSE_ALARM']);
const labels = { DETECTED: 'Possible incident', CONFIRMING: 'Checking in', HELP_REQUESTED: 'Help requested',
  ACKNOWLEDGED: 'Help accepted', RESPONDER_EN_ROUTE: 'Help is on the way', ON_SCENE: 'Responder on scene' };
const finite = value => typeof value === 'number' && Number.isFinite(value);

/** The product opens on the current incident. Saved outcomes remain in the audit trail. */
export function activeIncident(snapshot) {
  return snapshot?.incident && !closedPhases.has(snapshot.incident.phase) ? snapshot.incident : null;
}
const timestamp = value => finite(value) ? value : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : -Infinity;
function wearerReport(snapshot, incident) {
  if (!incident) return null;
  const reports = (snapshot.conversation || []).filter(message => message.incidentId === incident.id && message.speaker === 'wearer'
    && typeof message.text === 'string' && message.text.trim()).map(message => ({
      text: message.text, source: message.source, at: message.at, speakerName: message.speakerName,
    }));
  for (const event of snapshot.timeline || []) {
    if (event.incidentId !== incident.id || !['CHECKIN_REPLY', 'WEARER_REPORT'].includes(event.type)) continue;
    try {
      const data = JSON.parse(event.detail);
      if (typeof data.transcript !== 'string' || !data.transcript.trim()) continue;
      reports.push({ text: data.transcript, source: data.source || event.actor || 'wearer-report', at: event.at,
        speakerName: snapshot.wearer?.name || 'Patient' });
    } catch { /* A policy description is not a wearer quotation. */ }
  }
  return reports.sort((a, b) => timestamp(b.at) - timestamp(a.at))[0] || null;
}

/** Present only measured state: connected transport, usable data, reported ownership, and exact words. */
export function dashboardPresentation(snapshot, online = true) {
  const incident = activeIncident(snapshot), latestReport = wearerReport(snapshot || {}, incident);
  const wearerName = snapshot?.wearer?.name || latestReport?.speakerName
    || (snapshot?.conversation || []).find(message => message.speaker === 'wearer')?.speakerName || 'Patient';
  const owner = incident?.ownerId ? (snapshot?.responders || []).find(person => person.id === incident.ownerId) : null;
  const ownerName = incident?.ownerId ? owner?.name || 'Responder' : null;
  const simulated = incident?.dispatchMode === 'simulated';
  let ownerState = !incident ? 'No response needed' : !incident.ownerId ? 'Awaiting acceptance'
    : ({ ACKNOWLEDGED: 'Accepted responsibility', RESPONDER_EN_ROUTE: 'En route', ON_SCENE: 'On scene' }[incident.phase] || 'Owner recorded');
  let ownerDetail = !incident ? 'No active incident.' : !incident.ownerId ? 'No responder has accepted yet.'
    : ({ ACKNOWLEDGED: 'Departure not confirmed.', RESPONDER_EN_ROUTE: 'Arrival not confirmed.', ON_SCENE: 'Outcome pending.' }[incident.phase] || 'Responsibility is recorded.');
  if (simulated && incident?.ownerId) ownerDetail = `Local responder. ${ownerDetail}`;
  const next = {
    DETECTED: 'Opening the patient check-in.', CONFIRMING: 'Waiting for the patient’s response.',
    HELP_REQUESTED: 'Waiting for a responder to accept responsibility.', ACKNOWLEDGED: `Waiting for ${ownerName || 'the responder'} to confirm departure.`,
    RESPONDER_EN_ROUTE: `Waiting for ${ownerName || 'the responder'} to confirm arrival.`, ON_SCENE: 'Waiting for a recorded outcome.',
  };
  const rawStatus = incident ? labels[incident.phase] || 'Incident open' : 'No active incident';
  let statusLabel = rawStatus;
  if (!online) { statusLabel = incident ? `Last known: ${rawStatus}` : 'Connection interrupted'; ownerState = `Last known: ${ownerState}`; }
  const body = snapshot?.wili, waist = snapshot?.sensors?.find(source => source.source === 'waist-airpod');
  const connectedSources = online ? Number(body?.connected === true) + Number(waist?.connected === true) : 0;
  const bodyReady = body?.connected === true && body.fresh === true && body.usable === true && finite(body.totalG)
    && finite(body.sampleHz) && body.sampleHz > 0;
  const waistReady = waist?.connected === true && waist.fresh === true && finite(waist.totalG)
    && finite(waist.sampleHz) && waist.sampleHz > 0;
  const readySources = online ? Number(bodyReady) + Number(waistReady) : 0;
  const accepted = incident?.ownerId ? (snapshot?.timeline || []).filter(event => event.incidentId === incident.id && event.type === 'ACKNOWLEDGED'
    && (event.actor === incident.ownerId || event.actor === `simulated-dispatch:${incident.ownerId}`)).at(-1) : null;
  return { wearerName, statusLabel, ownerName, ownerState, ownerDetail, simulated, latestReport, connectedSources, readySources,
    acceptedAt: accepted?.at ?? null,
    summary: !online ? 'Reconnect to see current incident progress.' : latestReport ? latestReport.text
      : !incident ? 'The next check-in or request for help will appear here.'
        : incident.evidence?.kind === 'manual' ? 'A request for help is open.'
          : incident.evidence?.kind === 'synthetic' ? 'A check-in was started manually.' : 'A possible incident needs attention.',
    nextStep: !online ? 'Reconnect to see current incident progress.' : incident ? next[incident.phase] || 'Review the unresolved incident.'
      : 'Listening for a check-in or request for help.',
  };
}

/** Display-only memory. A quiet report interval never erases a measured value. */
export function retainWiliReading(wili, previous, { now, elapsed = 0, online = true } = {}) {
  const session = typeof wili?.sessionId === 'string' && wili.sessionId ? wili.sessionId : null;
  const retained = session && previous?.sessionId !== session ? null : previous;
  const receiptAge = finite(wili?.receivedAgeMs) && wili.receivedAgeMs >= 0 ? wili.receivedAgeMs + elapsed : null;
  if (online && wili?.connected && session && wili.fresh === true && finite(now)
    && receiptAge !== null && receiptAge >= 0 && receiptAge < 500 && finite(wili.totalG)
    && Array.isArray(wili.accelerationG) && wili.accelerationG.length === 3 && wili.accelerationG.every(finite)) {
    return { sessionId: session, totalG: wili.totalG, accelerationG: [...wili.accelerationG], receivedAt: now - receiptAge };
  }
  return retained || null;
}

const metric = (value, unit, digits = 1) => finite(value) && value >= 0 ? `${value.toFixed(digits)} ${unit}` : 'Not recorded';

export function workspaceView(hash) {
  const aliases = { overview: 'status', care: 'medical', dev: 'developer', 'incident-title': 'status',
    'patient-title': 'medical', 'conversation-title': 'conversation', 'signals-heading': 'motion',
    'timeline-title': 'activity', 'readiness-title': 'connections', calibration: 'motion' };
  const requested = String(hash || '').replace(/^#/, '');
  if (['motion', 'location', 'status', 'medical', 'conversation', 'activity', 'connections', 'teaching', 'developer'].includes(requested)) return requested;
  return Object.hasOwn(aliases, requested) ? aliases[requested] : 'motion';
}

/** Incident evidence stays frozen; current sensor orientation is never a body-pose diagnosis. */
export function motionPresentation(snapshot, online = true, wiliPoints = []) {
  const incident = activeIncident(snapshot), assessment = incident?.evidence?.assessment;
  const measured = incident?.evidence?.kind === 'cross-body' && assessment?.detector === 'wili-waist-provisional-v1';
  const shaking = incident?.evidence?.shaking?.detector === 'sustained-shaking-exploratory-v1' ? incident.evidence.shaking : null;
  const reportedSeizure = incident?.evidence?.eventType === 'reported-seizure';
  const waist = snapshot?.sensors?.find(sensor => sensor.source === 'waist-airpod');
  const report = dashboardPresentation(snapshot, online).latestReport;
  const live = liveMotion(snapshot, wiliPoints, online);
  return {
    event: !incident ? 'Monitoring' : measured ? 'Possible fall' : shaking ? 'Sustained unusual movement'
      : reportedSeizure ? 'Seizure reported by patient' : incident.evidence?.kind === 'manual' ? 'Help requested'
      : incident.evidence?.kind === 'synthetic' ? 'Patient check-in' : 'Possible incident',
    impact: measured ? metric(assessment.impact?.totalG, 'g', 2) : live.impact,
    rotation: measured ? metric(assessment.supportingWaist?.angularSpeed, 'rad/s', 2) : shaking ? metric(shaking.peakAngularSpeed, 'rad/s', 2) : live.rotation,
    quiet: measured ? metric(finite(assessment.quietWaist?.durationMs) ? assessment.quietWaist.durationMs / 1000 : null, 's') : live.quiet,
    tilt: online && waist?.connected && waist.fresh && waist.calibrated && finite(waist.tiltDegrees)
      ? `${waist.tiltDegrees.toFixed(0)}° from baseline` : 'Orientation unavailable',
    severity: incident ? 'Needs assessment' : 'No active incident',
    severityDetail: shaking ? 'Unusual movement is recorded. A seizure diagnosis and severity are not established.'
      : reportedSeizure ? 'This is a patient report. Clinical severity is not established.'
        : incident ? 'Impact is motion evidence. Injury severity is not established.' : 'No severity assigned.',
    report: report?.text || 'No suspected injury reported.',
    source: !incident ? 'Impact, rotation and stillness show the last 10 s of live sensor readings. A detected fall records its own measurements.'
      : shaking ? `${metric(shaking.durationMs / 1000, 's')} of alternating chest and waist movement. Possible seizure-like motion; no diagnosis established.`
        : reportedSeizure ? 'Patient reported a current seizure. Help is requested; this is not sensor-confirmed.'
      : measured ? 'Impact, rotation and quiet duration were captured at detection. Tilt is current sensor orientation.'
        : 'Started manually. Impact, rotation and stillness show the last 10 s of live sensor readings, not detection evidence.',
  };
}

/** A wearer quotation establishes a recorded reply, never consciousness, breathing or absence of bleeding. */
export function conditionPresentation(snapshot, online = true) {
  const incident = activeIncident(snapshot), report = dashboardPresentation(snapshot, online).latestReport;
  const spoken = report?.source === 'freewili-local-speech' || report?.source === 'ios-on-device-speech';
  return { response: !online ? 'Last received state' : report ? 'Reply recorded' : incident ? 'Awaiting reply' : 'No active check-in',
    speaking: spoken ? 'Voice reply recorded' : 'Not observed',
    at: report?.at ?? null, source: report?.source ?? null, report: report?.text ?? null };
}

// Presentation-only sample fixture. It is never inserted in incident state, alerts, or hospital records.
export const watchPreview = Object.freeze({ source: 'Sample watch observations', live: false,
  heartRate: 76, oxygen: 98, respiratoryRate: 16,
  conditions: Object.freeze([
    Object.freeze({ label: 'Conscious', value: 'Awake', detail: 'Sample caregiver observation' }),
    Object.freeze({ label: 'Breathing', value: 'Regular', detail: 'Sample watch respiration' }),
    Object.freeze({ label: 'Bleeding', value: 'Not observed', detail: 'Sample caregiver observation' }),
    Object.freeze({ label: 'Mobility', value: 'At rest', detail: 'Sample watch activity' }),
  ]) });

/** Frontend-received measurements only, with no interpolated points during quiet intervals. */
export function appendWiliTrace(previous, reading, now) {
  if (!reading || !finite(now)) return previous;
  const trace = previous.sessionId === reading.sessionId ? previous.points : [];
  const last = trace.at(-1);
  const points = trace.filter(point => now - point.at <= 30000);
  if (finite(reading.receivedAt) && finite(reading.totalG) && (!last || reading.receivedAt - last.at > 8))
    points.push({ at: reading.receivedAt, totalG: reading.totalG, tiltDegrees: null });
  return { sessionId: reading.sessionId, points: points.slice(-600) };
}

/** Last-window live readings for display when an incident has no detector evidence. Never used for detection. */
export function liveMotion(snapshot, wiliPoints = [], online = true, windowSeconds = 10) {
  const empty = { impact: 'Not recorded', rotation: 'Not recorded', quiet: 'Not recorded' };
  if (!online) return empty;
  const waist = snapshot?.sensors?.find(sensor => sensor.source === 'waist-airpod');
  const waistTrace = waist?.connected && Array.isArray(waist.trace) ? waist.trace.filter(point => finite(point?.at)) : [];
  const waistEnd = waistTrace.at(-1)?.at;
  const recentWaist = finite(waistEnd) ? waistTrace.filter(point => point.at >= waistEnd - windowSeconds) : [];
  const wiliTrace = Array.isArray(wiliPoints) ? wiliPoints.filter(point => finite(point?.at) && finite(point?.totalG)) : [];
  const wiliEnd = wiliTrace.at(-1)?.at;
  const recentWili = finite(wiliEnd) ? wiliTrace.filter(point => point.at >= wiliEnd - windowSeconds * 1000) : [];
  const peak = (points, key) => points.reduce((max, point) => finite(point[key]) && point[key] > max ? point[key] : max, -Infinity);
  const impact = peak(recentWili, 'totalG'), rotation = peak(recentWaist, 'angularSpeed');
  const lastMove = recentWaist.findLast(point => finite(point.angularSpeed) && point.angularSpeed > .35)?.at;
  const still = recentWaist.length ? waistEnd - (finite(lastMove) ? lastMove : recentWaist[0].at) : null;
  return {
    impact: finite(impact) ? `${impact.toFixed(2)} g peak · live` : empty.impact,
    rotation: finite(rotation) ? `${rotation.toFixed(2)} rad/s peak · live` : empty.rotation,
    quiet: finite(still) ? `${Math.round(still)} s still · live` : empty.quiet,
  };
}
