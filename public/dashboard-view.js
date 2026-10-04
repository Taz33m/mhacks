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
        speakerName: snapshot.wearer?.name || 'Wearer' });
    } catch { /* A policy description is not a wearer quotation. */ }
  }
  return reports.sort((a, b) => timestamp(b.at) - timestamp(a.at))[0] || null;
}

/** Present only measured state: connected transport, usable data, reported ownership, and exact words. */
export function dashboardPresentation(snapshot, online = true) {
  const incident = activeIncident(snapshot), latestReport = wearerReport(snapshot || {}, incident);
  const wearerName = snapshot?.wearer?.name || latestReport?.speakerName
    || (snapshot?.conversation || []).find(message => message.speaker === 'wearer')?.speakerName || 'Wearer';
  const owner = incident?.ownerId ? (snapshot?.responders || []).find(person => person.id === incident.ownerId) : null;
  const ownerName = incident?.ownerId ? owner?.name || 'Responder' : null;
  const simulated = incident?.dispatchMode === 'simulated';
  let ownerState = !incident ? 'No response needed' : !incident.ownerId ? 'Awaiting acceptance'
    : ({ ACKNOWLEDGED: 'Accepted responsibility', RESPONDER_EN_ROUTE: 'En route', ON_SCENE: 'On scene' }[incident.phase] || 'Owner recorded');
  let ownerDetail = !incident ? 'No active incident.' : !incident.ownerId ? 'No responder has accepted yet.'
    : ({ ACKNOWLEDGED: 'Departure not confirmed.', RESPONDER_EN_ROUTE: 'Arrival not confirmed.', ON_SCENE: 'Outcome pending.' }[incident.phase] || 'Responsibility is recorded.');
  if (simulated && incident?.ownerId) ownerDetail = `Simulated responder. ${ownerDetail}`;
  const next = {
    DETECTED: 'Opening the wearer check-in.', CONFIRMING: 'Waiting for the wearer’s response.',
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
          : incident.evidence?.kind === 'synthetic' ? 'A generated incident is being rehearsed.' : 'A possible incident needs attention.',
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
