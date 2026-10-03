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
    updateControls();
  }

  function acceptSnapshot(value) {
    if (!value || !Array.isArray(value.sensors) || !Array.isArray(value.responders) || !Array.isArray(value.actions) || !Array.isArray(value.timeline)) throw new Error('Invalid server snapshot');
    snapshot = value;
    if (finite(value.serverTime)) clockOffset = value.serverTime - Date.now();
    lastStateReceived = Date.now();
    value.sensors.forEach(renderSensor);
    renderIncident();
    renderResponders();
    renderProviders();
    renderTimeline();
    renderActions();
    updateControls();
    updateTime();
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
    text('#handoff', incident?.handoff || 'A record-grounded handoff will appear here when it is available.');
    $('#outcome-panel').hidden = !incident?.outcome;
    text('#outcome', incident?.outcome || '');
    text('#outcome-source', incident?.outcome ? `Recorded by ${nameFor(incident.resolutionActor)} · ${time(incident.updatedAt)}` : '');
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
    $('#timeline').innerHTML = events.length ? events.map((event) => `<li class="event-item"><div class="event-head"><strong>${escaped(event.type.replaceAll('_', ' '))}</strong><time>${escaped(time(event.at))}</time></div><p>${escaped(event.detail)}</p><span class="event-actor">${escaped(nameFor(event.actor))}</span></li>`).join('') : '<li class="empty-list">Events will appear as the incident progresses.</li>';
  }

  function renderActions() {
    const actions = snapshot.actions.filter((action) => action.incidentId === snapshot.incident?.id).slice().sort((a, b) => b.createdAt - a.createdAt);
    text('#action-count', actions.length);
    $('#actions').innerHTML = actions.length ? actions.map((action) => {
      const [label, color] = actionLabels[action.status] || [action.status, ''];
      return `<li class="action-item"><div class="action-head"><strong>${escaped(action.type[0].toUpperCase() + action.type.slice(1))}${action.recipientId ? ` · ${escaped(nameFor(action.recipientId))}` : ''}</strong><span class="badge ${color}">${escaped(label)}</span></div><p>${escaped(action.providerResult || action.text || 'No provider result yet.')}</p><span class="action-meta">${escaped(time(action.createdAt))} · ${action.attempts} attempt${action.attempts === 1 ? '' : 's'}${action.providerMessageId ? ` · Message ${escaped(action.providerMessageId.slice(0, 18))}` : ''}</span></li>`;
    }).join('') : '<li class="empty-list">No external actions queued.</li>';
  }

  function updateTime() {
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
    $('#manual-help').disabled = !ready || active;
    $('#cancel').disabled = !ready || !active;
    $('#responder').disabled = !snapshot?.responders.length || busy;
    $('#accept').disabled = !ready || !responder || incident?.phase !== 'HELP_REQUESTED';
    $('#depart').disabled = !ready || !isOwner || incident?.phase !== 'ACKNOWLEDGED';
    $('#arrive').disabled = !ready || !isOwner || incident?.phase !== 'RESPONDER_EN_ROUTE';
    $('#decline').disabled = !ready || !isOwner;
    $('#resolve').disabled = !ready || !isOwner || incident?.phase !== 'ON_SCENE' || !$('#outcome-input').value.trim();
    $('#calibrate').disabled = !ready || !snapshot.sensors.some((sensor) => sensor.connected && sensor.fresh);
    $('#reset').disabled = !ready;
  }

  function setToken(value, local = false) {
    token = value.trim();
    text('#auth-summary', token ? local ? 'Local operator token available' : 'Operator token entered' : 'Pairing token required');
    $('#auth-details').open = !token;
    $('#token').value = '';
    $('#copy-token').disabled = !token;
    updateControls();
  }

  async function command(payload) {
    if (!token || busy) return;
    busy = true;
    updateControls();
    text('#command-message', 'Applying command…');
    $('#command-message').classList.remove('error');
    try {
      const response = await fetch('/api/commands', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(payload), signal: AbortSignal.timeout(12000) });
      const result = await response.json();
      if (!response.ok || result.error) throw new Error(result.error || `Command failed (${response.status})`);
      text('#command-message', 'Command accepted by the controller.');
      if (payload.type === 'resolve' || payload.type === 'reset') $('#outcome-input').value = '';
      await loadState().catch(() => {});
    } catch (error) {
      $('#command-message').classList.add('error');
      text('#command-message', error.name === 'TimeoutError' ? 'Request timed out. Check incident state before repeating the command.' : error.message || 'Command failed.');
    } finally {
      busy = false;
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
  $('#trigger').addEventListener('click', () => command({ type: 'trigger', kind: 'synthetic', summary: 'Operator-triggered development simulation. No physical fall evidence asserted.' }));
  $('#manual-help').addEventListener('click', () => command({ type: 'trigger', kind: 'manual', summary: 'Operator-simulated manual request for help.' }));
  $('#cancel').addEventListener('click', () => { const incident = snapshot?.incident; if (incident) command({ type: 'cancel', incidentId: incident.id, checkinId: incident.checkinId }); });
  for (const type of ['accept', 'depart', 'arrive', 'decline']) $(`#${type}`).addEventListener('click', () => { const incident = snapshot?.incident; if (incident) command({ type, incidentId: incident.id, responderId: $('#responder').value }); });
  $('#resolve').addEventListener('click', () => { const incident = snapshot?.incident; if (incident) command({ type: 'resolve', incidentId: incident.id, responderId: $('#responder').value, outcome: $('#outcome-input').value.trim() }); });
  $('#calibrate').addEventListener('click', () => command({ type: 'calibrate' }));
  $('#reset').addEventListener('click', () => command({ type: 'reset' }));
  window.addEventListener('pagehide', () => { clearTimeout(reconnectTimer); socket = null; });

  $('#phase-list').innerHTML = phases.map(([, label]) => `<li>${label}</li>`).join('');
  updateControls();
  fetch('/api/setup', { cache: 'no-store', signal: AbortSignal.timeout(8000) }).then(async (response) => { if (response.ok) { const setup = await response.json(); if (typeof setup.token === 'string') setToken(setup.token, true); const address = setup.addresses?.[0]; $('#native-connection').textContent = `Mac bridge: 127.0.0.1:${setup.port}. ${address ? `Phone host: ${address}:${setup.port}; enable LAN binding first.` : 'Phone access needs a reachable Mac network address.'}`; } else $('#auth-details').open = true; }).catch(() => { $('#auth-details').open = true; });
  loadState().catch(() => setConnection(false, 'Waiting for the LIFELINE server. No sensor data has been received.'));
  connect();
  setInterval(updateTime, 500);
})();
