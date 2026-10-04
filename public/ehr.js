import { medicationStatus, groupMedicationRecords, careHighlights, measurementDate, vitalKey } from './care-summary.js';
export { medicationStatus, groupMedicationRecords, careHighlights } from './care-summary.js';
/** Display the calendar date written in the source, without shifting its day. */
export function historicalVitalDate(value) {
  if (measurementDate(value) === null) return 'Date unavailable';
  return new Date(`${value.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}
export function vitalMetrics(records = []) {
  const metrics = new Map();
  for (const record of records.filter(record => record.section === 'vitals')) {
    const key = vitalKey(record), [name, unit] = JSON.parse(key);
    if (!metrics.has(key)) metrics.set(key, { key, name, unit, count: 0 });
    metrics.get(key).count++;
  }
  return [...metrics.values()];
}
/** Every plotted value is an actual dated, numeric source row with the exact same unit. */
export function vitalSeries(records = [], key) {
  return records.filter(record => record.section === 'vitals' && vitalKey(record) === key).flatMap(record => {
    const raw = record.fields?.value, unit = record.fields?.unit, date = record.fields?.date;
    const numeric = typeof raw === 'number' ? Number.isFinite(raw) : typeof raw === 'string'
      && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw.trim());
    const at = measurementDate(date);
    if (!numeric || at === null || typeof unit !== 'string' || !unit.trim()) return [];
    return [{ id: record.id, name: record.fields.name || record.label, value: Number(raw), unit, date, at }];
  }).sort((a, b) => a.at - b.at);
}

/** Presentation only. The complete, unmodified answer remains available in source detail. */
export function answerPresentation(answer, snapshot) {
  const cited = new Map(), lines = [];
  for (const original of String(answer).split('\n')) {
    let line = original.trim(); if (!line) continue;
    if (/^(AI-composed answer from synthetic patient records:|Recorded source fields \(template fallback\):|Known source facts:|Clinical snapshot revision:|Fields not returned are unknown\. Synthetic records|These records do not establish current clinical status\.)/.test(line)) continue;
    const record = (snapshot?.records || []).find(row => line.endsWith(`[${row.id}]`));
    if (record) {
      cited.set(record.id, record); line = line.slice(0, -(record.id.length + 2)).trim();
      // Only transport/recording metadata moves into the disclosure. Clinical
      // values, status, and historical vital measurement dates remain literal.
      line = line.replace(/; (?:sourceName|sourceUpdatedAt|syncedAt|recordedDate): [^;]*/g, '');
      if (record.section !== 'vitals') line = line.replace(/; (?:startDate|endDate): [^;]*/g, '');
      line = line.replace(/^allergies: /, 'Allergy: ').replace(/^medications: /, 'Medication: ')
        .replace(/^conditions: /, 'Condition: ').replace(/^medicationAdministrations: /, 'Administration: ')
        .replace(/^medicationDispenses: /, 'Dispense: ')
        .replace(/; dosage: /g, ' · recorded dose: ').replace(/; frequency: /g, ' · frequency: ')
        .replace(/; reaction: /g, ' · reaction: ').replace(/; verificationStatus: /g, ' · verification: ')
        .replace(/; status: /g, ' · status: ').replace(/; severity: /g, ' · severity: ');
    }
    lines.push(line);
  }
  return { lines, records: [...cited.values()], original: String(answer) };
}

/** The protected EHR API already removes audit envelopes. Never reinterpret a human quote as JSON. */
export function careEventPresentation(event) {
  const names = { CHECKIN_REPLY: 'Patient check-in reply', WEARER_REPORT: 'Patient report', RESPONDER_REPORT: 'Responder report',
    CONVERSATION_MESSAGE: 'Conversation message', CONVERSATION_PLAYBACK: 'Wearable playback', ANSWER_QUEUED: 'Record answer queued',
    HANDOFF_PREPARED: 'Handoff prepared', HEALTH_CONTEXT_BOUND: 'Clinical context saved' };
  const type = typeof event?.type === 'string' ? event.type : '';
  const actors = { 'photon-imessage': 'Photon message', 'freewili': 'FREE-WILi', 'freewili-local-speech': 'WILi microphone / local speech recognition',
    'ios-on-device-speech': 'Historical iPhone speech', finchnode: 'FinchNode record source', 'context-composer': 'Grounded context composer',
    'development-operator': 'Operator' };
  const actor = typeof event?.actor === 'string' ? event.actor : '';
  return {
    title: Object.hasOwn(names, type) ? names[type] : type.replaceAll('_', ' ') || 'Recorded event',
    detail: typeof event?.detail === 'string' ? event.detail : 'Event detail unavailable.',
    actor: actor === 'simulated-dispatch' || actor.startsWith('simulated-dispatch:') ? 'Local dispatch'
      : Object.hasOwn(actors, actor) ? actors[actor] : actor,
  };
}

if (typeof document !== 'undefined' && document.getElementById('ehr-main')) initializeEhr();

function initializeEhr() {
  const $ = id => document.getElementById(`ehr-${id}`);
  const views = ['overview', 'medications', 'vitals', 'care', 'sources'];
  let token = '', authEpoch = 0, scopeEpoch = 0, incidentId = null, payload = null, online = false;
  let loadRequest = null, questionRequest = null, refreshRequest = null, exportRequest = null;
  let vitalSelection = '', medicationFilter = 'all', search = '';
  const rendered = new Map();
  const value = v => v === null || v === undefined || v === '' ? 'Not returned; unknown' : Array.isArray(v) ? v.join('; ')
    : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const date = v => typeof v === 'number' && Number.isFinite(v) ? new Date(v).toLocaleString()
    : typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleString() : 'Date unknown';
  const e = (tag, text = '', className = '') => {
    const element = document.createElement(tag); if (className) element.className = className;
    if (text !== '') element.textContent = String(text); return element;
  };
  const add = (parent, tag, text, className) => { const child = e(tag, text, className); parent.append(child); return child; };
  const setText = (id, text) => { const element = $(id); if (element && element.textContent !== String(text)) element.textContent = String(text); };
  const setConnection = text => { setText('connection', text); const wrap = $('connection')?.parentElement; if (wrap) wrap.dataset.state = text === 'Connected' ? 'online' : /Unavailable|Pairing/.test(text) ? 'offline' : ''; };
  const stateLabel = state => ({ provider_accepted: 'Provider accepted; delivery unverified', unknown: 'Delivery outcome unknown',
    simulated: 'Local delivery', policy_refusal: 'Policy refusal', ai: 'Validated AI composition', degraded: 'Source template fallback' })[state] || value(state);
  const contextKey = () => `${authEpoch}:${scopeEpoch}:${incidentId || 'current'}:${payload?.context?.revision || ''}`;
  const record = () => payload?.patientRecord || null;
  const query = () => incidentId ? `?incidentId=${encodeURIComponent(incidentId)}` : '';
  function badge(text, state) { const b = e('span', text, 'ehr-badge'); if (state) b.dataset.state = state; return b; }
  function fields(entries) {
    const dl = e('dl', '', 'ehr-fields ehr-detail-grid');
    for (const [label, v] of entries) { const row = add(dl, 'div', ''); add(row, 'dt', label); add(row, 'dd', value(v)); }
    return dl;
  }
  function table(columns, rows) {
    const wrap = e('div', '', 'ehr-table-wrap'), result = add(wrap, 'table', '', 'ehr-table ehr-data-table');
    const tr = add(add(result, 'thead', ''), 'tr', '');
    for (const column of columns) { const th = add(tr, 'th', column.label); th.scope = 'col'; }
    const body = add(result, 'tbody', '');
    for (const row of rows) {
      const tr = add(body, 'tr', '');
      for (const column of columns) { const cell = add(tr, 'td', ''), v = column.get(row); cell.append(v instanceof Node ? v : document.createTextNode(value(v))); }
    }
    return wrap;
  }
  function section(id, key, build) {
    const element = $(id); if (!element || rendered.get(id) === key) return;
    const expanded = new Set([...element.querySelectorAll('details[data-source-id][open]')].map(item => item.dataset.sourceId));
    const fragment = document.createDocumentFragment(); build(fragment); element.replaceChildren(fragment);
    for (const detail of element.querySelectorAll('details[data-source-id]')) if (expanded.has(detail.dataset.sourceId)) detail.open = true;
    rendered.set(id, key);
  }
  function source(record, summary = 'View source') {
    const detail = e('details', '', 'ehr-source-record source-record'); detail.dataset.sourceId = record.id;
    add(detail, 'summary', summary);
    detail.append(fields([['Record ID', record.id], ['Section', record.section], ['Resource type', record.resourceType],
      ['Source', record.sourceName || record.source], ['Source record ID', record.sourceRecordId],
      ['Source updated', record.sourceUpdatedAt], ['Synced', record.syncedAt]]));
    for (const code of record.codes || []) add(detail, 'p', `Code: ${value(code.display)} · ${value(code.code)} · ${value(code.system)}`);
    for (const item of record.details || []) add(detail, 'p', `${item.label}: ${value(item.value)}`);
    return detail;
  }
  function availability(fragment, category, complete = false) {
    const status = record()?.categories?.[category];
    if (!complete && status?.state === 'available') return;
    add(fragment, 'p', complete ? `${status?.state || 'unavailable'} · ${status?.detail || 'Source category unavailable.'}`
      : status?.state === 'partial' ? 'Some records are unavailable.' : status?.state === 'empty' ? 'No records returned; absence is unknown.'
        : 'Records unavailable.', 'ehr-category-state');
  }
  function empty(fragment, text = 'No source rows returned. Missing data does not establish absence.') { add(fragment, 'p', text, 'ehr-empty empty-list'); }
  function options(select, choices, selected) {
    if (!select) return;
    const signature = JSON.stringify(choices);
    if (select.dataset.options !== signature) {
      if (document.activeElement === select) return;
      select.replaceChildren(...choices.map(([id, label]) => { const option = e('option', label); option.value = id; return option; }));
      select.dataset.options = signature;
    }
    if ([...select.options].some(option => option.value === selected)) select.value = selected;
  }
  function controls() {
    const ready = Boolean(token && online && payload), busy = Boolean(refreshRequest || loadRequest);
    if ($('refresh')) $('refresh').disabled = !ready || busy || Boolean(questionRequest);
    if ($('export')) $('export').disabled = !ready || Boolean(exportRequest);
    if ($('context')) $('context').disabled = !ready || Boolean(refreshRequest);
    if ($('care-incident-list')) $('care-incident-list').disabled = !ready || Boolean(refreshRequest);
    const question = $('question')?.value.trim() || '';
    if ($('question-submit')) $('question-submit').disabled = !ready || !record()?.revision || busy || Boolean(questionRequest) || !question || question.length > 2000;
  }
  function clearAnswer(message = '') {
    questionRequest?.controller.abort(); questionRequest = null;
    setText('answer', ''); setText('answer-meta', ''); setText('question-status', message);
  }
  function cancelRequests() {
    for (const request of [loadRequest, questionRequest, refreshRequest, exportRequest]) request?.controller.abort();
    loadRequest = questionRequest = refreshRequest = exportRequest = null;
  }
  function authenticationError() {
    token = ''; authEpoch++; cancelRequests(); payload = null; online = false; rendered.clear();
    if ($('token-panel')) $('token-panel').hidden = false;
    setConnection('Pairing required'); setText('status', 'Operator token rejected. Enter a current token.');
    clearAnswer(); render();
  }
  async function jsonResponse(response) {
    if (response.status === 401) { authenticationError(); throw new Error('Operator token rejected.'); }
    const body = await response.json();
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error.slice(0, 240) : `Request unavailable (${response.status}).`);
    return body;
  }
  function request(method, url, controller, requestToken, body) {
    return fetch(url, { method, cache: 'no-store', headers: { Authorization: `Bearer ${requestToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
  }
  async function load(force = false) {
    if (!token || (loadRequest && !force)) return;
    loadRequest?.controller.abort();
    const pending = { controller: new AbortController(), token, authEpoch, scopeEpoch, incidentId };
    loadRequest = pending; controls();
    const current = () => loadRequest === pending && token === pending.token && authEpoch === pending.authEpoch && scopeEpoch === pending.scopeEpoch;
    try {
      const response = await request('GET', `/api/ehr${query()}`, pending.controller, pending.token);
      if (!current()) return;
      const next = await jsonResponse(response); if (!current()) return;
      if (next.schemaVersion !== 1 || !next.context || next.context.incidentId !== pending.incidentId
        || !['current', 'incident'].includes(next.context.scope) || !next.care || !Array.isArray(next.care.incidents)) throw new Error('EHR response is unavailable or has a mismatched context.');
      const oldRevision = payload?.context?.revision;
      if (oldRevision !== undefined && oldRevision !== next.context.revision) {
        clearAnswer('The clinical revision changed. Ask again using the displayed record.');
        refreshRequest?.controller.abort(); refreshRequest = null;
      }
      payload = next; online = true;
      setConnection('Connected'); setText('status', `Updated ${date(next.generatedAt)} · protected read-only view`);
      if ($('token-panel')) $('token-panel').hidden = true;
      render();
    } catch (error) {
      if (!current() || pending.controller.signal.aborted) return;
      online = false; setConnection('Unavailable');
      setText('status', error?.name === 'TimeoutError' ? 'The record request timed out. Try again.' : error.message || 'The record request failed.');
    } finally { if (loadRequest === pending) loadRequest = null; controls(); }
  }
  function setScope(id) {
    if (id === incidentId) return;
    incidentId = id || null; scopeEpoch++; cancelRequests(); payload = null; online = false; rendered.clear();
    clearAnswer('Clinical context changed. Questions use the newly selected snapshot.'); render(); void load(true);
  }
  function setToken(next) {
    if (!next || next.length > 500 || /[\s\x00-\x1f\x7f]/.test(next)) { setText('status', 'Enter a valid operator token.'); return; }
    authEpoch++; cancelRequests(); token = next; payload = null; online = false; rendered.clear();
    if ($('token')) $('token').value = '';
    clearAnswer(); setConnection('Connecting'); render(); void load(true);
  }
  function render() {
    const patient = record(), rows = patient?.records || [], demographic = rows.find(row => row.section === 'demographics');
    const patientName = demographic?.fields?.name || 'Patient identity unavailable';
    setText('patient-name', patientName); setText('avatar', typeof patientName === 'string' ? patientName.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() : '?');
    setText('patient-meta', patient ? [demographic?.fields?.birthDate ? `Born ${demographic.fields.birthDate}` : 'Birth date unavailable', demographic?.fields?.gender].filter(Boolean).join(' · ') : 'Protected clinical record not loaded.');
    const scope = incidentId ? `Saved incident record · ${incidentId}` : 'Current hospital record';
    const choices = [['', 'Current hospital context'], ...(payload?.care?.incidents || []).map(i => [i.id, `${i.id} · ${i.phase}${i.dispatchMode === 'simulated' ? ' · local dispatch' : ''}`])];
    if (incidentId && !choices.some(([id]) => id === incidentId)) choices.push([incidentId, `${incidentId} · selected incident`]);
    options($('context'), choices, incidentId || '');
    options($('care-incident-list'), [['', 'Latest local activity · current hospital context'], ...choices.slice(1)], incidentId || '');
    const clinicalKey = `${incidentId || 'current'}:${patient?.revision || 'none'}`;
    section('record-summary', `${clinicalKey}:${patient?.fetchedAt}`, fragment => {
      add(fragment, 'p', patient ? `${scope} · snapshot dated ${patient.dataAsOf ? date(patient.dataAsOf) : 'unknown'}${['unavailable', 'revoked', 'partial'].includes(patient.status) ? ` · ${patient.status}` : ''}`
        : token ? `${scope} · record unavailable.` : 'Operator token required.', 'ehr-snapshot-line');
    });
    for (const category of ['allergies', 'conditions']) section(category, clinicalKey, fragment => {
      availability(fragment, category); const matching = rows.filter(row => row.section === category);
      if (!matching.length) return empty(fragment);
      for (const row of matching) {
        const card = add(fragment, 'article', '', 'ehr-context-record'), heading = add(card, 'div', '', 'ehr-context-record-heading');
        add(heading, 'h3', row.fields?.[category === 'allergies' ? 'substance' : 'name'] || row.label);
        const status = typeof row.fields?.status === 'string' ? row.fields.status.trim() : '';
        if (status.toLowerCase() !== 'active') add(heading, 'span', status || 'Status unknown', 'ehr-record-status');
        const facts = category === 'allergies'
          ? [['Reaction', 'reaction'], ['Severity', 'severity'], ['Verification', 'verificationStatus']]
          : [['Onset', 'onsetDate'], ['Severity', 'severity'], ['Verification', 'verificationStatus']];
        const returned = facts.filter(([, field]) => row.fields?.[field] !== null && row.fields?.[field] !== undefined && row.fields?.[field] !== '');
        add(card, 'p', returned.length ? returned.map(([label, field]) => `${label}: ${value(row.fields[field])}`).join(' · ')
          : category === 'allergies' ? 'Reaction details unavailable.' : 'Additional details unavailable.', 'ehr-context-record-facts');
        const detail = source(row); detail.append(fieldsList(row.fields)); card.append(detail);
      }
    });
    const highlights = careHighlights(patient);
    section('active-medications', clinicalKey, fragment => {
      availability(fragment, 'medications');
      if (!highlights.medications.length) return empty(fragment, patient ? 'No explicitly active prescription returned. Other medication history is in Medications.' : 'Medication records unavailable.');
      for (const group of highlights.medications) fragment.append(medicationCard(group, 'current', true));
    });
    section('latest-vitals', clinicalKey, fragment => {
      availability(fragment, 'vitals');
      if (!highlights.vitals.length) return empty(fragment, 'No dated historical measurements returned. Current vital signs are unavailable.');
      const grid = add(fragment, 'div', '', 'ehr-vital-facts');
      for (const row of highlights.vitals) {
        const card = add(grid, 'article', '', 'ehr-vital-fact');
        add(card, 'h3', row.fields.name || row.label);
        const literal = `${value(row.fields.value)}${row.fields.unit ? ` ${row.fields.unit}` : ' · unit unavailable'}`;
        add(card, 'p', literal, `ehr-vital-value${literal.length > 28 ? ' ehr-vital-value-long' : ''}`);
        add(card, 'p', historicalVitalDate(row.fields.date), 'ehr-fact-date');
        const detail = source(row); detail.append(fieldsList(row.fields)); card.append(detail);
      }
    });
    renderMedications(); renderVitals(); renderCare(); renderSources(); controls();
  }
  function medicationSources(group) {
    const detail = e('details', '', 'ehr-source-record ehr-medication-sources'); detail.dataset.sourceId = `medication:${group.key}`;
    add(detail, 'summary', 'View source');
    const kinds = [['currentPrescriptions', 'Active prescriptions'], ['historicalPrescriptions', 'Historical prescriptions'],
      ['unknownPrescriptions', 'Prescriptions with unknown status'], ['administrations', 'Recorded administration events'], ['dispenses', 'Recorded dispense events']];
    for (const [key, title] of kinds) {
      if (!group[key].length) continue;
      add(detail, 'h4', title);
      for (const row of group[key]) {
        const recordDetail = source(row, `${row.fields?.name || row.label} · ${row.fields?.status || 'status unknown'}`);
        recordDetail.append(fieldsList(row.fields)); detail.append(recordDetail);
      }
    }
    return detail;
  }
  function medicationCard(group, state, overview = false) {
    const card = e('article', '', 'ehr-context-record ehr-medication-card'), heading = add(card, 'div', '', 'ehr-context-record-heading');
    const prescriptions = state === 'current' ? group.currentPrescriptions : state === 'historical' ? group.historicalPrescriptions : group.unknownPrescriptions;
    const display = prescriptions[0] || group.records[0];
    add(heading, 'h3', display?.fields?.name || group.name);
    add(heading, 'span', state === 'current' ? 'Active prescription' : state === 'historical' ? 'Historical prescription' : 'Current status unknown', 'ehr-record-status');
    if (prescriptions.length) {
      // Never borrow a prior regimen or administration dose for an active row.
      const instructions = [...new Set(prescriptions.map(row => {
        const dosage = row.fields?.dosage, frequency = row.fields?.frequency;
        return [dosage ? `Recorded dose: ${value(dosage)}` : 'Dose unavailable',
          frequency && !String(dosage || '').toLowerCase().includes(String(frequency).toLowerCase()) ? `Frequency: ${value(frequency)}` : null].filter(Boolean).join(' · ');
      }))];
      for (const instruction of instructions) add(card, 'p', instruction, 'ehr-context-record-facts');
    } else add(card, 'p', 'Administration or dispense history only; no active prescription returned.', 'ehr-context-record-facts');
    if (!overview && state === 'historical') {
      const dates = prescriptions.map(row => [row.fields?.startDate, row.fields?.endDate].filter(Boolean).join(' → ')).filter(Boolean);
      if (dates.length) add(card, 'p', [...new Set(dates)].join('; '), 'ehr-fact-date');
    }
    card.append(medicationSources(group)); return card;
  }
  function renderMedications() {
    const patient = record(), rows = patient?.records || [];
    const groups = groupMedicationRecords(rows).filter(group => !search || group.records.some(row => JSON.stringify([row.label, row.fields, row.id, row.sourceName]).toLowerCase().includes(search)));
    section('medications-list', `${incidentId}:${patient?.revision}:${medicationFilter}:${search}`, fragment => {
      availability(fragment, 'medications');
      let shown = 0;
      for (const [state, title, key] of [['current', 'Active prescriptions', 'currentPrescriptions'], ['historical', 'Historical prescriptions', 'historicalPrescriptions'], ['unknown', 'Other medication records', 'unknownPrescriptions']]) {
        if (medicationFilter !== 'all' && medicationFilter !== state) continue;
        const matching = groups.filter(group => {
          if (medicationFilter === 'all') return state === (group.currentPrescriptions.length ? 'current' : group.historicalPrescriptions.length ? 'historical' : 'unknown');
          return group[key].length || (state === 'unknown' && !group.currentPrescriptions.length && !group.historicalPrescriptions.length);
        });
        if (!matching.length) continue;
        add(fragment, 'h3', title, 'ehr-medication-section-title');
        for (const group of matching) { fragment.append(medicationCard(group, state)); shown++; }
      }
      if (!shown) empty(fragment, rows.some(row => row.category === 'medications') ? 'No medication groups match these filters.' : 'Medication records unavailable.');
    });
  }
  function fieldsList(recordFields) { return fields(Object.entries(recordFields || {}).map(([key, v]) => [key, v])); }
  function renderVitals() {
    const patient = record(), rows = patient?.records || [], metrics = vitalMetrics(rows);
    if (!metrics.some(metric => metric.key === vitalSelection)) vitalSelection = metrics[0]?.key || '';
    options($('vital-metric'), metrics.length ? metrics.map(metric => [metric.key, `${metric.name} · ${metric.unit || 'unit unknown'}`]) : [['', 'No vital records returned']], vitalSelection);
    if ($('vital-metric')) $('vital-metric').disabled = !metrics.length;
    const matching = rows.filter(row => row.section === 'vitals' && vitalKey(row) === vitalSelection);
    const points = vitalSeries(rows, vitalSelection), latest = points.at(-1);
    setText('vital-summary', latest ? `Latest historical measurement: ${latest.value} ${latest.unit} · ${historicalVitalDate(latest.date)}.`
      : matching.length ? 'Returned values, units or measurement dates cannot form a comparable numeric series. The literal records remain below.' : 'No historical vital records returned. Current vital signs are unavailable.');
    section('vital-chart', `${incidentId}:${patient?.revision}:${vitalSelection}`, fragment => {
      if (!points.length) return empty(fragment, 'No dated numeric measurements with a known common unit to plot.');
      const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 640 240'); svg.classList.add('ehr-vital-svg'); svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', `${points.length} historical source measurement${points.length === 1 ? '' : 's'} for ${latest.name}; ${latest.unit}. Not current vital signs.`);
      const addSvg = (tag, attrs, text) => { const child = document.createElementNS(NS, tag); for (const [key, v] of Object.entries(attrs)) child.setAttribute(key, String(v)); if (text) child.textContent = text; svg.append(child); return child; };
      const firstAt = points[0].at, lastAt = latest.at, min = Math.min(...points.map(p => p.value)), max = Math.max(...points.map(p => p.value));
      const x = p => firstAt === lastAt ? 335 : 65 + (p.at - firstAt) / (lastAt - firstAt) * 545;
      const y = p => min === max ? 110 : 185 - (p.value - min) / (max - min) * 150;
      addSvg('line', { x1: 65, y1: 185, x2: 610, y2: 185, stroke: 'currentColor', opacity: '.2' });
      if (points.length > 1 && firstAt !== lastAt) addSvg('polyline', { points: points.map(p => `${x(p)},${y(p)}`).join(' '), fill: 'none', stroke: 'currentColor', 'stroke-width': 2 });
      for (const point of points) {
        const dot = addSvg('circle', { cx: x(point), cy: y(point), r: 4, fill: 'currentColor' });
        const title = document.createElementNS(NS, 'title'); title.textContent = `${point.value} ${point.unit} · ${historicalVitalDate(point.date)} [${point.id}]`; dot.append(title);
      }
      addSvg('text', { x: 8, y: min === max ? 114 : 40, fill: 'currentColor', 'font-size': 12 }, `${max} ${latest.unit}`);
      if (min !== max) addSvg('text', { x: 8, y: 188, fill: 'currentColor', 'font-size': 12 }, `${min} ${latest.unit}`);
      addSvg('text', { x: 65, y: 215, fill: 'currentColor', 'font-size': 11 }, historicalVitalDate(points[0].date));
      if (firstAt !== lastAt) addSvg('text', { x: 610, y: 215, 'text-anchor': 'end', fill: 'currentColor', 'font-size': 11 }, historicalVitalDate(latest.date));
      fragment.append(svg); add(fragment, 'p', points.length === 1 ? 'One historical source point. No trend is inferred.' : 'Lines connect returned historical measurements; no normal-range or clinical trend assessment is made.');
    });
    section('vital-history', `${incidentId}:${patient?.revision}:${vitalSelection}`, fragment => {
      availability(fragment, 'vitals'); if (!matching.length) return empty(fragment);
      fragment.append(table([{ label: 'Metric', get: row => row.fields.name || row.label }, { label: 'Recorded value', get: row => row.fields.value },
        { label: 'Unit', get: row => row.fields.unit }, { label: 'Measurement date', get: row => historicalVitalDate(row.fields.date) }, { label: 'Source', get: source }], matching));
    });
  }
  const sourceLabel = source => ({ 'photon-imessage': 'Photon message', 'freewili-local-speech': 'WILi microphone / local speech recognition',
    'ios-on-device-speech': 'Historical iPhone on-device speech', 'simulated-dispatch': 'Local responder', agent: 'LIFELINE reply', 'daily-checkin': 'Daily check-in' })[source] || value(source);
  const evidenceKinds = { synthetic: 'manual check-in', manual: 'manual request' };
  function renderCare() {
    const care = payload?.care, selected = care?.selectedIncident, i = selected?.incident;
    setText('care-identity', `${care?.subject?.name || 'Patient name unavailable'} · care activity`);
    setText('incident-handoff', i?.handoff || 'No prepared handoff is available for the selected local activity.');
    setText('handoff-meta', i ? `${i.id} · ${i.phase}${i.dispatchMode === 'simulated' ? ' · local dispatch' : ''}\n${i.handoffGeneration ? stateLabel(i.handoffGeneration) : 'Provenance unavailable'} · Saved clinical revision ${selected.clinicalRevision || 'unavailable'}${selected.clinicalRevision && selected.clinicalRevision !== record()?.revision ? '\nThis saved handoff uses a different clinical snapshot from the currently displayed hospital record.' : ''}` : 'No incident selected.');
    section('incident-evidence', JSON.stringify([i?.id, i?.evidence]), fragment => {
      const measurements = i?.evidence?.measurements;
      if (!measurements) return empty(fragment, 'No captured fall measurements are available for this incident. Manually started check-ins and help requests do not establish a measured fall.');
      const measured = (number, unit) => typeof number === 'number' && Number.isFinite(number) ? `${number} ${unit}` : 'Not captured; unknown';
      add(fragment, 'p', 'FREE-WILi chest acceleration + waist AirPod motion. Provisional incident evidence; not clinical vitals.');
      fragment.append(fields([['Detector', measurements.detector], ['Assessed at', date(measurements.assessedAt)],
        ['Peak WILi acceleration', measured(measurements.peakAccelerationG, 'g')], ['Waist linear acceleration', measured(measurements.waistLinearG, 'g')],
        ['Waist angular speed', measured(measurements.waistAngularSpeedRadS, 'rad/s')], ['Low movement window', measured(measurements.quietDurationMs, 'ms')],
        ['Low movement samples', measurements.quietSampleCount], ['Body/waist separation', measured(measurements.separationMs, 'ms')],
        ['Capture clock', measurements.captureClock === 'host-receipt' ? 'Host receipt; not board capture time' : measurements.captureClock],
        ['Body timing uncertainty', measured(measurements.bodyTimingUncertaintyMs, 'ms')], ['Waist timing uncertainty', measured(measurements.waistTimingUncertaintyMs, 'ms')]]));
    });
    section('care-messages', JSON.stringify(care || null), fragment => {
      if (!care) return empty(fragment, 'Protected local care activity is not loaded.');
      add(fragment, 'h3', 'Patient-reported updates');
      add(fragment, 'p', 'Reported by the patient, separate from hospital records. Impact compares reported answers; it is not a clinical severity score.');
      const reports = care.wellbeing?.reports || [];
      if (!reports.length) empty(fragment, 'No structured patient updates yet.');
      for (const report of [...reports].reverse()) {
        const article = add(fragment, 'article', '', 'ehr-care-message');
        add(article, 'h3', report.symptom);
        article.append(fields([['Updated', date(report.updatedAt)], ['Duration', report.duration || 'Not reported'],
          ['Daily impact', report.impact || 'Not reported'], ['Change', report.trend]]));
        const details = add(article, 'details', ''); add(details, 'summary', 'Patient words and sources');
        for (const evidence of report.evidence || []) add(details, 'p', `${date(evidence.at)} · ${sourceLabel(evidence.source)}: “${evidence.text}”`);
        for (const followup of report.followups || []) {
          add(article, 'p', `${followup.author}: ${followup.question}`);
          add(article, 'p', followup.answer ? `Patient: ${followup.answer} · ${date(followup.answeredAt)}` : 'Awaiting patient answer');
        }
        const form = add(article, 'form', '');
        const member = add(form, 'select', ''); member.setAttribute('aria-label', 'Care team member');
        for (const person of payload?.careTeam || []) { const option = add(member, 'option', person.name); option.value = person.id; }
        const input = add(form, 'input', ''); input.placeholder = 'Ask the patient a follow-up'; input.maxLength = 500; input.required = true;
        input.setAttribute('aria-label', 'Follow-up question');
        const button = add(form, 'button', 'Send follow-up'); button.type = 'submit';
        const status = add(form, 'p', ''); status.setAttribute('role', 'status');
        const requestId = crypto.randomUUID(); let submitted = false;
        form.addEventListener('submit', async event => {
          event.preventDefault(); if (submitted || !token) return;
          submitted = true; button.disabled = true;
          try {
            await jsonResponse(await request('POST', '/api/wellbeing/followup', new AbortController(), token,
              { reportId: report.id, responderId: member.value, question: input.value.trim(), requestId }));
            status.textContent = 'Queued for the patient’s iMessage. Delivery will appear in the conversation below.';
          } catch (error) { status.textContent = error.message; }
        });
      }
      add(fragment, 'h3', 'Everyday conversation · most recent 40 messages');
      const today = new Date().toDateString();
      const daily = (care.wellbeing?.messages || []).filter(item => Number.isFinite(item?.at) && new Date(item.at).toDateString() === today);
      if (!daily.length) empty(fragment, 'No everyday messages today. Silence is not an emergency determination.');
      const message = (item, speaker) => {
        const article = add(fragment, 'article', '', 'ehr-care-message'); article.dataset.speaker = item.speaker; article.dataset.source = item.source;
        add(article, 'p', `${speaker} · ${date(item.at)}`, 'ehr-message-heading'); add(article, 'p', item.text, 'ehr-message-text');
        add(article, 'p', `${sourceLabel(item.source)} · ${stateLabel(item.delivery)}${item.generation ? ` · ${stateLabel(item.generation)}` : ''}`, 'ehr-message-meta');
        if (item.recordContext) add(article, 'p', `Clinical reply: ${item.recordContext.subjectName || 'subject name unavailable'} (FinchNode record; not personal EHR) · revision ${item.recordContext.revision || 'unavailable'} · cited source IDs ${item.recordContext.sourceRecordIds?.join(', ') || 'none'}${item.recordContext.truncated ? ' · source lines omitted' : ''}`, 'ehr-message-meta');
      };
      for (const item of daily) message(item, item.speaker === 'wearer' ? care.subject.name : 'LIFELINE');
      if (!i) return;
      add(fragment, 'h3', `${i.id} · local incident activity`);
      add(fragment, 'p', `${i.phase} · ${i.ownerId ? `Accepted owner: ${selected.ownerName || 'name unavailable'}` : 'No responder has accepted ownership.'}${i.dispatchMode === 'simulated' ? ' · responder ownership, travel, arrival and outcome were recorded by local dispatch.' : ''}`);
      add(fragment, 'p', `Evidence (${Object.hasOwn(evidenceKinds, i.evidence?.kind) ? evidenceKinds[i.evidence.kind] : i.evidence?.kind || 'unknown'}): ${i.evidence?.summary || 'not returned'}. Possible-incident observations are not diagnoses.`);
      if (i.outcome) add(fragment, 'p', `Recorded outcome: ${i.outcome}`);
      for (const item of selected.conversation || []) message(item, item.source === 'simulated-dispatch' ? `Local responder ${item.speakerName}` : item.speakerName);
      const timeline = add(fragment, 'ol', '', 'ehr-timeline');
      for (const event of selected.timeline || []) {
        const presentation = careEventPresentation(event), row = add(timeline, 'li', '');
        add(row, 'strong', `${presentation.title} · ${date(event.at)}`); add(row, 'p', presentation.detail);
        if (presentation.actor) add(row, 'p', `Recorded source: ${presentation.actor}`, 'ehr-message-meta');
      }
    });
  }
  function renderSources() {
    const patient = record();
    section('source-meta', `${incidentId}:${patient?.revision}:${patient?.fetchedAt}`, fragment => {
      add(fragment, 'p', payload?.sources?.hospital || 'FinchNode (read-only); no personal EHR connection.');
      add(fragment, 'p', payload?.sources?.observations || 'Local LIFELINE care activity is separate from hospital records.');
      if (!patient) return empty(fragment, 'No patient source snapshot is loaded.');
      fragment.append(fields([['Subject', patient.subject], ['Revision', patient.revision], ['Data as of', patient.dataAsOf], ['Local fetch', date(patient.fetchedAt)],
        ['Consent status', patient.consent?.status], ['Consent expiry', patient.consent?.expiresAt], ['Consent revoked', patient.consent?.revokedAt],
        ['Sync status', patient.sync?.status], ['Prepared', patient.sync?.preparedAt], ['Last successful sync', patient.sync?.lastSuccessfulSyncAt]]));
      add(fragment, 'p', 'Consent, synchronization and category outcomes are as reported by FinchNode. They do not establish live permission, freshness or completeness.');
      for (const [category, state] of Object.entries(patient.categories || {})) add(fragment, 'p', `${category}: ${state.state} · ${state.recordIds?.length || 0} returned rows · ${state.detail}`);
      for (const warning of patient.warnings || []) add(fragment, 'p', `${warning.code}: ${warning.message}`, 'ehr-source-warning');
      for (const item of patient.sync?.sources || []) fragment.append(fields(Object.entries(item)));
    });
    section('source-records', `${incidentId}:${patient?.revision}`, fragment => {
      if (!patient?.records?.length) return empty(fragment);
      for (const row of patient.records) { const detail = source(row, `${row.fields?.name || row.fields?.substance || row.label} · ${row.resourceType || row.section}`); detail.append(fieldsList(row.fields)); fragment.append(detail); }
    });
  }
  async function refresh() {
    if (!token || !payload || refreshRequest) return;
    clearAnswer('Refreshing the current source. Incident snapshots remain immutable.');
    const pending = { token, authEpoch, scopeEpoch, controller: new AbortController() }; refreshRequest = pending; controls();
    const current = () => refreshRequest === pending && token === pending.token && authEpoch === pending.authEpoch && scopeEpoch === pending.scopeEpoch;
    try {
      const response = await request('POST', '/api/patient-record/refresh', pending.controller, pending.token);
      if (!current()) return; await jsonResponse(response); if (!current()) return;
      await load(true);
      if (current()) setText('question-status', incidentId ? 'Current hospital context refreshed. This incident still uses its original immutable snapshot.' : 'Current hospital context refreshed.');
    } catch (error) { if (current() && !pending.controller.signal.aborted) setText('status', error.message || 'Refresh failed.'); }
    finally { if (refreshRequest === pending) refreshRequest = null; controls(); }
  }
  async function ask() {
    const question = $('question')?.value.trim() || '', revision = record()?.revision;
    if (!token || !revision || !question || question.length > 2000 || questionRequest || refreshRequest) return;
    const pending = { token, key: contextKey(), revision, controller: new AbortController() }; questionRequest = pending; controls();
    setText('question-status', 'Preparing a source-grounded answer…'); setText('answer', ''); setText('answer-meta', '');
    const current = () => questionRequest === pending && token === pending.token && contextKey() === pending.key;
    try {
      const response = await request('POST', '/api/patient-record/question', pending.controller, pending.token,
        { question, revision, ...(incidentId ? { incidentId } : {}) });
      if (!current()) return; const result = await jsonResponse(response); if (!current()) return;
      if (typeof result.answer !== 'string' || result.revision !== revision || !['ai', 'degraded', 'policy_refusal'].includes(result.generation)) throw new Error('Answer context or provenance could not be verified.');
      const presentation = answerPresentation(result.answer, record()), answer = $('answer');
      answer.replaceChildren();
      for (const line of presentation.lines) add(answer, 'p', line, 'ehr-answer-fact');
      const detail = add(answer, 'details', '', 'ehr-answer-sources ehr-source-record');
      add(detail, 'summary', 'View sources & complete answer');
      add(detail, 'p', `${stateLabel(result.generation)} · ${scopeText()} · revision ${revision}`, 'ehr-answer-provenance');
      for (const row of presentation.records) { const recordDetail = source(row, row.fields?.name || row.fields?.substance || row.label); recordDetail.append(fieldsList(row.fields)); detail.append(recordDetail); }
      add(detail, 'pre', presentation.original, 'ehr-original-answer');
      setText('answer-meta', result.generation === 'ai' ? 'AI-composed from source facts' : result.generation === 'degraded' ? 'Source facts · template fallback' : 'Medical advice boundary');
      setText('question-status', 'Answer ready.');
    } catch (error) { if (current() && !pending.controller.signal.aborted) setText('question-status', error.message || 'The answer is unavailable.'); }
    finally { if (questionRequest === pending) questionRequest = null; controls(); }
  }
  function scopeText() { return incidentId ? `immutable ${incidentId} snapshot` : 'current patient context'; }
  async function exportBrief() {
    if (!token || !payload || exportRequest) return;
    const pending = { token, key: contextKey(), controller: new AbortController() }; exportRequest = pending; controls();
    const current = () => exportRequest === pending && token === pending.token && contextKey() === pending.key;
    try {
      const response = await request('GET', `/api/ehr/brief${query()}`, pending.controller, pending.token);
      if (!current()) return;
      if (!response.ok) { await jsonResponse(response); return; }
      const blob = await response.blob(); if (!current()) return;
      const href = URL.createObjectURL(blob), a = e('a'); a.href = href; a.download = `lifeline-ehr-${incidentId || 'current'}-care-brief.json`;
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(href), 1000);
      setText('status', 'Care brief exported with hospital source records and local observations in separate sections.');
    } catch (error) { if (current() && !pending.controller.signal.aborted) setText('status', error.message || 'Export is unavailable.'); }
    finally { if (exportRequest === pending) exportRequest = null; controls(); }
  }
  function activateView(name, push = false) {
    const view = views.includes(name) ? name : 'overview';
    for (const button of document.querySelectorAll('[data-view]')) {
      const active = button.dataset.view === view; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
      button.classList.toggle('active', active);
    }
    for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== view;
    if (push && location.hash !== `#${view}`) history.pushState(null, '', `#${view}`);
  }
  const tabs = [...document.querySelectorAll('[data-view]')];
  for (const button of tabs) {
    button.addEventListener('click', () => activateView(button.dataset.view, true));
    button.addEventListener('keydown', event => {
      const index = tabs.indexOf(button), next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
      if (next === null) return; event.preventDefault(); tabs[next].focus(); activateView(tabs[next].dataset.view, true);
    });
  }
  window.addEventListener('hashchange', () => activateView(location.hash.slice(1)));
  window.addEventListener('popstate', () => activateView(location.hash.slice(1)));
  $('context')?.addEventListener('change', event => setScope(event.target.value));
  $('care-incident-list')?.addEventListener('change', event => setScope(event.target.value));
  for (const id of ['context', 'care-incident-list', 'vital-metric']) $(id)?.addEventListener('blur', () => render());
  $('medication-filter')?.addEventListener('change', event => { medicationFilter = event.target.value; renderMedications(); });
  $('record-search')?.addEventListener('input', event => { search = event.target.value.trim().toLowerCase(); renderMedications(); });
  $('vital-metric')?.addEventListener('change', event => { vitalSelection = event.target.value; renderVitals(); });
  $('question-form')?.addEventListener('submit', event => { event.preventDefault(); void ask(); });
  $('question')?.addEventListener('input', controls);
  $('refresh')?.addEventListener('click', () => { void refresh(); });
  $('export')?.addEventListener('click', () => { void exportBrief(); });
  $('token-form')?.addEventListener('submit', event => { event.preventDefault(); setToken($('token').value.trim()); });
  activateView(location.hash.slice(1)); controls();
  let poll = null;
  const startPolling = () => { if (poll === null) poll = setInterval(() => { if (!document.hidden && token && !refreshRequest) void load(); }, 8000); };
  startPolling();
  document.addEventListener('visibilitychange', () => { if (!document.hidden && token) void load(); });
  window.addEventListener('pagehide', () => { clearInterval(poll); poll = null; cancelRequests(); });
  window.addEventListener('pageshow', event => { if (event.persisted) { startPolling(); if (token) void load(true); } });
  const initialEpoch = authEpoch;
  fetch('/api/setup', { cache: 'no-store', signal: AbortSignal.timeout(8000) }).then(async response => {
    if (!response.ok) throw new Error('Manual pairing required.');
    const setup = await response.json(); if (authEpoch !== initialEpoch) return;
    if (typeof setup.token !== 'string' || !setup.token) throw new Error('Manual pairing required.'); setToken(setup.token);
  }).catch(() => {
    if (authEpoch !== initialEpoch) return;
    if ($('token-panel')) $('token-panel').hidden = false;
    setConnection('Pairing required'); setText('status', 'Enter the operator token to read this protected record.'); controls();
  });
}
