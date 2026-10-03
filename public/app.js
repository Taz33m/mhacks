(() => {
  'use strict';
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const phases = [
    ['CONFIRMING', 'Check-in'], ['HELP_REQUESTED', 'Help requested'],
    ['ACKNOWLEDGED', 'Accepted'], ['RESPONDER_EN_ROUTE', 'En route'],
    ['ON_SCENE', 'On scene'], ['RESOLVED', 'Resolved'],
  ];
  const titles = {
    DETECTED: 'Possible incident detected', CONFIRMING: 'Checking on the wearer',
    HELP_REQUESTED: 'Waiting for a responder', ACKNOWLEDGED: 'Responsibility accepted',
    RESPONDER_EN_ROUTE: 'Responder on the way', ON_SCENE: 'Responder is on scene',
    RESOLVED: 'Incident resolved', CANCELLED_FALSE_ALARM: 'Check-in cancelled',
  };
  const actionLabels = {
    queued: ['Queued', ''], attempting: ['Sending', 'warning'],
    provider_accepted: ['Provider accepted', 'good'], failed: ['Failed', 'bad'],
    unknown: ['Outcome unknown', 'warning'], cancelled: ['Cancelled', ''],
  };
  const generationLabels = {
    ai: ['AI GENERATED', 'good'], degraded: ['DEGRADED TEMPLATE', 'warning'],
    policy_refusal: ['POLICY REFUSAL', 'warning'],
  };
  const generationFor = (value) => typeof value === 'string' && Object.hasOwn(generationLabels, value) ? generationLabels[value] : ['PROVENANCE UNAVAILABLE', ''];
  let snapshot = null;
  let token = '';
  let busy = false;
  let online = false;
  let socket = null;
  let reconnectTimer = null;
  let retryDelay = 1000;
  let clockOffset = 0;
  let lastStateReceived = null;
  let responderSignature = '';
  let nativeSetup = null;
  let trialBusy = false;
  let handoffSignature = null;
  let contextRequest = null;
  let patientRecord = null;
  let patientScope = 'incident';
  let patientRequest = null;
  let patientContextKey = null;
  let patientQuestionRequest = null;
  let briefBusy = false;

  const escaped = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const text = (selector, value, scope = document) => { $(selector, scope).textContent = value; };
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  const number = (value, digits = 0) => finite(value) ? value.toFixed(digits) : '—';
  const terminal = (incident) => incident && ['RESOLVED', 'CANCELLED_FALSE_ALARM'].includes(incident.phase);
  const time = (value) => finite(value) ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
  const nameFor = (id) => snapshot?.responders.find((person) => person.id === id)?.name ?? id ?? 'Unassigned';
  const initials = (name) => String(name).split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase();

  function setConnection(connected, detail) {
    online = connected;
    $('#connection').className = `connection ${connected ? 'online' : 'offline'}`;
    $('#connection').innerHTML = `<i></i>${connected ? 'Live state' : 'Reconnecting'}`;
    $('#connection-error').hidden = connected || !detail;
    text('#connection-error', detail || '');
    snapshot?.sensors.forEach(renderSensor);
    renderWili();
    renderReadiness();
    updateControls();
  }

  function acceptSnapshot(value) {
    if (!value || !Array.isArray(value.sensors) || !Array.isArray(value.responders) || !Array.isArray(value.actions) || !Array.isArray(value.timeline)) throw new Error('Invalid server snapshot');
    const previousIncident = snapshot?.incident;
    snapshot = value;
    syncContext(previousIncident);
    if (finite(value.serverTime)) clockOffset = value.serverTime - Date.now();
    lastStateReceived = Date.now();
    value.sensors.forEach(renderSensor);
    renderWili();
    renderIncident();
    renderReply();
    renderResponders();
    renderProviders();
    renderReadiness();
    renderTimeline();
    renderActions();
    renderQuestions();
    renderTrial();
    renderPolicy();
    ensurePatientRecord();
    updateControls();
    updateTime();
  }

  function renderPolicy() {
    const policy = snapshot?.policy;
    const available = !!policy && finite(policy.checkinMs) && finite(policy.configuredCheckinMs);
    $('#policy-banner').hidden = !available;
    if (!available) return;
    const seconds = (value) => `${Number((value / 1000).toFixed(3))} s`;
    text('#policy-mode', policy.demoMode ? 'ACCELERATED DEMO' : 'CONFIGURED POLICY');
    $('#policy-mode').className = `badge ${policy.demoMode ? 'warning' : ''}`;
    text('#policy-detail', policy.demoMode
      ? `Demo timeout accelerated from configurable policy value: ${seconds(policy.checkinMs)} for new check-ins vs ${seconds(policy.configuredCheckinMs)} configured. Existing incident deadlines are preserved.`
      : `New check-ins use the configured ${seconds(policy.checkinMs)} timeout. Accelerated demo mode is off.`);
  }

  function renderSensor(sensor) {
    const card = document.getElementById(sensor.source);
    if (!card) return;
    const state = !sensor.connected ? 'Disconnected' : !online ? 'Last received' : !sensor.fresh ? 'Stale signal' : !sensor.calibrated ? 'Uncalibrated' : 'Fresh signal';
    const badge = $('.sensor-status', card);
    badge.textContent = state;
    badge.className = `badge sensor-status ${online && sensor.connected && sensor.fresh && sensor.calibrated ? 'good' : sensor.connected ? 'warning' : ''}`;
    text('.sensor-g', number(sensor.totalG, 2), card);
    text('.sensor-tilt', `Tilt ${number(sensor.tiltDegrees)}${finite(sensor.tiltDegrees) ? '°' : ''}`, card);
    text('.sensor-age', finite(sensor.ageMs) ? sensor.ageMs < 1000 ? `${Math.round(sensor.ageMs)} ms` : `${(sensor.ageMs / 1000).toFixed(1)} s` : 'No sample', card);
    text('.sensor-calibration', sensor.calibrated ? 'Calibrated' : 'Required', card);
    text('.sensor-alignment', finite(sensor.alignmentUncertaintyMs) ? `${Math.round(sensor.alignmentUncertaintyMs)} ms` : 'Unknown', card);
    text('.sensor-hz', finite(sensor.sampleHz) && sensor.sampleHz > 0 ? `${sensor.sampleHz.toFixed(1)} Hz` : '—', card);
    text('.sensor-identity', `Source: ${sensor.source}${sensor.sensorLocation ? ` · ${sensor.sensorLocation}` : ''} · ${sensor.sessionId ? `Session ${sensor.sessionId.slice(0, 8)}` : 'No session'}`, card);
    drawChart(card, sensor.trace || []);
  }

  function renderWili() {
    const wili = snapshot?.wili;
    const labels = { disconnected: 'Disconnected', 'awaiting-sample': 'Awaiting sample', unsynchronized: 'Unsynchronized', stale: 'Stale', 'capture-stale': 'Capture stale', 'insufficient-range': 'Insufficient range', saturated: 'Saturated', measured: 'Measured' };
    const status = !wili?.connected ? 'Disconnected' : !online ? 'Last received' : wili.usable ? 'Acquisition ready' : Object.hasOwn(labels, wili.quality) ? labels[wili.quality] : 'Unknown quality';
    text('#wili-status', status); $('#wili-status').className = `badge ${online && wili?.usable ? 'good' : wili?.connected ? 'warning' : ''}`;
    text('#wili-g', number(wili?.totalG, 2));
    ['x', 'y', 'z'].forEach((axis, index) => text(`#wili-${axis}`, finite(wili?.accelerationG?.[index]) ? `${number(wili.accelerationG[index], 3)} g` : '—'));
    const elapsed = !online && lastStateReceived ? Date.now() - lastStateReceived : 0;
    text('#wili-age', finite(wili?.receivedAgeMs) ? `${Math.round(wili.receivedAgeMs + elapsed)} ms` : 'No sample');
    text('#wili-capture-age', finite(wili?.captureAgeMs) ? `${Math.round(wili.captureAgeMs + elapsed)} ms` : 'Unknown');
    text('#wili-alignment', finite(wili?.alignmentUncertaintyMs) ? `${Math.round(wili.alignmentUncertaintyMs)} ms` : 'Unknown');
    text('#wili-hz', finite(wili?.sampleHz) && wili.sampleHz > 0 ? `${number(wili.sampleHz, 1)} Hz` : '—');
    text('#wili-range', finite(wili?.fullScaleG) ? `±${wili.fullScaleG} g` : 'Unknown');
    text('#wili-quality', wili?.quality || 'Unknown');
    text('#wili-identity', `Source: body-wili · ${wili?.sessionId ? `Session ${wili.sessionId}` : 'No session'} · ${wili?.captureClock || 'Capture clock not reported'}`);
    text('#wili-detail', `${wili?.saturated === true ? 'Saturation reported. ' : ''}${finite(wili?.rejectedSamples) ? `${wili.rejectedSamples} rejected packets. ` : ''}Acquisition readiness does not establish a working fall detector. Tilt and angular rate are unavailable.`);
  }

  function drawChart(card, rawTrace) {
    const trace = rawTrace.filter((point) => finite(point.at) && finite(point.totalG)).sort((a, b) => a.at - b.at);
    const width = 400, top = 7, bottom = 91, left = 27, right = 397;
    const maxG = Math.max(3, Math.ceil(Math.max(0, ...trace.map((point) => point.totalG))));
    $('.chart-grid', card).innerHTML = [0, maxG / 2, maxG].map((value) => {
      const y = bottom - value / maxG * (bottom - top);
      return `<line x1="${left}" y1="${y}" x2="${width}" y2="${y}"/><text x="0" y="${y + 3}">${number(value, value % 1 ? 1 : 0)} g</text>`;
    }).join('');
    $('.chart-empty', card).hidden = trace.length > 0;
    if (!trace.length) {
      $('.chart-accel', card).setAttribute('d', '');
      $('.chart-tilt', card).setAttribute('d', '');
      text('.chart-range', 'No history', card);
      return;
    }
    const lastAt = trace.at(-1).at;
    const windowMs = Math.max(1000, lastAt - trace[0].at);
    const startAt = lastAt - windowMs;
    const path = (field, scale) => {
      let result = '', prior = null;
      for (const point of trace) {
        if (!finite(point[field])) { prior = null; continue; }
        const x = left + (point.at - startAt) / windowMs * (right - left);
        const y = bottom - Math.max(0, Math.min(scale, point[field])) / scale * (bottom - top);
        result += `${!prior || point.at - prior.at > 500 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)} `;
        prior = point;
      }
      return result.trim();
    };
    $('.chart-accel', card).setAttribute('d', path('totalG', maxG));
    $('.chart-tilt', card).setAttribute('d', path('tiltDegrees', 180));
    text('.chart-range', `${(windowMs / 1000).toFixed(0)} s · tilt 0–180°`, card);
  }

  function renderIncident() {
    const incident = snapshot.incident;
    text('#incident-id', incident ? `ID ${incident.id}` : 'NO ACTIVE INCIDENT');
    text('#incident-title', incident ? titles[incident.phase] || incident.phase : 'Ready for an incident');
    text('#incident-summary', incident ? incident.evidence.summary : 'Connect the motion sources to begin. No incident has been reported.');
    const evidence = $('#evidence-badge');
    evidence.hidden = !incident;
    if (incident) {
      const labels = { synthetic: 'SYNTHETIC TRIGGER', manual: 'MANUAL REQUEST', 'single-source': 'SINGLE-SOURCE EVIDENCE', 'cross-body': 'CROSS-BODY EVIDENCE' };
      evidence.textContent = labels[incident.evidence.kind] || incident.evidence.kind;
      evidence.className = `badge ${incident.evidence.kind === 'synthetic' ? 'warning' : ''}`;
    }
    const phaseIndex = phases.findIndex(([phase]) => phase === incident?.phase);
    const cancelled = incident?.phase === 'CANCELLED_FALSE_ALARM';
    $('#phase-list').className = `phase-list${cancelled ? ' cancelled' : ''}`;
    $('#phase-list').innerHTML = phases.map(([phase, label], index) => `<li class="${phaseIndex > index ? 'complete' : phaseIndex === index ? 'current' : ''}"${phase === incident?.phase ? ' aria-current="step"' : ''}>${label}</li>`).join('');
    text('#owner', incident?.ownerId ? nameFor(incident.ownerId) : 'Unassigned');
    text('#owner-detail', incident?.ownerId ? {
      ACKNOWLEDGED: 'Accepted responsibility; departure not confirmed.',
      RESPONDER_EN_ROUTE: 'Departure recorded; arrival not confirmed.',
      ON_SCENE: 'Arrival recorded; outcome pending.', RESOLVED: 'Outcome recorded.',
      CANCELLED_FALSE_ALARM: 'Incident cancelled.',
    }[incident.phase] || 'Owner recorded for this incident.' : 'An alert alone does not establish ownership.');
    renderHandoff();
    $('#outcome-panel').hidden = !incident?.outcome;
    text('#outcome', incident?.outcome || '');
    text('#outcome-source', incident?.outcome ? `Recorded by ${nameFor(incident.resolutionActor)} · ${time(incident.updatedAt)}` : '');
  }

  function appendText(parent, tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = value;
    parent.appendChild(element);
    return element;
  }

  function patientContext() {
    const incident = snapshot?.incident;
    return patientScope === 'incident' && incident?.healthRevision ? { key: `${incident.id}:${incident.healthRevision}`, incidentId: incident.id } : { key: 'current', incidentId: null };
  }
  function clearPatientAnswer() {
    patientQuestionRequest?.controller.abort(); patientQuestionRequest = null;
    $('#patient-answer-panel').hidden = true; text('#patient-answer', ''); text('#patient-question-message', '');
    $('#patient-question-message').classList.remove('error');
  }
  function ensurePatientRecord() { if (token && patientContext().key !== patientContextKey) void loadPatientRecord(); }
  function updatePatientControls() {
    $('#patient-scope').value = patientContext().incidentId ? 'incident' : 'current';
    $('#patient-scope').querySelector('[value="incident"]').disabled = !snapshot?.incident?.healthRevision;
    $('#patient-scope').disabled = !token || !online || !!patientRequest;
    $('#patient-refresh').disabled = !token || !online || !!patientRequest;
    $('#patient-question-submit').disabled = !token || !online || !patientRecord || !!patientRequest || !!patientQuestionRequest || !$('#patient-question').value.trim() || $('#patient-question').value.trim().length > 2000;
    $('#patient-question').disabled = !!patientQuestionRequest;
    $('#care-brief').disabled = !token || !online || !snapshot?.incident || briefBusy;
  }
  function renderPatientRecord() {
    const record = patientRecord, demographic = record?.records.find(row => row.section === 'demographics');
    text('#patient-name', demographic?.label || 'Protected patient context');
    text('#patient-identity', record ? `Fictional Finch subject ${record.subject || 'not returned'} · separate from the demo wearer` : 'Fictional record identity is separate from the demo wearer.');
    text('#patient-snapshot', record ? `${patientContext().incidentId ? `Incident ${patientContext().incidentId} · immutable context` : 'Current patient context'}\nRevision ${record.revision}\nRetrieved ${new Date(record.fetchedAt).toISOString()} · fixture data as of ${record.dataAsOf || 'unknown'}\nRecord access ${record.status} · source consent ${record.consent?.status || 'unknown'} · sync ${record.sync?.status || 'unknown'}` : token ? 'Protected patient context has not been retrieved.' : 'Pairing token required to read patient records.');
    const container = document.createDocumentFragment();
    const titles = { demographics: 'Demographics', medications: 'Medications and history', conditions: 'Conditions', allergies: 'Allergies', vitals: 'Historical vitals' };
    const kinds = { medications: 'Prescription / regimen', medicationAdministrations: 'Administration record', medicationDispenses: 'Dispense record' };
    const labels = { birthDate: 'Birth date', recordedDate: 'Recorded date', onsetDate: 'Onset date', startDate: 'Regimen start', endDate: 'Regimen end', date: 'Recorded date', handedOverDate: 'Handed over', preparedDate: 'Prepared', dosageInstructions: 'Recorded instructions', quantityUnit: 'Quantity unit', daysSupply: 'Days supply', verificationStatus: 'Verification status', referenceRange: 'Source reference range', bodySite: 'Body site' };
    if (!record) appendText(container, 'p', 'empty-list', 'No patient records have been retrieved in this tab.');
    else {
      for (const category of ['allergies', 'medications', 'conditions', 'vitals', 'demographics']) {
        const group = record.categories?.[category], rows = record.records.filter(row => row.category === category);
        const section = appendText(container, 'details', 'patient-category', ''); section.open = category === 'allergies';
        const heading = appendText(section, 'summary', 'patient-category-heading', '');
        appendText(heading, 'strong', '', titles[category]); appendText(heading, 'span', 'badge', `${group?.state || 'unavailable'} · ${rows.length}`);
        appendText(section, 'p', 'field-note', group?.detail || 'Category availability was not reported.');
        for (const row of rows) {
          const article = appendText(section, 'article', 'clinical-row', ''), head = appendText(article, 'div', 'clinical-heading', '');
          appendText(head, 'strong', '', row.label);
          if (row.fields?.status) appendText(head, 'span', 'badge', `Recorded ${row.fields.status}`);
          if (Object.hasOwn(kinds, row.section)) appendText(article, 'p', 'clinical-kind', kinds[row.section]);
          if (row.section === 'vitals') appendText(article, 'p', 'historical-date', `Historical measurement ${row.fields?.date || 'date not returned'} · ${row.fields?.value ?? 'value not returned'} ${row.fields?.unit || 'unit not returned'}`);
          const fields = appendText(article, 'dl', 'clinical-fields', '');
          for (const [key, value] of Object.entries(row.fields || {})) {
            if (['name', 'substance', 'status'].includes(key) || (row.section === 'vitals' && ['date', 'value', 'unit'].includes(key))) continue;
            const field = appendText(fields, 'div', '', '');
            appendText(field, 'dt', '', Object.hasOwn(labels, key) ? labels[key] : key);
            appendText(field, 'dd', '', value === null ? 'Not returned; unknown' : Array.isArray(value) ? value.join('; ') : String(value));
          }
          const citation = appendText(article, 'details', 'clinical-source', '');
          appendText(citation, 'summary', '', `Source: ${row.sourceName || row.source || 'not returned'} · [${row.id}]`);
          appendText(citation, 'p', '', `Resource ${row.resourceType || 'unknown'} · source record ${row.sourceRecordId || 'unknown'}\nSource updated ${row.sourceUpdatedAt || 'unknown'}\nFinch synchronized ${row.syncedAt || 'unknown'}`);
          for (const code of row.codes || []) appendText(citation, 'p', '', `Code ${code.system || 'system unknown'} · ${code.code || 'unknown'}${code.display ? ` · ${code.display}` : ''}`);
          for (const detail of row.details || []) appendText(citation, 'p', '', `${detail.label}: ${detail.value}`);
        }
      }
      for (const warning of record.warnings || []) appendText(container, 'p', 'patient-warning', `${warning.code}: ${warning.message}`);
    }
    $('#patient-records').replaceChildren(container); updatePatientControls();
  }
  async function loadPatientRecord(refresh = false) {
    if (!token) return;
    const scope = patientContext(); patientRequest?.controller.abort();
    const request = { ...scope, token, controller: new AbortController() }; patientRequest = request; patientContextKey = scope.key;
    patientRecord = null; clearPatientAnswer(); renderPatientRecord();
    $('#patient-load-message').classList.remove('error'); text('#patient-load-message', refresh ? 'Refreshing the current patient read…' : 'Reading protected hospital context…');
    const current = () => patientRequest === request && token === request.token && patientContext().key === request.key;
    try {
      const read = async (url, method = 'GET') => {
        const response = await fetch(url, { method, headers: { Authorization: `Bearer ${request.token}` }, cache: 'no-store', signal: AbortSignal.any([request.controller.signal, AbortSignal.timeout(20000)]) });
        const result = await response.json();
        if (!response.ok || result.error) throw new Error(response.status === 401 ? 'Pairing token rejected. Enter a current operator token.' : result.error || `Patient records unavailable (${response.status}). Try Refresh current patient.`);
        if (result.synthetic !== true || result.environment !== 'demo' || typeof result.revision !== 'string' || !Array.isArray(result.records) || !finite(result.fetchedAt)) throw new Error('Patient record response could not be verified as the synthetic demo.');
        return result;
      };
      let result, refreshedRevision = null;
      if (refresh) { result = await read('/api/patient-record/refresh', 'POST'); refreshedRevision = result.revision; }
      if (!refresh || scope.incidentId) result = await read(`/api/patient-record${scope.incidentId ? `?incidentId=${encodeURIComponent(scope.incidentId)}` : ''}`);
      if (!current()) return;
      if (scope.incidentId && result.revision !== snapshot?.incident?.healthRevision) throw new Error('Returned records do not match this incident’s clinical revision. Refresh the incident context and try again.');
      patientRecord = result; renderPatientRecord();
      text('#patient-load-message', refresh && scope.incidentId ? `Current patient refreshed to ${refreshedRevision}. This incident retains ${result.revision}.` : 'Synthetic hospital records retrieved. No hospital record was changed.');
    } catch (error) { if (current()) { $('#patient-load-message').classList.add('error'); text('#patient-load-message', error.name === 'TimeoutError' ? 'Patient record read timed out. Check the server, then refresh.' : error.message || 'Patient records unavailable. Refresh to try again.'); } }
    finally { if (patientRequest === request) { patientRequest = null; updatePatientControls(); } }
  }
  async function askPatientQuestion() {
    const question = $('#patient-question').value.trim();
    if (!token || !patientRecord || patientQuestionRequest || !question || question.length > 2000) return;
    const request = { revision: patientRecord.revision, key: patientContext().key, controller: new AbortController() }; patientQuestionRequest = request; updatePatientControls();
    $('#patient-question-message').classList.remove('error'); text('#patient-question-message', 'Preparing a local record answer…');
    const current = () => patientQuestionRequest === request && patientRecord?.revision === request.revision && patientContext().key === request.key;
    try {
      const response = await fetch('/api/patient-record/question', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ question, revision: request.revision, ...(patientContext().incidentId ? { incidentId: patientContext().incidentId } : {}) }), signal: AbortSignal.any([request.controller.signal, AbortSignal.timeout(30000)]) });
      const result = await response.json(); if (!current()) return;
      if (!response.ok || result.error) throw new Error(result.error || `Record answer unavailable (${response.status}). Review or refresh the patient context.`);
      if (result.revision !== request.revision || typeof result.answer !== 'string' || typeof result.generation !== 'string' || !Object.hasOwn(generationLabels, result.generation)) throw new Error('Record answer context could not be verified. Refresh the patient context and ask again.');
      const generation = generationFor(result.generation); text('#patient-answer-generation', generation[0]); $('#patient-answer-generation').className = `badge ${generation[1]}`;
      text('#patient-answer-revision', `Source revision ${request.revision}`); text('#patient-answer', result.answer); $('#patient-answer-panel').hidden = false;
      text('#patient-question-message', 'Local answer prepared. No responder message was sent.');
    } catch (error) { if (current()) { $('#patient-question-message').classList.add('error'); text('#patient-question-message', error.message || 'Record answer unavailable. Try again.'); } }
    finally { if (patientQuestionRequest === request) { patientQuestionRequest = null; updatePatientControls(); } }
  }
  async function downloadCareBrief() {
    const incident = snapshot?.incident; if (!token || !incident || briefBusy) return;
    briefBusy = true; updatePatientControls(); text('#care-brief-message', 'Preparing the source-separated care brief…');
    try {
      const response = await fetch(`/api/incidents/${encodeURIComponent(incident.id)}/brief`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(20000) });
      if (!response.ok) { const result = await response.json(); throw new Error(result.error || `Care brief unavailable (${response.status})`); }
      const blob = await response.blob();
      if (snapshot?.incident?.id !== incident.id || snapshot?.incident?.version !== incident.version) throw new Error('Incident context changed. Download the current care brief again.');
      const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url;
      link.download = `lifeline-care-brief-${String(incident.id).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      text('#care-brief-message', 'Care brief download requested. Hospital facts and local incident reports remain separate.');
    } catch (error) { text('#care-brief-message', error.message || 'Care brief unavailable. Try again.'); }
    finally { briefBusy = false; updatePatientControls(); }
  }

  function renderHandoff() {
    const [generation, color] = generationFor(snapshot.incident?.handoffGeneration);
    text('#handoff-generation', generation); $('#handoff-generation').className = `badge ${color}`;
    const content = snapshot.incident?.handoff || 'A record-grounded handoff will appear here when it is available.';
    const signature = JSON.stringify([snapshot.incident?.id, content]);
    if (signature === handoffSignature) return;
    handoffSignature = signature;
    const fragment = document.createDocumentFragment();
    const headings = new Set(['Known source facts:', 'Unavailable information:', 'AI-composed synthetic health handoff:', 'AI unavailable — source template fallback:']);
    for (const line of content.split('\n')) {
      if (headings.has(line)) { appendText(fragment, 'h3', 'handoff-heading', line); continue; }
      const row = appendText(fragment, 'p', 'handoff-line', '');
      const category = line.match(/^(medications|conditions|allergies):/);
      const source = line.match(/ \[[^\]\n]+\]$/);
      const sourceStart = source ? line.length - source[0].length : line.length;
      if (category) {
        appendText(row, 'strong', 'handoff-category', category[0]);
        appendText(row, 'span', '', line.slice(category[0].length, sourceStart));
      } else appendText(row, 'span', '', line.slice(0, sourceStart));
      if (source) appendText(row, 'span', 'source-ref', source[0]);
    }
    $('#handoff').replaceChildren(fragment);
  }

  function syncContext(previousIncident) {
    const incident = snapshot?.incident;
    const changedIncident = previousIncident?.id !== incident?.id;
    const changedVersion = previousIncident?.version !== incident?.version;
    if (changedIncident) {
      $('#rehearsal-preview').hidden = true;
      text('#rehearsal-answer', '');
      text('#rehearsal-submitted-question', '');
      text('#rehearsal-context', '');
      text('#rehearsal-message', '');
      $('#rehearsal-message').classList.remove('error');
    }
    if (contextRequest && (changedIncident || changedVersion)) {
      contextRequest.controller.abort();
      contextRequest = null;
      text('#rehearsal-message', 'Incident context changed while generating. Review the current phase and generate a new preview.');
      $('#rehearsal-message').classList.add('error');
    }
  }

  function renderQuestions() {
    const incident = snapshot?.incident;
    text('#context-incident', incident ? `Context ${incident.id} · ${incident.phase} · version ${incident.version}` : 'No incident context available.');
    const questions = new Map();
    for (const event of snapshot.timeline) {
      if (event.incidentId !== incident?.id || event.type !== 'ANSWER_QUEUED') continue;
      try {
        const detail = JSON.parse(event.detail);
        if (detail && typeof detail.actionId === 'string' && typeof detail.question === 'string' && detail.source === 'photon-imessage') questions.set(detail.actionId, detail);
      } catch { /* Older audit entries do not contain the original question. */ }
    }
    const actions = snapshot.actions.filter((action) => action.incidentId === incident?.id && action.type === 'answer').slice().sort((a, b) => b.createdAt - a.createdAt);
    text('#question-count', actions.length);
    const fragment = document.createDocumentFragment();
    if (!actions.length) appendText(fragment, 'li', 'empty-list', 'No responder answer messages for this incident.');
    for (const action of actions) {
      const detail = questions.get(action.id);
      const row = appendText(fragment, 'li', 'question-item', '');
      const head = appendText(row, 'div', 'question-head', '');
      appendText(head, 'strong', '', nameFor(action.recipientId));
      const [label, color] = actionLabels[action.status] || [action.status, ''];
      appendText(head, 'span', `badge ${color}`, label);
      appendText(row, 'p', 'question-label', 'Question');
      appendText(row, 'p', 'question-text', detail ? detail.question : 'Question unavailable in the recorded audit entry.');
      const answerHead = appendText(row, 'div', 'question-answer-head', '');
      appendText(answerHead, 'p', 'question-label', 'Answer message');
      const [generation, generationColor] = generationFor(detail?.generation);
      appendText(answerHead, 'span', `badge ${generationColor}`, generation);
      appendText(row, 'p', 'question-answer', action.text || 'No answer text recorded.');
      appendText(row, 'p', 'question-result', action.providerResult || 'No provider result yet.');
      const source = detail ? `Photon iMessage${typeof detail.inboundId === 'string' ? ` · Inbound ${detail.inboundId}` : ''}` : 'Original question source unavailable';
      appendText(row, 'p', 'question-meta', `${time(action.createdAt)} · ${source} · Action ${action.id}`);
    }
    $('#responder-questions').replaceChildren(fragment);
  }

  function updateRehearsalControls() {
    const incident = snapshot?.incident;
    const question = $('#rehearsal-question').value.trim();
    $('#rehearsal-submit').disabled = !token || !online || !incident || !!contextRequest || !question || question.length > 2000;
    $('#rehearsal-question').disabled = !!contextRequest;
    text('#rehearsal-availability', !incident ? 'Start a labelled development simulation to provide incident context.'
      : !token ? 'Enter a development pairing token in Operator controls to enable this preview.'
      : !online ? 'Reconnect to the server before generating a preview.'
      : contextRequest ? 'Generating against the displayed incident context…'
      : 'Uses this incident, including a recorded terminal phase. Nothing is sent to a responder.');
  }

  async function rehearseQuestion() {
    const incident = snapshot?.incident;
    const question = $('#rehearsal-question').value.trim();
    if (!token || !online || !incident || contextRequest || !question || question.length > 2000) return;
    const request = { incidentId: incident.id, version: incident.version, phase: incident.phase, question, controller: new AbortController() };
    contextRequest = request;
    const current = () => contextRequest === request && snapshot?.incident?.id === request.incidentId && snapshot?.incident?.version === request.version;
    updateRehearsalControls();
    $('#rehearsal-message').classList.remove('error');
    text('#rehearsal-message', 'Generating a local preview…');
    try {
      const response = await fetch('/api/context/question', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ incidentId: request.incidentId, question }), signal: AbortSignal.any([request.controller.signal, AbortSignal.timeout(30000)]) });
      const result = await response.json().catch(() => { throw new Error('Preview service returned an unreadable response. Check server availability and try again.'); });
      if (!current()) return;
      if (response.status === 401) throw new Error('Pairing token rejected. Enter a current development token in Operator controls and try again.');
      if (!response.ok || result.error) throw new Error(`${result.error || `Preview unavailable (${response.status})`}. Review the current incident context and try again.`);
      if (result.incidentId !== request.incidentId || result.version !== request.version) throw new Error('Preview context did not match the requested incident and version. Review the current phase and generate a new preview.');
      if (typeof result.answer !== 'string' || typeof result.generation !== 'string' || !Object.hasOwn(generationLabels, result.generation)) throw new Error('Preview service returned an invalid answer. Check server availability and try again.');
      const generation = generationFor(result.generation);
      text('#rehearsal-generation', generation[0]);
      $('#rehearsal-generation').className = `badge ${generation[1]}`;
      text('#rehearsal-context', `Preview context ${request.incidentId} · ${request.phase} · version ${request.version}`);
      text('#rehearsal-submitted-question', `Question: ${request.question}`);
      text('#rehearsal-answer', result.answer);
      $('#rehearsal-preview').hidden = false;
      text('#rehearsal-message', 'Preview generated locally. No responder message was sent.');
    } catch (error) {
      if (!current()) return;
      $('#rehearsal-message').classList.add('error');
      text('#rehearsal-message', error.name === 'TimeoutError' ? 'Preview timed out. Check server and AI configuration, then try again.' : error.message || 'Preview unavailable. Check server availability and try again.');
    } finally {
      if (contextRequest === request) { contextRequest = null; updateRehearsalControls(); }
    }
  }

  function renderReply() {
    const reply = snapshot.timeline.findLast((event) => event.incidentId === snapshot.incident?.id && event.type === 'CHECKIN_REPLY');
    if (!reply) {
      text('#reply-decision', 'NO REPLY');
      text('#reply-transcript', 'No wearer reply received for this incident.');
      text('#reply-meta', 'iMessage replies can request help or preserve the check-in. Cancellation requires the explicit current check-in control. Board speech is pending.');
      $('#reply-transcript').classList.remove('has-reply');
      return;
    }
    let transcript = reply.detail, decision = 'Recorded';
    try {
      const detail = JSON.parse(reply.detail);
      if (typeof detail.transcript === 'string') transcript = detail.transcript;
      if (typeof detail.decision === 'string') decision = `Decision: ${detail.decision.replaceAll('_', ' ').replaceAll('-', ' ')}`;
    } catch { /* Preserve the recorded detail if it is not structured. */ }
    text('#reply-decision', decision);
    text('#reply-transcript', transcript);
    const source = reply.actor === 'ios-on-device-speech' ? 'Legacy iPhone on-device speech' : reply.actor === 'photon-imessage' ? 'Wearer iMessage via Photon' : reply.actor;
    text('#reply-meta', `${time(reply.at)} · ${source} · Cancellation requires the explicit check-in control.`);
    $('#reply-transcript').classList.add('has-reply');
  }

  function renderReadiness() {
    if (!snapshot) return;
    const sourceRows = [['waist-airpod', 'Waist AirPod stream']].map(([source, label]) => {
      const sensor = snapshot.sensors.find((item) => item.source === source);
      const receiving = online && sensor?.connected && sensor?.fresh;
      const status = !sensor?.connected ? 'Disconnected' : !online ? 'Last received' : !sensor.fresh ? 'Stale' : 'Receiving';
      const detail = sensor?.connected ? `${sensor.calibrated ? 'Standing calibration recorded' : 'Standing calibration required'}${source === 'waist-airpod' && sensor.sensorLocation ? ` · reporting ${sensor.sensorLocation} bud` : ''}` : 'No connected source reported';
      return `<li><div class="readiness-head"><strong>${label}</strong><span class="badge ${receiving ? 'good' : ''}">${status}</span></div><p>${escaped(detail)}</p></li>`;
    });
    const alignments = [['waist-airpod', 'Waist']].map(([source, label]) => {
      const uncertainty = snapshot.sensors.find((sensor) => sensor.source === source)?.alignmentUncertaintyMs;
      return `${label}: ${finite(uncertainty) ? `±${Math.round(uncertainty)} ms` : 'unknown'}`;
    }).join(' · ');
    const audio = snapshot.providers?.elevenlabs;
    const wearerMessaging = snapshot.wearerMessaging;
    const wili = snapshot.wili;
    $('#native-readiness').innerHTML = `<li><div class="readiness-head"><strong>FREE-WILi accelerometer</strong><span class="badge">${online && wili?.usable ? 'Acquisition ready' : escaped(wili?.quality || 'Unavailable')}</span></div><p>${escaped(`Source body-wili · range ${finite(wili?.fullScaleG) ? `±${wili.fullScaleG} g` : 'unknown'} · alignment ${finite(wili?.alignmentUncertaintyMs) ? `±${Math.round(wili.alignmentUncertaintyMs)} ms` : 'unknown'}. Fall assessment and board audio are unverified.`)}</p></li>` + sourceRows.join('')
      + `<li><div class="readiness-head"><strong>Clock alignment</strong></div><p>${escaped(alignments)}</p></li>`
      + `<li><div class="readiness-head"><strong>Check-in voice provider</strong><span class="badge">${audio?.configured ? 'Configured' : 'Unavailable'}</span></div><p>${escaped(audio?.detail || 'No voice provider status reported')} · Board playback is not established by provider configuration.</p></li>`
      + `<li><div class="readiness-head"><strong>Wearer iMessage</strong><span class="badge">${wearerMessaging?.configured ? 'Configured' : 'Unavailable'}</span></div><p>${escaped(wearerMessaging?.detail || 'No wearer messaging configuration reported')}</p></li>`;
    if (nativeSetup) {
      const addresses = nativeSetup.addresses.length ? nativeSetup.addresses.map((address) => `${address}:${nativeSetup.port}`).join('\n') : 'No external IPv4 address reported';
      const binding = nativeSetup.lanEnabled === true ? 'LAN binding enabled' : nativeSetup.lanEnabled === false ? 'Local-only binding' : 'Listener binding not reported';
      text('#setup-addresses', `${binding}\nMac bridge: 127.0.0.1:${nativeSetup.port}\nPhone host candidates:\n${addresses}`);
    } else {
      text('#setup-addresses', 'Open this console on the Mac to obtain local pairing and address metadata.');
    }
  }

  function renderResponders() {
    const responders = snapshot.responders;
    const ownerId = snapshot.incident?.ownerId;
    $('#responders').innerHTML = responders.length ? responders.map((person) => `<li class="responder-item"><span class="avatar">${escaped(initials(person.name))}</span><div><strong>${escaped(person.name)}</strong><p>${escaped(person.phone ? 'Configured contact' : 'No delivery contact configured')}</p></div>${person.id === ownerId ? '<span class="badge good">OWNER</span>' : ''}</li>`).join('') : '<li class="empty-list">No approved responders configured.</li>';
    const signature = responders.map((person) => `${person.id}:${person.name}`).join('|');
    if (signature !== responderSignature) {
      const selected = $('#responder').value;
      $('#responder').innerHTML = responders.length ? responders.map((person) => `<option value="${escaped(person.id)}">${escaped(person.name)}</option>`).join('') : '<option value="">No approved responders</option>';
      if (responders.some((person) => person.id === selected)) $('#responder').value = selected;
      responderSignature = signature;
    }
  }

  function renderProviders() {
    const providers = Object.entries(snapshot.providers || {});
    $('#providers').innerHTML = providers.length ? providers.map(([name, status]) => `<li class="provider-item"><div class="provider-head"><strong>${escaped(name)}</strong><span class="badge ${status.configured ? 'good' : ''}">${status.configured ? 'Configured' : 'Unavailable'}</span></div><p>${escaped(status.detail)}</p></li>`).join('') : '<li class="empty-list">No provider status available.</li>';
  }

  function renderTimeline() {
    const events = snapshot.timeline.filter((event) => event.incidentId === snapshot.incident?.id).slice().sort((a, b) => b.at - a.at);
    text('#event-count', events.length);
    $('#timeline').innerHTML = events.length ? events.map((event) => `<li class="event-item"><div class="event-head"><strong>${escaped(event.type.replaceAll('_', ' '))}</strong><time>${escaped(time(event.at))}</time></div><p>${escaped(timelineDetail(event))}</p><span class="event-actor">${escaped(nameFor(event.actor))}</span></li>`).join('') : '<li class="empty-list">Events will appear as the incident progresses.</li>';
  }

  function timelineDetail(event) {
    try {
      const detail = JSON.parse(event.detail);
      if (event.type === 'ANSWER_QUEUED' && detail?.source === 'photon-imessage' && typeof detail.question === 'string') {
        return `Question: ${detail.question}\nAnswer queued · ${generationFor(detail.generation)[0].toLowerCase()}. Delivery is not yet established.`;
      }
      if (event.type === 'CHECKIN_REPLY' && typeof detail?.transcript === 'string') {
        const decisions = { help_requested: 'Help requested', confirmation_required: 'Explicit cancellation still required', unresolved: 'Incident remains unresolved' };
        const decision = typeof detail.decision === 'string' && Object.hasOwn(decisions, detail.decision) ? decisions[detail.decision] : 'Reply recorded';
        return `Wearer reply: ${detail.transcript}\n${decision}.`;
      }
      if (event.type === 'HEALTH_CONTEXT_BOUND') {
        return detail?.available ? `Clinical context saved for this incident. Revision ${detail.revision || 'unavailable'}; ${Array.isArray(detail.recordIds) ? detail.recordIds.length : 0} source records.`
          : 'Clinical context unavailable. Incident response continues.';
      }
      if (event.type === 'HANDOFF_PREPARED') {
        return `Handoff prepared · ${generationFor(detail?.generation)[0].toLowerCase()}. Clinical revision ${detail?.clinicalRevision || 'unavailable'}.`;
      }
      if (event.type === 'RESPONDER_REPORT') {
        return `Responder ${typeof detail?.transcript === 'string' ? `reply: ${detail.transcript}` : `reaction: ${detail?.reaction || 'unknown'}`}\nRecorded phase: ${detail?.phase || 'unknown'}.`;
      }
    } catch { /* Preserve older plain text audit entries. */ }
    return event.detail;
  }

  function renderActions() {
    const actions = snapshot.actions.filter((action) => action.incidentId === snapshot.incident?.id).slice().sort((a, b) => b.createdAt - a.createdAt);
    const expanded = new Set([...$('#actions').querySelectorAll('details[open]')].map((message) => message.dataset.actionId));
    text('#action-count', actions.length);
    $('#actions').innerHTML = actions.length ? actions.map((action) => {
      const [label, color] = actionLabels[action.status] || [action.status, ''];
      const actionTitle = { wearer_checkin: 'Wearer iMessage', wearer_ack: 'Wearer iMessage acknowledgement', wearer_status: 'Wearer progress update', checkin: 'Device check-in request', answer: 'Responder answer' }[action.type] || action.type[0].toUpperCase() + action.type.slice(1);
      const message = action.text ? `<details class="action-message" data-action-id="${escaped(action.id)}"${expanded.has(action.id) ? ' open' : ''}><summary>View message</summary><p>${escaped(action.text)}</p></details>` : '';
      return `<li class="action-item"><div class="action-head"><strong>${escaped(actionTitle)}${action.recipientId ? ` · ${escaped(nameFor(action.recipientId))}` : ''}</strong><span class="badge ${color}">${escaped(label)}</span></div><p>${escaped(action.providerResult || 'No provider result yet.')}</p>${message}<span class="action-meta">${escaped(time(action.createdAt))} · ${action.attempts} attempt${action.attempts === 1 ? '' : 's'}${action.providerMessageId ? ` · Message ${escaped(action.providerMessageId.slice(0, 18))}` : ''}</span></li>`;
    }).join('') : '<li class="empty-list">No external actions queued.</li>';
  }

  function updateTime() {
    renderWili();
    updateTrialTime();
    if (lastStateReceived) text('#last-update', `State received ${time(lastStateReceived)}${online ? '' : ' · connection interrupted'}`);
    if (!online && lastStateReceived) snapshot?.sensors.forEach((sensor) => {
      const card = document.getElementById(sensor.source);
      if (card && finite(sensor.ageMs)) {
        const age = sensor.ageMs + Date.now() - lastStateReceived;
        text('.sensor-age', age < 1000 ? `${Math.round(age)} ms` : `${(age / 1000).toFixed(1)} s`, card);
      }
    });
    const incident = snapshot?.incident;
    const deadline = !terminal(incident) && incident ? incident.phase === 'CONFIRMING' ? incident.checkinDeadline : incident.progressDeadline : null;
    if (!finite(deadline)) {
      text('#deadline', '—');
      text('#deadline-detail', terminal(incident) ? 'Incident closed' : 'No deadline scheduled');
      return;
    }
    const seconds = Math.ceil((deadline - (Date.now() + clockOffset)) / 1000);
    text('#deadline', seconds > 0 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : 'Deadline reached');
    text('#deadline-detail', `${incident.phase === 'CONFIRMING' ? 'Check-in' : incident.phase === 'HELP_REQUESTED' ? 'Responder acceptance' : 'Responder progress'} · ${time(deadline)}`);
  }

  function updateControls() {
    const ready = !!token && online && !!snapshot && !busy;
    const incident = snapshot?.incident;
    const active = !!incident && !terminal(incident);
    const responder = $('#responder').value;
    const isOwner = active && incident.ownerId === responder;
    $('#trigger').disabled = !ready || active;
    $('#manual-help').disabled = !ready || (active && incident.phase !== 'CONFIRMING');
    $('#manual-help').textContent = incident?.phase === 'CONFIRMING' ? 'Request help now' : 'Request help manually';
    $('#cancel').disabled = !ready || incident?.phase !== 'CONFIRMING';
    $('#responder').disabled = !snapshot?.responders.length || busy;
    $('#accept').disabled = !ready || !responder || incident?.phase !== 'HELP_REQUESTED';
    $('#depart').disabled = !ready || !isOwner || incident?.phase !== 'ACKNOWLEDGED';
    $('#arrive').disabled = !ready || !isOwner || incident?.phase !== 'RESPONDER_EN_ROUTE';
    $('#decline').disabled = !ready || !isOwner;
    $('#resolve').disabled = !ready || !isOwner || incident?.phase !== 'ON_SCENE' || $('#outcome-input').value.trim().length < 5;
    $('#calibrate').disabled = !ready || !snapshot.sensors.some((sensor) => sensor.connected && sensor.fresh);
    $('#reset').disabled = !ready;
    const recording = ['recording', 'stopping'].includes(snapshot?.trial?.status);
    $('#trial-start').disabled = !ready || trialBusy || active || recording || !$('#trial-label').value.trim() || $('#trial-label').value.trim().length > 80;
    $('#trial-stop').disabled = !ready || trialBusy || snapshot?.trial?.status !== 'recording';
    $('#trial-download').disabled = !token || trialBusy || snapshot?.trial?.status !== 'stopped';
    $('#trial-label').disabled = trialBusy || recording;
    $('#trial-scenario').disabled = trialBusy || recording;
    updateRehearsalControls();
    updatePatientControls();
  }

  function setToken(value, local = false) {
    token = value.trim();
    text('#auth-summary', token ? local ? 'Local operator token available' : 'Operator token entered' : 'Pairing token required');
    $('#auth-details').open = !token;
    $('#token').value = '';
    $('#copy-token').disabled = !token;
    patientRequest?.controller.abort(); patientRequest = null; patientContextKey = null; patientRecord = null;
    clearPatientAnswer(); renderPatientRecord(); ensurePatientRecord();
    updateControls();
  }

  async function command(payload) {
    if (!token || busy) return;
    const message = payload.type === 'calibrate' ? '#calibration-message' : '#command-message';
    busy = true;
    updateControls();
    text(message, payload.type === 'calibrate' ? 'Requesting standing calibration…' : 'Applying command…');
    $(message).classList.remove('error');
    try {
      const response = await fetch('/api/commands', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(payload), signal: AbortSignal.timeout(12000) });
      const result = await response.json();
      if (!response.ok || result.error) throw new Error(result.error || `Command failed (${response.status})`);
      text(message, payload.type === 'calibrate'
        ? 'Calibration recorded for available still sensors. Check both sensor cards below.'
        : 'Command accepted by the controller.');
      if (payload.type === 'resolve' || payload.type === 'reset') $('#outcome-input').value = '';
      await loadState().catch(() => {});
    } catch (error) {
      $(message).classList.add('error');
      text(message, error.name === 'TimeoutError'
        ? payload.type === 'calibrate' ? 'Request timed out. Check sensor calibration before retrying.' : 'Request timed out. Check incident state before repeating the command.'
        : error.message || 'Command failed.');
    } finally {
      busy = false;
      updateControls();
    }
  }

  function renderTrial() {
    const trial = snapshot?.trial;
    const labels = { recording: 'RECORDING', stopping: 'STOPPING', stopped: 'STOPPED', error: 'ERROR' };
    text('#trial-status', trial ? labels[trial.status] || trial.status : 'NO RECORDING');
    $('#trial-status').className = `badge ${trial?.status === 'recording' ? 'good' : trial?.status === 'stopping' ? 'warning' : trial?.status === 'error' ? 'bad' : ''}`;
    const chestCount = trial?.sampleCounts?.['chest-phone'], waistCount = trial?.sampleCounts?.['waist-airpod'];
    text('#trial-chest-count', finite(chestCount) ? chestCount.toLocaleString() : '—');
    text('#trial-waist-count', finite(waistCount) ? waistCount.toLocaleString() : '—');
    text('#trial-summary', trial ? `${trial.label} · ${trial.scenario} · ID ${trial.id}${trial.reason ? ` · ${trial.reason}` : ''}` : 'No trial has been recorded.');
    updateTrialTime();
  }

  function updateTrialTime() {
    const trial = snapshot?.trial;
    if (!trial || !finite(trial.startedAt)) { text('#trial-elapsed', '—'); return; }
    const end = finite(trial.endedAt) ? trial.endedAt : online && ['recording', 'stopping'].includes(trial.status) ? Date.now() + clockOffset : snapshot.serverTime;
    const seconds = Math.max(0, Math.floor((end - trial.startedAt) / 1000));
    text('#trial-elapsed', `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}${!online && !finite(trial.endedAt) ? ' · last state offline' : ''}`);
  }

  async function trialRequest(operation) {
    if (!token || trialBusy) return;
    const label = $('#trial-label').value.trim();
    if (operation === 'start' && (!label || label.length > 80)) return;
    trialBusy = true;
    updateControls();
    $('#trial-message').classList.remove('error');
    text('#trial-message', operation === 'start' ? 'Starting recording…' : 'Stopping recording…');
    try {
      const body = operation === 'start' ? { label, scenario: $('#trial-scenario').value } : {};
      const response = await fetch(`/api/trials/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
      const result = await response.json();
      if (!response.ok || result.error) throw new Error(result.error || `Recording request failed (${response.status})`);
      if (snapshot) snapshot.trial = result;
      renderTrial();
      text('#trial-message', operation === 'start' ? 'Waist/legacy recording started. FREE-WILi capture is separate.' : 'Stop requested. Monitoring and incident response remain active.');
      await loadState().catch(() => {});
    } catch (error) {
      $('#trial-message').classList.add('error');
      text('#trial-message', error.name === 'TimeoutError' ? 'Request timed out. Check recording status before repeating it.' : error.message || 'Recording request failed.');
    } finally {
      trialBusy = false;
      updateControls();
    }
  }

  async function downloadTrial() {
    const trial = snapshot?.trial;
    if (!token || trialBusy || trial?.status !== 'stopped') return;
    trialBusy = true;
    updateControls();
    $('#trial-message').classList.remove('error');
    text('#trial-message', 'Preparing recorded JSONL…');
    try {
      const response = await fetch(`/api/trials/${encodeURIComponent(trial.id)}/download`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(30000) });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || `Download unavailable (${response.status})`);
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = `lifeline-trial-${String(trial.id).replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      text('#trial-message', 'JSONL download requested. Scenario remains an operator-supplied label.');
    } catch (error) {
      $('#trial-message').classList.add('error');
      text('#trial-message', error.message || 'Could not download this recording.');
    } finally {
      trialBusy = false;
      updateControls();
    }
  }

  async function loadState() {
    const response = await fetch('/api/state', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`State unavailable (${response.status})`);
    acceptSnapshot(await response.json());
  }

  function connect() {
    clearTimeout(reconnectTimer);
    const current = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/live`);
    socket = current;
    current.addEventListener('open', () => { if (socket !== current) return; retryDelay = 1000; setConnection(true); });
    current.addEventListener('message', (event) => {
      if (socket !== current) return;
      try { acceptSnapshot(JSON.parse(event.data)); } catch { setConnection(false, 'The server sent an unreadable state update. Reconnecting…'); current.close(); }
    });
    current.addEventListener('close', () => {
      if (socket !== current) return;
      setConnection(false, 'Live connection interrupted. Displayed values are the last received state; reconnecting automatically.');
      reconnectTimer = setTimeout(() => { loadState().catch(() => {}); connect(); }, retryDelay);
      retryDelay = Math.min(retryDelay * 1.6, 10000);
    });
    current.addEventListener('error', () => current.close());
  }

  $('#token-form').addEventListener('submit', (event) => { event.preventDefault(); setToken($('#token').value); });
  $('#copy-token').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(token); $('#copy-token').textContent = 'Pairing token copied'; }
    catch { $('#copy-token').textContent = 'Clipboard unavailable — use localhost /api/setup'; }
  });
  $('#responder').addEventListener('change', updateControls);
  $('#outcome-input').addEventListener('input', updateControls);
  $('#trial-label').addEventListener('input', updateControls);
  $('#patient-refresh').addEventListener('click', () => loadPatientRecord(true));
  $('#patient-scope').addEventListener('change', (event) => { patientScope = event.target.value; void loadPatientRecord(); });
  $('#patient-question').addEventListener('input', updatePatientControls);
  $('#patient-question-form').addEventListener('submit', (event) => { event.preventDefault(); askPatientQuestion(); });
  $('#care-brief').addEventListener('click', downloadCareBrief);
  $('#rehearsal-question').addEventListener('input', updateRehearsalControls);
  $('#rehearsal-form').addEventListener('submit', (event) => { event.preventDefault(); rehearseQuestion(); });
  $('#trial-start').addEventListener('click', () => trialRequest('start'));
  $('#trial-stop').addEventListener('click', () => trialRequest('stop'));
  $('#trial-download').addEventListener('click', downloadTrial);
  $('#trigger').addEventListener('click', () => command({ type: 'trigger', kind: 'synthetic', summary: 'Operator-triggered development simulation. No physical fall evidence asserted.' }));
  $('#manual-help').addEventListener('click', () => command({ type: 'trigger', kind: 'manual', summary: 'Operator-simulated manual request for help.' }));
  $('#cancel').addEventListener('click', () => { const incident = snapshot?.incident; if (incident) command({ type: 'cancel', incidentId: incident.id, checkinId: incident.checkinId }); });
  for (const type of ['accept', 'depart', 'arrive', 'decline']) $(`#${type}`).addEventListener('click', () => { const incident = snapshot?.incident; if (incident) command({ type, incidentId: incident.id, responderId: $('#responder').value }); });
  $('#resolve').addEventListener('click', () => { const incident = snapshot?.incident; if (incident) command({ type: 'resolve', incidentId: incident.id, responderId: $('#responder').value, outcome: $('#outcome-input').value.trim() }); });
  $('#calibrate').addEventListener('click', () => command({ type: 'calibrate' }));
  $('#reset').addEventListener('click', () => command({ type: 'reset' }));
  window.addEventListener('pagehide', () => { clearTimeout(reconnectTimer); socket = null; contextRequest?.controller.abort(); contextRequest = null; patientRequest?.controller.abort(); patientRequest = null; patientQuestionRequest?.controller.abort(); patientQuestionRequest = null; });

  $('#phase-list').innerHTML = phases.map(([, label]) => `<li>${label}</li>`).join('');
  updateControls();
  fetch('/api/setup', { cache: 'no-store', signal: AbortSignal.timeout(8000) }).then(async (response) => {
    if (!response.ok) { $('#auth-details').open = true; return; }
    const setup = await response.json();
    if (typeof setup.token === 'string') setToken(setup.token, true);
    if (Number.isInteger(setup.port) && setup.port > 0 && setup.port <= 65535) {
      nativeSetup = { port: setup.port, addresses: Array.isArray(setup.addresses) ? setup.addresses.filter((address) => typeof address === 'string') : [], lanEnabled: typeof setup.lanEnabled === 'boolean' ? setup.lanEnabled : null };
      const address = nativeSetup.addresses[0];
      const binding = nativeSetup.lanEnabled === true ? 'LAN binding enabled; device reachability unverified.' : nativeSetup.lanEnabled === false ? 'Local-only binding; enable LAN binding before connecting the phone.' : 'Listener binding not reported.';
      text('#native-connection', `Mac bridge: 127.0.0.1:${setup.port}. ${binding} ${address ? `Phone host candidate: ${address}:${setup.port}.` : 'No external network address reported.'}`);
      renderReadiness();
    }
  }).catch(() => { $('#auth-details').open = true; });
  loadState().catch(() => setConnection(false, 'Waiting for the LIFELINE server. No sensor data has been received.'));
  connect();
  setInterval(updateTime, 500);
})();
