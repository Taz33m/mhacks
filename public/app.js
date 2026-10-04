import { activeIncident, dashboardPresentation, retainWiliReading, workspaceView, motionPresentation, conditionPresentation, watchPreview, appendWiliTrace } from './dashboard-view.js';
import { careHighlights } from './care-summary.js';

(() => {
  'use strict';
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const workspaceLinks = [...document.querySelectorAll('.rail-link')];
  const viewNames = { motion: 'Motion', location: 'Location', status: 'Status', medical: 'Medical', conversation: 'Conversation', activity: 'Audit trail', connections: 'Connections', teaching: 'Teach LIFELINE', developer: 'Controls' };
  const viewIntros = { teaching: 'Record a movement. Label what happened. Build a measured dataset.', status: 'Their current condition. Their own words. Who is helping.', location: 'Shared position, room context and the way to reach them.', conversation: 'Private conversations, connected by one incident.',
    motion: 'Impact, movement and the signals behind an incident.', medical: 'Medications, conditions, allergies and the context that matters.',
    activity: 'Recorded events, message attempts, and outcomes.', connections: 'Hardware and services, with diagnostics on demand.', developer: 'Start. Speak. LIFELINE takes it from there.' };
  let developerEnabled = ['#developer', '#dev'].includes(location.hash);
  const updateWorkspaceNavigation = () => {
    const requested = workspaceView(location.hash);
    if (requested === 'developer') developerEnabled = true;
    const selectedView = requested === 'developer' && !developerEnabled ? 'motion' : requested;
    const selected = workspaceLinks.find(link => link.dataset.workspaceLink === selectedView) ?? workspaceLinks[0];
    for (const panel of document.querySelectorAll('[data-workspace-view]')) panel.hidden = panel.dataset.workspaceView !== selectedView;
    for (const link of workspaceLinks) {
      link.classList.toggle('rail-active', link === selected);
      if (link === selected) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    const breadcrumb = $('.workspace-breadcrumb strong');
    if (breadcrumb) breadcrumb.textContent = viewNames[selectedView];
    if ($('#workspace-title')) $('#workspace-title').textContent = viewNames[selectedView];
    if ($('#workspace-intro')) $('#workspace-intro').textContent = viewIntros[selectedView];
    if ($('#developer-link')) $('#developer-link').hidden = !developerEnabled;
    if (['conversation', 'activity', 'connections', 'developer'].includes(selectedView)) $('.rail-tools').open = true;
    if ($('#developer-toggle')) { $('#developer-toggle').setAttribute('aria-pressed', String(developerEnabled)); $('#developer-toggle').textContent = developerEnabled ? 'Hide developer tools' : 'Developer tools'; }
    document.body.dataset.activeView = selectedView;
  };
  window.addEventListener('hashchange', () => { updateWorkspaceNavigation(); window.scrollTo({ top: 0, behavior: 'instant' }); });
  updateWorkspaceNavigation();
  const phases = [
    ['DETECTED', 'Detected'],
    ['CONFIRMING', 'Check-in'], ['HELP_REQUESTED', 'Help requested'],
    ['ACKNOWLEDGED', 'Accepted'], ['RESPONDER_EN_ROUTE', 'En route'],
    ['ON_SCENE', 'On scene'], ['RESOLVED', 'Resolved'],
  ];
  const actionLabels = {
    queued: ['Queued', ''], attempting: ['Sending', 'warning'],
    provider_accepted: ['Provider accepted', 'good'], failed: ['Failed', 'bad'],
    unknown: ['Outcome unknown', 'warning'], cancelled: ['Cancelled', ''],
    simulated: ['Local delivery', 'warning'],
  };
  const generationLabels = {
    ai: ['AI GENERATED', 'good'], degraded: ['DEGRADED TEMPLATE', 'warning'],
    policy_refusal: ['POLICY REFUSAL', 'warning'],
  };
  const generationFor = (value) => typeof value === 'string' && Object.hasOwn(generationLabels, value) ? generationLabels[value] : ['PROVENANCE UNAVAILABLE', ''];
  let snapshot = null;
  const apartmentUI = { started: false, ready: false };
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
  let conversationSignature = null;
  let wellbeingSignature = null;
  let wellbeingBusy = false;
  let wellbeingBriefBusy = false;
  let wiliDisplaySample = null;
  let wiliTrace = { sessionId: null, points: [] };
  let locationInviteBusy = false;
  let contextRequest = null;
  let contextPreview = null;
  let patientRecord = null;
  let patientScope = 'incident';
  let patientRequest = null;
  let patientContextKey = null;
  let patientQuestionRequest = null;
  let briefBusy = false;
  let calibrationGuide = null;
  let calibrationTimer = null;

  const escaped = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const text = (selector, value, scope = document) => { $(selector, scope).textContent = value; };
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  const number = (value, digits = 0) => finite(value) ? value.toFixed(digits) : '—';
  const terminal = (incident) => incident && ['RESOLVED', 'CANCELLED_FALSE_ALARM'].includes(incident.phase);
  const simulatedIncident = (incident = snapshot?.incident) => incident?.dispatchMode === 'simulated';
  const time = (value) => {
    const at = finite(value) ? value : typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(at) ? new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : '—';
  };
  const simulatedActor = (id) => typeof id === 'string' && (id === 'simulated-dispatch' || id.startsWith('simulated-dispatch:'));
  const nameFor = (id) => {
    if (id === 'simulated-dispatch') return 'Local dispatch';
    if (id === 'development-operator') return 'Operator';
    if (typeof id === 'string' && id.startsWith('simulated-dispatch:')) {
      const responderId = id.slice('simulated-dispatch:'.length);
      return snapshot?.responders.find(person => person.id === responderId)?.name ?? 'Local responder';
    }
    return snapshot?.responders.find((person) => person.id === id)?.name ?? id ?? 'Unassigned';
  };
  const initials = (name) => String(name).split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase();
  const observationKey = (value = snapshot) => JSON.stringify(Array.isArray(value?.conversation)
    ? value.conversation.filter(message => message?.incidentId === value.incident?.id).map(({ id, text }) => [id, text]) : []);

  function setConnection(connected, detail) {
    online = connected;
    $('#connection').className = `connection ${connected ? 'online' : 'offline'}`;
    $('#connection').innerHTML = `<i></i>${connected ? 'System live' : 'Reconnecting'}`;
    $('#connection-error').hidden = connected || !detail;
    text('#connection-error', detail || '');
    snapshot?.sensors.forEach(renderSensor);
    renderWili();
    renderReadiness();
    renderDemoNextStep();
    renderCheckinAudio();
    renderWellbeing();
    renderLocation();
    renderDispatch();
    if (snapshot) renderIncident();
    syncCalibrationGuide();
    updateControls();
  }

  function acceptSnapshot(value) {
    if (!value || !Array.isArray(value.sensors) || !Array.isArray(value.responders) || !Array.isArray(value.actions) || !Array.isArray(value.timeline)) throw new Error('Invalid server snapshot');
    const previousIncident = snapshot?.incident;
    const previousObservations = observationKey();
    snapshot = value;
    syncContext(previousIncident, previousObservations);
    if (finite(value.serverTime)) clockOffset = value.serverTime - Date.now();
    lastStateReceived = Date.now();
    if (calibrationGuide?.stage === 'verifying' && calibrationGuide.commandAccepted) calibrationGuide.postCommandState = true;
    observeGuideCadence();
    syncCalibrationGuide();
    value.sensors.forEach(renderSensor);
    renderWili();
    renderIncident();
    renderReply();
    renderConversation();
    renderWellbeing();
    renderLocation();
    renderResponders();
    renderProviders();
    renderReadiness();
    renderDemoNextStep();
    renderTimeline();
    renderActions();
    renderQuestions();
    renderTrial();
    renderPolicy();
    renderDispatch();
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
    text('#policy-mode', policy.demoMode ? 'ACCELERATED TIMING' : 'CONFIGURED POLICY');
    $('#policy-mode').className = `badge ${policy.demoMode ? 'warning' : ''}`;
    text('#policy-detail', policy.demoMode
      ? `Check-in timeout accelerated from configurable policy value: ${seconds(policy.checkinMs)} for new check-ins vs ${seconds(policy.configuredCheckinMs)} configured. Existing incident deadlines are preserved.`
      : `New check-ins use the configured ${seconds(policy.checkinMs)} timeout.`);
  }

  function renderDispatch() {
    const dispatch = snapshot?.dispatch;
    const available = ['live', 'simulated'].includes(dispatch?.mode);
    $('#dispatch-banner').hidden = !available;
    if (!available) return;
    const simulated = dispatch.mode === 'simulated';
    text('#dispatch-mode', simulated ? 'LOCAL DISPATCH' : 'LIVE RESPONDER DISPATCH');
    $('#dispatch-mode').className = `badge ${simulated ? 'warning' : ''}`;
    text('#dispatch-detail', typeof dispatch.detail === 'string' ? dispatch.detail : 'Dispatch detail unavailable.');
    text('#dispatch-scope', simulated ? 'Responder progression runs locally. Patient iMessage and motion sources keep their actual connection status.' : 'Responder messages use the configured delivery connection.');
  }

  async function loadApartment() {
    if (apartmentUI.started || !$('#apartment-stage')) return;
    apartmentUI.started = true;
    const stage = $('#apartment-stage');
    let renderer;
    try {
      const THREE = await import('/vendor/location-engine.js');
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.15;
      renderer.domElement.setAttribute('aria-hidden', 'true');
      stage.prepend(renderer.domElement);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(42, 1, .05, 150);
      const controls = new THREE.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = .08;
      controls.screenSpacePanning = true;
      controls.minPolarAngle = .02;
      controls.maxPolarAngle = Math.PI * .48;
      const ambient = new THREE.HemisphereLight('#f5f8ff', '#b9ac94', 2.2);
      scene.add(ambient);
      const sun = new THREE.DirectionalLight('#fff3df', 3);
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.bias = -.0004;
      sun.shadow.normalBias = .02;
      scene.add(sun, sun.target);
      const model = (await new THREE.GLTFLoader().loadAsync('/media/location/apartment-111.glb')).scene;
      scene.add(model); model.updateMatrixWorld(true);
      let person = null;
      model.traverse(node => {
        if (node.userData.name === 'Person | 6 ft 3 in | lying on kitchen floor') person = node;
      });
      if (!person) throw new Error('Supplied person is missing from the apartment export');
      model.traverse(node => {
        if (!node.isMesh) return;
        node.castShadow = true; node.receiveShadow = true;
      });
      const bounds = new THREE.Box3().setFromObject(model);
      const center = bounds.getCenter(new THREE.Vector3());
      const size = bounds.getSize(new THREE.Vector3());
      const span = Math.max(size.x, size.z);
      const personBounds = new THREE.Box3().setFromObject(person);
      const personCenter = personBounds.getCenter(new THREE.Vector3());
      const target = new THREE.Vector3(center.x, .35, center.z);
      const personTarget = new THREE.Vector3(personCenter.x, personCenter.y, personCenter.z);
      sun.position.copy(target).add(new THREE.Vector3(span * .7, span * 1.4, span * .5));
      sun.target.position.copy(target);
      Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: .1, far: span * 6 });
      sun.shadow.camera.updateProjectionMatrix();
      controls.minDistance = 1.4; controls.maxDistance = span * 4;

      // The anchor is read from the person in the supplied scene, never from phone GPS.
      const pulse = new THREE.Group();
      pulse.position.set(personCenter.x, personBounds.min.y + .025, personCenter.z);
      scene.add(pulse);
      const rings = Array.from({ length: 3 }, () => {
        const ring = new THREE.Mesh(new THREE.RingGeometry(.93, 1, 96),
          new THREE.MeshBasicMaterial({ color: '#258bff', transparent: true, opacity: .5, depthWrite: false, side: THREE.DoubleSide }));
        ring.rotation.x = -Math.PI / 2; pulse.add(ring); return ring;
      });
      const glow = new THREE.Mesh(new THREE.CircleGeometry(.75, 80),
        new THREE.MeshBasicMaterial({ color: '#2f94ff', transparent: true, opacity: .11, depthWrite: false, side: THREE.DoubleSide }));
      glow.rotation.x = -Math.PI / 2; pulse.add(glow);
      const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
      let selectedView = 'apartment', fittedWidth = 0;
      const frame = view => {
        selectedView = view;
        // Consume any pending drag inertia before switching to a deterministic camera preset.
        controls.enableDamping = false; controls.update();
        const subject = view === 'person' ? personTarget : target;
        const topDistance = Math.max(size.z, size.x / camera.aspect) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.2 + size.y / 2;
        const distance = view === 'person' ? 5 : view === 'top' ? topDistance : span * Math.max(1.3, 1.3 / camera.aspect);
        const offset = view === 'top' ? new THREE.Vector3(0, 1, .0001) : view === 'person'
          ? new THREE.Vector3(0, 1.4, 1) : new THREE.Vector3(-.8, 1.3, 1.3);
        camera.position.copy(subject).add(offset.normalize().multiplyScalar(distance));
        controls.target.copy(subject); controls.update();
        controls.enableDamping = true;
        for (const button of stage.querySelectorAll('[data-apartment-view]')) button.setAttribute('aria-pressed', String(button.dataset.apartmentView === view));
      };
      const resize = () => {
        if (!stage.clientWidth || !stage.clientHeight) return;
        renderer.setSize(stage.clientWidth, stage.clientHeight);
        camera.aspect = stage.clientWidth / stage.clientHeight;
        camera.updateProjectionMatrix();
        if (!fittedWidth || Math.abs(fittedWidth - stage.clientWidth) > 50) { fittedWidth = stage.clientWidth; frame(selectedView); }
      };
      new ResizeObserver(resize).observe(stage);
      resize(); frame('apartment');
      for (const button of stage.querySelectorAll('[data-apartment-view]')) {
        button.addEventListener('click', () => frame(button.dataset.apartmentView)); button.disabled = false;
      }
      $('#apartment-load').hidden = true;
      apartmentUI.ready = true;
      renderer.setAnimationLoop(now => {
        if (document.hidden || $('#location').hidden || !stage.clientWidth) return;
        for (const [index, ring] of rings.entries()) {
          const progress = reducedMotion.matches ? index / 3 : (now / 2600 + index / 3) % 1;
          ring.scale.setScalar(.45 + progress * 1.9);
          ring.material.opacity = .55 * (1 - progress) ** 1.5;
        }
        controls.update(); renderer.render(scene, camera);
      });
      renderer.domElement.addEventListener('webglcontextlost', event => {
        event.preventDefault(); renderer.setAnimationLoop(null); apartmentUI.ready = false;
        $('#apartment-load').hidden = false;
        text('#apartment-load', '3D view paused. Reload to restore the apartment.');
      });
    } catch {
      renderer?.dispose();
      $('#apartment-load').hidden = false;
      text('#apartment-load', 'The apartment could not load. Reload to try again.');
      apartmentUI.started = false;
    }
  }

  if ($('#apartment-stage')) new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) void loadApartment();
  }).observe($('#apartment-stage'));

  function renderSensor(sensor) {
    const card = document.getElementById(sensor.source);
    if (!card) return;
    const state = !sensor.connected ? 'Disconnected' : !online ? 'Last received' : !sensor.fresh ? 'Stale signal' : 'Fresh signal';
    const badge = $('.sensor-status', card);
    badge.textContent = state;
    badge.className = `badge sensor-status ${online && sensor.connected && sensor.fresh ? 'good' : sensor.connected ? 'warning' : ''}`;
    text('.sensor-g', number(sensor.totalG, 2), card);
    text('.sensor-tilt', `Tilt ${number(sensor.tiltDegrees)}${finite(sensor.tiltDegrees) ? '°' : ''}`, card);
    text('.sensor-age', finite(sensor.ageMs) ? sensor.ageMs < 1000 ? `${Math.round(sensor.ageMs)} ms` : `${(sensor.ageMs / 1000).toFixed(1)} s` : 'No sample', card);
    text('.sensor-calibration', sensor.calibrated ? 'Calibrated' : 'Optional; tilt unknown', card);
    text('.sensor-alignment', finite(sensor.alignmentUncertaintyMs) ? `${Math.round(sensor.alignmentUncertaintyMs)} ms` : 'Unknown', card);
    text('.sensor-hz', finite(sensor.sampleHz) && sensor.sampleHz > 0 ? `${sensor.sampleHz.toFixed(1)} Hz` : '—', card);
    if (sensor.source === 'waist-airpod') {
      const angular = sensor.trace?.at(-1)?.angularSpeed;
      text('.waist-angular', online && sensor.fresh && finite(angular) ? `${angular.toFixed(2)} rad/s` : 'Not recorded', card);
      text('.waist-quaternion', online && sensor.fresh && Array.isArray(sensor.quaternion) && sensor.quaternion.length === 4 && sensor.quaternion.every(finite)
        ? sensor.quaternion.map(value => value.toFixed(3)).join(' / ') : 'Not recorded', card);
    }
    text('.sensor-identity', `Source: ${sensor.source}${sensor.sensorLocation ? ` · ${sensor.sensorLocation}` : ''} · ${sensor.sessionId ? `Session ${sensor.sessionId.slice(0, 8)}` : 'No session'}`, card);
    drawChart(card, sensor.trace || []);
  }

  function renderWili() {
    const window = snapshot?.incident?.evidence?.window;
    text('#motion-event-window', window?.summary || (!snapshot?.eventUnderstanding ? 'Event-window analysis is prepared; activation is pending the next backend restart.' : snapshot?.incident?.evidence?.kind === 'cross-body' && !['RESOLVED', 'CANCELLED_FALSE_ALARM'].includes(snapshot.incident.phase)
      ? 'Collecting motion around the incident. Assessment follows the four-second observation window.'
      : 'A new incident retains 2 seconds before and 4 seconds after onset. No missing measurements are filled in.'));
    const report = snapshot?.conversation?.findLast(message => message.speaker === 'wearer');
    text('#motion-patient-report', report ? `Patient report (${report.source}): “${report.text}”` : 'Patient report: not yet available.');
    const wili = snapshot?.wili;
    const at = Date.now();
    const elapsed = lastStateReceived ? Math.max(0, at - lastStateReceived) : 0;
    const receiptAge = finite(wili?.receivedAgeMs) && wili.receivedAgeMs >= 0 ? wili.receivedAgeMs + elapsed : null;
    // The last reading is presentation memory; acquisition and detector gates use the server state.
    wiliDisplaySample = retainWiliReading(wili, wiliDisplaySample, { now: at, elapsed, online });
    if (wili?.sessionId && wiliTrace.sessionId !== wili.sessionId) wiliTrace = { sessionId: wili.sessionId, points: [] };
    wiliTrace = appendWiliTrace(wiliTrace, wiliDisplaySample, at);
    drawChart($('#body-wili'), wiliTrace.points);
    const quiet = wiliDisplaySample && Math.abs(wiliDisplaySample.totalG - 1) < .15;
    const displayAge = wiliDisplaySample ? Math.max(0, at - wiliDisplaySample.receivedAt) : null;
    const status = !wiliDisplaySample || quiet || !online || !wili?.connected ? 'Idle' : 'Motion';
    text('#wili-status', status); $('#wili-status').className = 'badge';
    text('#wili-g', number(wiliDisplaySample?.totalG ?? 0, 2));
    ['x', 'y', 'z'].forEach((axis, index) => text(`#wili-${axis}`, `${number(wiliDisplaySample?.accelerationG?.[index] ?? 0, 3)} g`));
    text('#wili-sample-detail', displayAge !== null ? `Last measured reading · ${displayAge < 1000 ? `${Math.round(displayAge)} ms` : `${Math.floor(displayAge / 1000)} s`} ago`
      : 'Idle display · 0 until the first motion report.');
    text('#wili-age', receiptAge !== null ? `${Math.round(receiptAge)} ms` : 'No sample');
    text('#wili-freshness', !wili?.connected ? 'Unavailable' : !online ? 'Last state' : receiptAge === null ? 'No sample' : wili.fresh ? 'Fresh' : 'Not fresh');
    text('#wili-detector-inputs', detectorReadiness().ready ? 'Ready' : 'Not ready');
    const receiptTiming = wili?.captureClock === 'host-receipt';
    const sparse = online && wili?.connected && receiptAge !== null && receiptAge < 2000 && receiptTiming
      && finite(wili.sampleHz) && wili.sampleHz > 0 && wili.sampleHz <= 2;
    text('#wili-report-note', sparse ? 'Idle between motion reports. The last measured reading stays visible.'
      : 'Readings update as WILi sends motion reports.');
    $('#wili-report-note').className = `field-note wili-report-note${sparse ? ' sparse' : ''}`;
    text('#wili-timing-label', receiptTiming ? 'Gateway receipt age' : 'Capture age');
    text('#wili-capture-age', finite(wili?.captureAgeMs) ? `${Math.round(wili.captureAgeMs + elapsed)} ms` : 'Unknown');
    text('#wili-alignment-label', receiptTiming ? 'Gateway clock ±' : 'Capture clock ±');
    text('#wili-alignment', finite(wili?.alignmentUncertaintyMs) ? `${Math.round(wili.alignmentUncertaintyMs)} ms` : 'Unknown');
    text('#wili-hz', `${number(finite(wili?.sampleHz) ? wili.sampleHz : 0, 1)} Hz`);
    text('#wili-range', finite(wili?.fullScaleG) ? `±${wili.fullScaleG} g` : 'Unknown');
    text('#wili-quality', wili?.quality || 'Unknown');
    text('#wili-identity', `Source: body-wili · ${wili?.sessionId ? `Session ${wili.sessionId}` : 'No session'} · ${wili?.captureClock || 'Capture clock not reported'}`);
    text('#wili-detail', `${wili?.saturated === true ? 'Saturation reported. ' : ''}${receiptTiming ? 'Stock OG uses gateway receipt timing; sensor capture time and transport latency are not measured. ' : ''}Provisional detection requires correlated waist movement and subsequent quiet. Telemetry quality does not establish accuracy. Tilt and angular rate are unavailable on WILi.`);
  }

  function detectorReadiness() {
    const body = snapshot?.wili, waist = snapshot?.sensors.find(sensor => sensor.source === 'waist-airpod');
    const aligned = value => finite(value) && value >= 0 && value <= 100;
    const bodyReady = body?.connected && body.fresh && body.usable && body.quality === 'measured' && body.saturated === false
      && !!body.sessionId && aligned(body.alignmentUncertaintyMs)
      && ['device-monotonic', 'host-receipt'].includes(body.captureClock) && finite(body.totalG)
      && finite(body.fullScaleG) && (body.fullScaleG > 2 || (body.captureClock === 'host-receipt' && body.fullScaleG === 2));
    const waistReady = waist?.connected && waist.fresh && !!waist.sessionId
      && finite(waist.totalG) && ['Left', 'Right'].includes(waist.sensorLocation) && aligned(waist.alignmentUncertaintyMs);
    const ready = !!(online && bodyReady && waistReady);
    const detail = !online ? 'Live state disconnected; last telemetry cannot establish readiness.'
      : !bodyReady ? 'Waiting for usable FREE-WILi measurements and clock alignment.'
        : !waistReady ? 'Waiting for a fresh waist AirPod stream with clock alignment.'
          : 'Both streams pass current telemetry gates. Monitoring for primary impact, correlated waist movement/rotation and continuous waist quiet.';
    return { ready, detail };
  }

  function guideLiveState() {
    const waist = snapshot?.sensors.find(sensor => sensor.source === 'waist-airpod');
    const wili = snapshot?.wili;
    const elapsed = lastStateReceived ? Math.max(0, Date.now() - lastStateReceived) : Infinity;
    const fresh = !!(online && waist?.connected && waist.fresh && finite(waist.ageMs) && waist.ageMs + elapsed < 500);
    const waistReady = fresh && !!waist.sessionId && ['Left', 'Right'].includes(waist.sensorLocation) && finite(waist.sampleHz) && waist.sampleHz > 0;
    return { waist, wili, fresh, ready: !!(token && online && wili?.connected && waistReady) };
  }

  function guideIdentityError() {
    const guide = calibrationGuide;
    const { waist, wili, fresh } = guideLiveState();
    if (!online) return 'Live connection interrupted. Reconnect, then begin the standing-still step again.';
    if (!waist?.connected) return 'The waist AirPod disconnected. Reconnect the reporting AirPod and retry.';
    if (waist.sessionId !== guide.identity.sessionId || waist.sensorLocation !== guide.identity.sensorLocation) return 'The reporting AirPod or motion session changed. Check its waist placement and begin again.';
    if (!fresh) return 'Waist measurements stopped being fresh. Restore the stream in the Mac bridge, then retry.';
    if (!wili?.connected || wili.sessionId !== guide.wiliSession) return 'FREE-WILi disconnected or changed session. Reconnect and retry.';
    return null;
  }

  function failCalibrationGuide(message) {
    const guide = calibrationGuide;
    if (!guide) return;
    guide.errorStage = guide.stage;
    guide.stage = 'error';
    guide.error = message;
    clearTimeout(guide.requestTimeout);
    guide.request?.abort();
    clearInterval(calibrationTimer); calibrationTimer = null;
    renderCalibrationGuide();
  }

  function closeCalibrationGuide() {
    const guide = calibrationGuide;
    calibrationGuide = null;
    clearInterval(calibrationTimer); calibrationTimer = null;
    clearTimeout(guide?.requestTimeout);
    guide?.request?.abort();
    if ($('#calibration-guide').open) $('#calibration-guide').close();
    if (['requesting', 'verifying'].includes(guide?.stage)) text('#calibration-message', 'Guide closed during the baseline request. Check the waist sensor’s calibration status before retrying.');
    updateControls();
  }

  function openCalibrationGuide() {
    if (calibrationGuide || busy) return;
    calibrationGuide = { stage: 'placement', identity: null, error: '', results: [] };
    $('#calibration-guide').showModal();
    calibrationTimer = setInterval(syncCalibrationGuide, 250);
    renderCalibrationGuide();
    $('#calibration-close').focus();
    updateControls();
  }

  function beginGuideStillStep() {
    if (!calibrationGuide || busy || !guideLiveState().ready) return;
    const { waist, wili } = guideLiveState();
    calibrationGuide.stage = 'still';
    calibrationGuide.identity = { sessionId: waist.sessionId, sensorLocation: waist.sensorLocation };
    calibrationGuide.error = '';
    calibrationGuide.wiliSession = wili.sessionId;
    calibrationGuide.baselineVerified = false;
    calibrationGuide.deadline = performance.now() + 3000;
    calibrationGuide.results = [];
    if (!calibrationTimer) calibrationTimer = setInterval(syncCalibrationGuide, 250);
    renderCalibrationGuide();
  }

  async function submitGuideCalibration(guide) {
    if (calibrationGuide !== guide || busy) return;
    const identityError = guideIdentityError();
    if (identityError) { failCalibrationGuide(identityError); return; }
    guide.stage = 'requesting';
    guide.request = new AbortController();
    guide.requestTimeout = setTimeout(() => {
      if (calibrationGuide === guide) failCalibrationGuide('The baseline request timed out. Its outcome is unconfirmed; check the waist sensor card before retrying.');
    }, 12000);
    busy = true; updateControls(); renderCalibrationGuide();
    try {
      const response = await fetch('/api/commands', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ type: 'calibrate', expectedSessionId: guide.identity.sessionId, expectedSensorLocation: guide.identity.sensorLocation }),
        signal: guide.request.signal,
      });
      const result = await response.json();
      if (calibrationGuide !== guide || guide.stage === 'error') return;
      if (!response.ok || result.error) throw new Error(result.error || `Baseline request failed (${response.status}).`);
      if (!Array.isArray(result.calibratedSources) || !result.calibratedSources.includes('waist-airpod')) throw new Error('The server did not confirm a new waist baseline. Keep standing still and retry; the updated calibration endpoint is required.');
      guide.stage = 'verifying'; guide.commandAccepted = true; guide.postCommandState = false;
      renderCalibrationGuide();
      const stateResponse = await fetch('/api/state', { cache: 'no-store', signal: guide.request.signal });
      if (!stateResponse.ok) throw new Error(`Could not verify the baseline (${stateResponse.status}). Check the waist sensor card before retrying.`);
      const value = await stateResponse.json();
      if (calibrationGuide !== guide || guide.stage === 'error') return;
      acceptSnapshot(value);
      if (guide.stage === 'verifying') throw new Error('The request was accepted, but a fresh waist baseline was not verified. Stand still and retry.');
    } catch (error) {
      if (calibrationGuide === guide && guide.stage !== 'error') failCalibrationGuide(error.message || 'Baseline request failed. Restore the waist stream and retry.');
    } finally {
      clearTimeout(guide.requestTimeout);
      busy = false;
      updateControls();
      renderCalibrationGuide();
    }
  }

  function observeGuideCadence() {
    const guide = calibrationGuide;
    if (guide?.stage !== 'movement' || guideIdentityError()) return;
    const row = guide.results[0];
    const { waist, wili, fresh } = guideLiveState();
    for (const [key, value, usable] of [['waist', waist?.sampleHz, fresh], ['wili', wili?.sampleHz, online && wili?.connected && wili.fresh]]) {
      if (!usable || !finite(value) || value <= 0) continue;
      row[key].min = row[key].min === null ? value : Math.min(row[key].min, value);
      row[key].max = row[key].max === null ? value : Math.max(row[key].max, value);
    }
    for (const point of waist.trace || []) {
      if (!finite(point.at) || !finite(point.totalG) || point.at <= guide.motionAfterAt) continue;
      guide.motionTimes.add(point.at);
      if (Math.abs(point.totalG - 1) >= .15 || (finite(point.angularSpeed) && point.angularSpeed >= .35)) guide.movementTimes.add(point.at);
    }
    if (online && wili?.connected && wili.fresh && finite(wili.totalG)) guide.wiliObserved = true;
  }

  function beginGuideMovement() {
    const guide = calibrationGuide;
    if (!guide || busy) return;
    const identityError = guideIdentityError();
    if (identityError) { failCalibrationGuide(identityError); return; }
    const { waist } = guideLiveState();
    if (!guide.baselineVerified || !waist.calibrated) { failCalibrationGuide('The waist baseline is no longer available. Start calibration again.'); return; }
    guide.stage = 'movement'; guide.deadline = performance.now() + 3000;
    guide.error = ''; guide.errorStage = null;
    guide.motionAfterAt = Math.max(-Infinity, ...(waist.trace || []).map(point => point.at).filter(finite));
    guide.motionTimes = new Set();
    guide.movementTimes = new Set(); guide.wiliObserved = false;
    guide.results = [{ label: 'Walking step', waist: { min: null, max: null }, wili: { min: null, max: null } }];
    renderCalibrationGuide();
  }

  function syncCalibrationGuide() {
    const guide = calibrationGuide;
    if (!guide) return;
    if (['still', 'requesting', 'verifying', 'calibrated', 'movement'].includes(guide.stage)) {
      const identityError = guideIdentityError();
      if (identityError) { failCalibrationGuide(identityError); return; }
      if (guide.stage === 'still' && performance.now() >= guide.deadline) { void submitGuideCalibration(guide); return; }
      if (guide.stage === 'verifying' && guide.commandAccepted && guide.postCommandState && guideLiveState().waist.calibrated) {
        guide.stage = 'calibrated';
        guide.deadline = performance.now() + 800;
        guide.baselineVerified = true;
        text('#calibration-message', `New standing tilt baseline verified for the same ${guide.identity.sensorLocation} waist AirPod session. FREE-WILi orientation was not calibrated.`);
        $('#calibration-message').classList.remove('error');
      }
      if (guide.stage === 'calibrated' && performance.now() >= guide.deadline) beginGuideMovement();
      if (guide.stage === 'movement' && performance.now() >= guide.deadline) {
        if (guide.movementTimes.size < 3) { failCalibrationGuide('No movement detected — try again.'); return; }
        if (!guide.wiliObserved) { failCalibrationGuide('No fresh WILi sample during the walk — try again.'); return; }
        guide.stage = 'movement-complete';
      }
    }
    renderCalibrationGuide();
  }

  function renderCalibrationGuide() {
    const guide = calibrationGuide;
    if (!guide) return;
    const text = (selector, value) => { const node = $(selector), next = String(value); if (node.textContent !== next) node.textContent = next; };
    const { waist, wili, fresh, ready } = guideLiveState();
    const cadence = value => finite(value) && value > 0 ? `${number(value, 1)} Hz` : 'cadence unavailable';
    text('#guide-wili-status', !online ? 'Offline' : wili?.connected ? 'WILi connected' : 'WILi disconnected');
    $('#guide-wili-status').className = `badge ${online && wili?.connected ? 'good' : 'warning'}`;
    text('#guide-wili-reading', `FREE-WILi: ${cadence(wili?.sampleHz)} · ${online && wili?.connected ? wili.quality || 'quality unavailable' : 'waiting for connection'}`);
    text('#guide-waist-status', !waist?.connected ? 'AirPod disconnected' : fresh ? `${waist.sensorLocation || 'Waist'} AirPod ready` : 'AirPod not fresh');
    $('#guide-waist-status').className = `badge ${fresh ? 'good' : 'warning'}`;
    text('#guide-waist-reading', `Waist: ${cadence(waist?.sampleHz)} · ${finite(waist?.ageMs) ? `last sample ${Math.round(waist.ageMs + (lastStateReceived ? Date.now() - lastStateReceived : 0))} ms ago` : 'no sample'}${waist?.calibrated ? ' · baseline present' : ''}`);
    text('#guide-waist-identity', `Reporting ${waist?.sensorLocation || 'unknown'} bud · ${waist?.sessionId ? `session ${waist.sessionId.slice(0, 8)}` : 'no session'}`);
    const active = ['still', 'requesting', 'verifying', 'calibrated', 'movement'].includes(guide.stage);
    const instructions = {
      placement: [ready ? 'READY' : 'WAITING', ready ? 'Ready to calibrate' : 'Connect both devices', ready ? `Chest WILi · ${waist.sensorLocation} AirPod at your waist.` : !token ? 'Enter the console pairing token first.' : 'Connect WILi and start AirPod motion in the Mac bridge.'],
      still: ['WAIST BASELINE', 'Stand upright', 'Keep still.'],
      requesting: ['WAIST BASELINE', 'Keep still', 'Recording your baseline…'],
      verifying: ['WAIST BASELINE', 'Keep still', 'Verifying…'],
      calibrated: ['WAIST BASELINE VERIFIED', 'Calibrated', ''],
      movement: ['MOTION CHECK', 'Walk a few steps', 'Move gently.'],
      error: ['INTERRUPTED', guide.error === 'No movement detected — try again.' ? 'No movement detected' : 'Try again', guide.baselineVerified ? 'Waist baseline kept. Repeat the walking step.' : 'Calibration was not verified.'],
      'movement-complete': ['MOTION CHECK COMPLETE', 'Done', 'Standing baseline verified. Movement recorded.'],
    };
    const instruction = instructions[guide.stage];
    text('#guide-stage-label', instruction[0]); text('#guide-instruction', instruction[1]); text('#guide-detail', instruction[2]);
    $('#guide-countdown').hidden = !['still', 'movement'].includes(guide.stage);
    text('#guide-countdown', finite(guide.deadline) ? `${Math.max(0, Math.ceil((guide.deadline - performance.now()) / 1000))}` : '—');
    $('#guide-error').hidden = !guide.error; text('#guide-error', guide.error || '');
    $('#guide-checkmark').hidden = !['calibrated', 'movement-complete'].includes(guide.stage);
    $('#guide-primary').hidden = active;
    $('#guide-primary').disabled = busy || (!ready && guide.stage !== 'movement-complete');
    text('#guide-primary', guide.stage === 'movement-complete' ? 'Close' : guide.stage === 'error' ? 'Retry' : 'Start');
    $('#guide-movement-results').hidden = !guide.results.length;
    const results = $('#guide-stage-results'); results.replaceChildren();
    for (const row of guide.results) {
      const range = value => value.min === null ? 'not observed' : `${number(value.min, 1)}${value.max !== value.min ? `–${number(value.max, 1)}` : ''} Hz`;
      const item = document.createElement('li'); item.textContent = `${row.label}: waist ${range(row.waist)} · FREE-WILi ${range(row.wili)}`; results.appendChild(item);
    }
    text('#guide-motion-count', guide.motionTimes ? `${guide.motionTimes.size} new waist samples observed; ${guide.movementTimes.size} met the movement check. Fresh WILi sample ${guide.wiliObserved ? 'observed' : 'not observed'}.` : '');
  }

  function guidePrimaryAction() {
    if (calibrationGuide?.stage === 'movement-complete') { closeCalibrationGuide(); return; }
    const { waist } = guideLiveState();
    const retryMovement = calibrationGuide?.stage === 'error' && calibrationGuide.errorStage === 'movement'
      && calibrationGuide.baselineVerified && waist?.calibrated && waist.sessionId === calibrationGuide.identity.sessionId
      && waist.sensorLocation === calibrationGuide.identity.sensorLocation;
    if (retryMovement) {
      if (!calibrationTimer) calibrationTimer = setInterval(syncCalibrationGuide, 250);
      beginGuideMovement();
    } else beginGuideStillStep();
  }

  function renderDemoNextStep() {
    const panel = $('#demo-next-step');
    panel.hidden = !snapshot || !online;
    if (panel.hidden) return;
    const next = [];
    const active = snapshot.incident && !terminal(snapshot.incident);
    const simulated = active ? simulatedIncident() : snapshot.dispatch?.mode === 'simulated';
    if (!snapshot.providers?.photon?.configured) next.push('configure Photon messaging credentials');
    else if (snapshot.providers.photon.detail?.includes('Target not allowed for this project')) next.push('register the approved phones in Photon project Users');
    if (!snapshot.wearerMessaging?.configured) next.push('configure the approved patient phone for iMessage');
    if (simulated ? !snapshot.responders.some(person => person.simulated === true)
      : !snapshot.responders.some(person => typeof person.phone === 'string' && person.phone.trim() && person.simulated !== true))
      next.push(simulated ? 'configure a local responder' : 'add at least one approved responder phone for live alerts');
    const waist = snapshot.sensors.find(sensor => sensor.source === 'waist-airpod');
    if (!waist?.connected) next.push('connect the waist AirPod and start motion in the Mac bridge');
    else if (!waist.fresh) next.push('restore fresh waist measurements');
    else if (!finite(waist.alignmentUncertaintyMs) || waist.alignmentUncertaintyMs > 100) next.push('wait for valid waist clock alignment');
    const wili = snapshot.wili;
    const sparseStockReport = wili?.connected && wili.captureClock === 'host-receipt' && wili.quality === 'stale'
      && wili.fullScaleG === 2 && wili.saturated === false
      && finite(wili.receivedAgeMs) && wili.receivedAgeMs >= 0 && wili.receivedAgeMs < 2000
      && finite(wili.sampleHz) && wili.sampleHz >= 0 && wili.sampleHz <= 2;
    if (!wili?.usable) next.push(sparseStockReport
      ? 'WILi is connected; waiting for its next acceleration report. Stock reporting is sparse at rest'
      : 'restore usable FREE-WILi measurements');
    panel.hidden = !next.length;
    text('#demo-next-step', next.length ? `Next for ${simulated ? 'local dispatch' : 'live dispatch'}: ${next.join('; ')}. Local record questions and console controls remain available.` : '');
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
      $('.chart-points', card)?.replaceChildren();
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
    text('.chart-range', `${(windowMs / 1000).toFixed(0)} s${card.id === 'body-wili' ? ' · received measurements' : ' · tilt 0–180°'}`, card);
    const points = $('.chart-points', card);
    if (points) points.innerHTML = trace.map(point => `<circle cx="${(left + (point.at - startAt) / windowMs * (right - left)).toFixed(1)}" cy="${(bottom - Math.max(0, Math.min(maxG, point.totalG)) / maxG * (bottom - top)).toFixed(1)}" r="1.8"/>`).join('');
  }

  const reportSource = (source, service) => {
    if (source === 'photon-imessage') return ['iMessage', 'SMS', 'RCS'].includes(service) ? `Photon ${service}` : 'Photon message';
    const names = { 'freewili-local-speech': 'WILi voice', 'ios-on-device-speech': 'Legacy phone voice', 'simulated-dispatch': 'Local responder' };
    return typeof source === 'string' && Object.hasOwn(names, source) ? names[source] : 'Recorded report';
  };

  function incidentMessages(incident) {
    if (!incident) return [];
    const human = (snapshot.conversation || []).filter(message => message.incidentId === incident.id)
      .map(message => ({ ...message, agent: false }));
    const messageTypes = new Set(['wearer_checkin', 'wearer_ack', 'wearer_status', 'alert', 'status', 'handoff', 'answer']);
    const outbound = snapshot.actions.filter(action => action.incidentId === incident.id && messageTypes.has(action.type)
      && typeof action.text === 'string' && action.text.trim()).map(action => ({
        id: action.id, incidentId: action.incidentId, at: action.createdAt, speakerName: 'LIFELINE',
        agent: true, recipient: action.recipientId ? nameFor(action.recipientId) : dashboardPresentation(snapshot).wearerName,
        text: action.text, source: action.provider === 'demo' || action.status === 'simulated' ? 'simulated-dispatch' : 'photon-imessage',
        delivery: action.status, detail: action.providerResult || '',
      }));
    const at = value => finite(value) ? value : Date.parse(value) || 0;
    return [...human, ...outbound].sort((a, b) => at(a.at) - at(b.at));
  }

  function renderIncident() {
    const saved = snapshot.incident, incident = activeIncident(snapshot), view = dashboardPresentation(snapshot, online);
    document.body.dataset.phase = incident?.phase || 'IDLE';
    $('.workspace-spectrum').dataset.phase = incident?.phase || 'IDLE';
    text('#overview-wearer', /^(patient|wearer)$/i.test(view.wearerName || '') ? 'Patient' : `Patient · ${view.wearerName}`);
    text('#incident-scope', incident ? 'CURRENT INCIDENT' : saved ? 'SAVED INCIDENT' : 'INCIDENT LOOP');
    text('#incident-id', saved ? `ID ${saved.id}` : 'NO ACTIVE INCIDENT');
    text('#incident-title', view.statusLabel);
    text('#incident-summary', view.summary);
    $('#incident-dispatch').hidden = !['live', 'simulated'].includes(saved?.dispatchMode);
    text('#incident-dispatch', simulatedIncident(saved) ? 'LOCAL DISPATCH' : 'LIVE RESPONDER DISPATCH');
    $('#incident-dispatch').className = `badge ${simulatedIncident(saved) ? 'warning' : ''}`;
    const evidence = $('#evidence-badge'); evidence.hidden = !saved;
    if (saved) {
      evidence.textContent = ({ synthetic: 'MANUAL CHECK-IN', manual: 'MANUAL REQUEST',
        'single-source': 'SINGLE-SOURCE EVIDENCE', 'cross-body': 'CROSS-BODY EVIDENCE' })[saved.evidence.kind] || saved.evidence.kind;
      evidence.className = `badge ${saved.evidence.kind === 'synthetic' ? 'warning' : ''}`;
    }
    renderMeasuredEvidence();
    renderClinicalViews();
    $('#phase-list').hidden = !incident;
    $('.incident-facts').hidden = !incident;
    const phaseIndex = phases.findIndex(([phase]) => phase === incident?.phase);
    $('#phase-list').className = 'phase-list';
    $('#phase-list').innerHTML = phases.map(([phase, label], index) => `<li class="${phaseIndex > index ? 'complete' : phaseIndex === index ? 'current' : ''}"${phase === incident?.phase ? ' aria-current="step"' : ''}>${label}</li>`).join('');
    text('#owner', view.ownerName || (incident ? 'Awaiting acceptance' : 'No response needed'));
    text('#owner-detail', view.ownerDetail);
    text('#incident-next-step', view.nextStep);
    text('#overview-report', view.latestReport ? `“${view.latestReport.text}”` : 'No patient report recorded.');
    text('#overview-report-source', view.latestReport ? `${reportSource(view.latestReport.source, view.latestReport.service)} · ${time(view.latestReport.at)}` : '');
    text('#overview-response-name', view.ownerName || (incident ? 'Awaiting acceptance' : 'No active response'));
    text('#overview-response-state', view.ownerState);
    text('#overview-response-meta', [view.simulated ? 'Local dispatch' : '', view.acceptedAt ? `Accepted ${time(view.acceptedAt)}` : '',
      incident?.ownerId ? view.ownerDetail.replace('Local responder. ', '') : ''].filter(Boolean).join(' · '));
    const facts = document.createDocumentFragment();
    const bodyConnected = snapshot.wili?.connected === true;
    const waistConnected = snapshot.sensors.some(source => source.source === 'waist-airpod' && source.connected);
    appendText(facts, 'p', '', !online ? 'Last received device state.'
      : `${bodyConnected ? 'WILi connected' : 'WILi awaiting connection'} · ${waistConnected ? 'Waist AirPod connected' : 'Waist AirPod awaiting connection'}.`);
    if (online && bodyConnected) appendText(facts, 'p', '', 'Quiet intervals between WILi reports are normal.');
    if (incident) appendText(facts, 'p', '', ({ synthetic: 'Check-in started manually.', manual: 'Manual request for help.',
      'single-source': 'One motion source contributed.', 'cross-body': 'Body and waist motion contributed.' })[incident.evidence.kind] || 'Incident evidence recorded.');
    if (!incident) appendText(facts, 'p', '', 'No active incident evidence.');
    $('#overview-evidence').replaceChildren(facts);
    const recent = incidentMessages(incident).filter(message => !message.agent).slice(-3);
    const list = document.createDocumentFragment();
    if (!recent.length) appendText(list, 'li', 'empty-list', incident ? 'No replies recorded yet.' : 'No active incident conversation.');
    for (const message of recent) {
      const row = appendText(list, 'li', '', '');
      appendText(row, 'strong', '', `${message.speakerName || 'Speaker'}${message.agent ? ` → ${message.recipient}` : ''}`);
      appendText(row, 'p', '', message.text);
      appendText(row, 'small', '', `${time(message.at)} · ${reportSource(message.source, message.service)}${message.agent ? ` · ${actionLabels[message.delivery]?.[0] || 'Status unavailable'}` : ''}`);
    }
    $('#overview-conversation').replaceChildren(list);
    renderHandoff();
    $('#outcome-panel').hidden = !saved?.outcome;
    text('#outcome-label', 'RECORDED OUTCOME');
    text('#outcome', saved?.outcome || '');
    text('#outcome-source', saved?.outcome ? `${simulatedIncident(saved) ? 'Local responder · ' : ''}Recorded by ${nameFor(saved.resolutionActor)} · ${time(saved.updatedAt)}` : '');
  }

  function appendText(parent, tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = value;
    parent.appendChild(element);
    return element;
  }

  function renderClinicalViews() {
    const motion = motionPresentation(snapshot, online, wiliTrace.points), condition = conditionPresentation(snapshot, online);
    for (const key of ['event', 'impact', 'rotation', 'quiet', 'severity']) text(`#motion-${key}`, motion[key]);
    text('#motion-position', motion.tilt);
    text('#motion-severity-detail', motion.severityDetail);
    text('#motion-injury', motion.report);
    text('#motion-evidence-source', motion.source);
    text('#condition-response', condition.response);
    text('#condition-responsive', condition.response);
    text('#condition-speaking', condition.speaking);
    text('#condition-source', condition.at !== null ? `${reportSource(condition.source)} · ${time(condition.at)} · A reply does not establish breathing or absence of bleeding.`
      : 'No current patient observation recorded. Physiological observations are shown separately below.');
    const observations = document.createDocumentFragment();
    for (const observation of watchPreview.conditions) {
      const item = appendText(observations, 'div', 'condition-item', '');
      appendText(item, 'span', 'eyebrow', observation.label);
      appendText(item, 'strong', '', observation.value);
      appendText(item, 'small', '', observation.detail);
    }
    $('#watch-condition-grid').replaceChildren(observations);
    const history = new Set((snapshot?.timeline || []).filter(event => ['RESOLVED', 'CANCELLED_FALSE_ALARM'].includes(event.type)).map(event => event.incidentId));
    text('#medical-history-count', `${history.size} recorded ${history.size === 1 ? 'incident' : 'incidents'}`);
    text('#medical-history-detail', history.size ? 'Resolved or cancelled incidents in the available LIFELINE history. Hospital history is separate.'
      : 'No closed incidents in the available LIFELINE history. Hospital history is separate.');
  }

  function renderMeasuredEvidence() {
    const assessment = snapshot?.incident?.evidence?.assessment;
    const present = assessment?.detector === 'wili-waist-provisional-v1' && assessment.impact && assessment.supportingWaist && assessment.quietWaist;
    $('#incident-evidence').hidden = !present;
    if (!present) { $('#incident-evidence-facts').replaceChildren(); text('#incident-evidence-timing', ''); text('#incident-evidence-sources', ''); return; }
    const impact = assessment.impact, waist = assessment.supportingWaist, quiet = assessment.quietWaist;
    text('#incident-evidence h3', activeIncident(snapshot) ? 'Measured trigger evidence' : 'Last incident measurements');
    text('#incident-evidence .badge', activeIncident(snapshot) ? 'FROZEN AT DETECTION' : 'SAVED INCIDENT');
    const metric = (value, unit, digits = 2) => finite(value) ? `${number(value, digits)} ${unit}` : 'Not recorded';
    const source = value => typeof value === 'string' && value ? value : 'Not recorded';
    const fields = document.createDocumentFragment();
    const rows = [
      ['Primary impact', `${metric(impact.totalG, 'g')} · selected threshold ${metric(assessment.selectedImpactG, 'g')} · range ${finite(impact.fullScaleG) ? `±${impact.fullScaleG} g` : 'not recorded'}`],
      ['Waist support', `${metric(waist.linearG, 'g')} linear · ${metric(waist.angularSpeed, 'rad/s')} rotation · timing separation ${metric(waist.separationMs, 'ms', 0)}`],
      ['Waist quiet', `${metric(quiet.durationMs, 'ms', 0)} across ${finite(quiet.sampleCount) ? quiet.sampleCount : 'unknown'} samples · maximum ${metric(quiet.maxLinearG, 'g')} linear, ${metric(quiet.maxAngularSpeed, 'rad/s')} rotation`],
    ];
    for (const [label, value] of rows) { const row = appendText(fields, 'div', '', ''); appendText(row, 'dt', '', label); appendText(row, 'dd', '', value); }
    $('#incident-evidence-facts').replaceChildren(fields);
    text('#incident-evidence-timing', impact.captureClock === 'host-receipt'
      ? 'Stock OG evidence uses gateway host-receipt timing. Sensor capture time and acquisition latency are not established. These frozen measurements support a provisional assessment, not a diagnosis or accuracy claim.'
      : impact.captureClock === 'device-monotonic'
        ? 'Device acquisition timestamps are mapped to the server monotonic clock. These frozen measurements support a provisional assessment, not a diagnosis or accuracy claim.'
        : 'Timing basis was not recorded. These measurements do not establish a diagnosis or detection accuracy.');
    const clock = assessment.alignmentAtAssessment;
    text('#incident-evidence-sources', [
      `Detector ${source(assessment.detector)} · assessed ${metric(assessment.assessedAtMs, 'ms server monotonic', 1)}`,
      `Primary ${source(impact.source)} · session ${source(impact.sessionId)} · sequence ${finite(impact.sequence) ? impact.sequence : 'not recorded'}`,
      `${impact.captureClock === 'host-receipt' ? 'Gateway' : 'Reported'} timestamp ${metric(impact.sensorTime, 's', 3)} · clock ${source(impact.captureClock)} · mapped ${metric(impact.alignedAtMs, 'ms server monotonic', 1)} · server receipt ${metric(impact.hostReceivedMs, 'ms', 1)}`,
      ...(typeof impact.frameTimestamp === 'string' ? [`Raw board frame timestamp ${impact.frameTimestamp}; conversion to capture time is not established.`] : []),
      `Waist ${source(waist.source)} · session ${source(waist.sessionId)} · bud ${source(waist.sensorLocation)} · sequence ${finite(waist.sequence) ? waist.sequence : 'not recorded'}`,
      `Waist device timestamp ${metric(waist.sensorTime, 's', 3)} · mapped ${metric(waist.alignedAtMs, 'ms server monotonic', 1)}`,
      `Quiet interval ${metric(quiet.fromAlignedAtMs, 'ms', 1)} → ${metric(quiet.toAlignedAtMs, 'ms', 1)} server monotonic · maximum gaps ${metric(quiet.maxCaptureGapMs, 'ms', 0)} capture / ${metric(quiet.maxReceiveGapMs, 'ms', 0)} receipt`,
      `Clock mapping uncertainty at assessment: ${impact.captureClock === 'host-receipt' ? 'gateway' : 'primary'} ${metric(clock?.bodyUncertaintyMs, 'ms', 1)} · waist ${metric(clock?.waistUncertaintyMs, 'ms', 1)}.`,
    ].join('\n'));
  }

  function patientContext() {
    const incident = activeIncident(snapshot);
    return patientScope === 'incident' && incident ? { key: `${incident.id}:${incident.healthRevision || 'unbound'}`, incidentId: incident.id } : { key: 'current', incidentId: null };
  }
  function clearPatientAnswer() {
    patientQuestionRequest?.controller.abort(); patientQuestionRequest = null;
    $('#patient-answer-panel').hidden = true; text('#patient-answer', ''); text('#patient-question-message', '');
    $('#patient-question-message').classList.remove('error');
  }
  function ensurePatientRecord() { if (token && patientContext().key !== patientContextKey) void loadPatientRecord(); }
  function updatePatientControls() {
    $('#patient-scope').value = patientContext().incidentId ? 'incident' : 'current';
    $('#patient-scope').querySelector('[value="incident"]').disabled = !activeIncident(snapshot)?.healthRevision;
    $('#patient-scope').disabled = !token || !online || !!patientRequest;
    $('#patient-refresh').disabled = !token || !online || !!patientRequest;
    $('#patient-question-submit').disabled = !token || !online || !patientRecord || !!patientRequest || !!patientQuestionRequest || !$('#patient-question').value.trim() || $('#patient-question').value.trim().length > 2000;
    $('#patient-question').disabled = !!patientQuestionRequest;
    $('#care-brief').disabled = !token || !online || !snapshot?.incident || briefBusy;
  }
  function renderPatientRecord() {
    const record = patientRecord, demographic = record?.records.find(row => row.section === 'demographics');
    text('#patient-name', demographic?.label || 'Protected patient context');
    text('#patient-identity', record?.subject ? `FinchNode patient record · ${record.subject}` : 'FinchNode patient record');
    text('#patient-snapshot', record ? `${patientContext().incidentId ? `Incident ${patientContext().incidentId} · immutable context` : 'Current patient context'}\nRevision ${record.revision}\nRetrieved ${new Date(record.fetchedAt).toISOString()} · data as of ${record.dataAsOf || 'unknown'}\nRecord access ${record.status} · source consent ${record.consent?.status || 'unknown'} · sync ${record.sync?.status || 'unknown'}` : token ? 'Protected patient context has not been retrieved.' : 'Pairing token required to read patient records.');
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
    $('#patient-records').replaceChildren(container); renderCompactCareSummary(); updatePatientControls();
  }
  function renderCompactCareSummary() {
    const brief = document.createDocumentFragment(), full = document.createDocumentFragment();
    if (!patientRecord) {
      appendText(brief, 'p', 'empty-list', token ? 'Care context has not been retrieved.' : 'Connect to read care context.');
      appendText(full, 'p', 'empty-list', 'Care context has not been retrieved.');
    } else {
      const care = careHighlights(patientRecord);
      const label = row => row.fields?.name || row.fields?.substance || row.label;
      const entries = [
        ...care.allergies.map(row => ({ kind: 'Allergy', label: label(row), detail: [row.fields?.reaction, row.fields?.severity].filter(Boolean).join(' · '), rows: [row] })),
        ...care.medications.map(group => ({ kind: 'Active prescription', label: group.name,
          detail: group.currentPrescriptions.map(row => [row.fields?.dosage, row.fields?.frequency, row.fields?.dosageInstructions].filter(Boolean).join(' · ')).filter(Boolean).join('; '), rows: group.records })),
        ...care.conditions.map(row => ({ kind: 'Condition', label: label(row), detail: row.fields?.status === 'active' ? '' : row.fields?.status || 'Status unknown', rows: [row] })),
      ];
      const small = appendText(brief, 'ul', '', '');
      for (const entry of entries.slice(0, 6)) appendText(small, 'li', '', `${entry.label}${entry.kind === 'Allergy' ? ' · allergy' : entry.kind === 'Active prescription' ? ' · prescribed' : ''}`);
      if (entries.length > 6) appendText(brief, 'p', 'overview-card-meta', `${entries.length - 6} more in care context.`);
      if (!entries.length) appendText(brief, 'p', 'empty-list', 'No care facts returned.');
      const demographic = patientRecord.records.find(row => row.section === 'demographics');
      appendText(brief, 'p', 'overview-card-meta', `FinchNode ${patientContext().incidentId ? 'incident snapshot' : 'current record'} · ${demographic?.label || 'name unavailable'}.`);
      const medicalGroups = new Map();
      for (const [kind, heading] of [['Allergy', 'Allergies'], ['Active prescription', 'Current medications'], ['Condition', 'Conditions']]) {
        const section = appendText(full, 'section', 'medical-fact-group', '');
        appendText(section, 'h3', '', heading);
        medicalGroups.set(kind, appendText(section, 'ul', '', ''));
        if (!entries.some(entry => entry.kind === kind)) appendText(section, 'p', 'field-note', 'No records returned in this category.');
      }
      for (const entry of entries) {
        const item = appendText(medicalGroups.get(entry.kind), 'li', '', '');
        appendText(item, 'strong', '', entry.label);
        appendText(item, 'p', 'field-note', `${entry.kind}${entry.detail ? ` · ${entry.detail}` : ''}`);
        const source = appendText(item, 'details', 'clinical-source', '');
        appendText(source, 'summary', '', 'View source');
        for (const row of entry.rows) appendText(source, 'p', '', `${row.section} · ${row.sourceName || row.source || 'Source unavailable'} · [${row.id}]${row.fields?.status ? ` · ${row.fields.status}` : ''}`);
      }
      if (care.vitals.length) {
        appendText(full, 'h3', '', 'Latest historical measurements');
        const vitals = appendText(full, 'ul', '', '');
        for (const row of care.vitals) appendText(vitals, 'li', '', `${label(row)} · ${row.fields.value}${row.fields.unit ? ` ${row.fields.unit}` : ''} · ${new Date(row.fields.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`);
      }
      if (care.missingCategories.length) appendText(full, 'p', 'field-note', `Not available: ${care.missingCategories.join(', ')}.`);
      appendText(full, 'p', 'field-note', 'Hospital context is read only. Patient reports remain separately attributed.');
    }
    $('#overview-care-context').replaceChildren(brief);
    $('#care-context-summary').replaceChildren(full);
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
        if (result.synthetic !== true || result.environment !== 'demo' || typeof result.revision !== 'string' || !Array.isArray(result.records) || !finite(result.fetchedAt)) throw new Error('Patient record response could not be verified as a FinchNode record.');
        return result;
      };
      let result, refreshedRevision = null;
      if (refresh) { result = await read('/api/patient-record/refresh', 'POST'); refreshedRevision = result.revision; }
      if (!refresh || scope.incidentId) result = await read(`/api/patient-record${scope.incidentId ? `?incidentId=${encodeURIComponent(scope.incidentId)}` : ''}`);
      if (!current()) return;
      if (scope.incidentId && result.revision !== snapshot?.incident?.healthRevision) throw new Error('Returned records do not match this incident’s clinical revision. Refresh the incident context and try again.');
      patientRecord = result; renderPatientRecord();
      text('#patient-load-message', refresh && scope.incidentId ? `Current patient refreshed to ${refreshedRevision}. This incident retains ${result.revision}.` : 'Hospital records retrieved from FinchNode. No hospital record was changed.');
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
    text('#handoff-title', activeIncident(snapshot) ? 'Current incident handoff' : 'Saved incident handoff');
    const [generation, color] = generationFor(snapshot.incident?.handoffGeneration);
    text('#handoff-generation', generation); $('#handoff-generation').className = `badge ${color}`;
    text('#handoff-source-context', snapshot.incident?.healthRevision
      ? `Clinical source: saved FinchNode snapshot ${snapshot.incident.healthRevision}. LIFELINE supplies incident observations; historical vitals are not current measurements.`
      : 'Clinical source revision has not been bound. LIFELINE observations and unavailable health information remain separate.');
    const content = snapshot.incident?.handoff || 'A record-grounded handoff will appear here when it is available.';
    const signature = JSON.stringify([snapshot.incident?.id, content, observationKey()]);
    if (signature === handoffSignature) return;
    handoffSignature = signature;
    const fragment = document.createDocumentFragment();
    const headings = new Set(['Known source facts:', 'Unavailable information:', 'Health context:', 'AI-composed synthetic health handoff:', 'AI unavailable — source template fallback:',
      'Patient reports (local observations, not hospital records):', 'Responder reports (local observations, not hospital records):']);
    // Saved handoffs keep their original text; an older heading is shown with its current label.
    const headingLabels = new Map([['AI-composed synthetic health handoff:', 'Health context:']]);
    const appendLines = (value) => {
      for (const line of value.split('\n')) {
        if (headings.has(line)) { appendText(fragment, 'h3', 'handoff-heading', headingLabels.get(line) ?? line); continue; }
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
    };
    // Only structure a quote when the saved handoff exactly matches its recorded
    // conversation source. Unknown/legacy text retains the literal line renderer.
    const sourceNames = { 'freewili-local-speech': ['FREE-WILi microphone / local Whisper'], 'ios-on-device-speech': ['iPhone on-device speech'], 'photon-imessage': ['Photon message', 'Photon iMessage'], 'simulated-dispatch': ['Responder', 'Simulated dispatch'] };
    const reports = (Array.isArray(snapshot.conversation) ? snapshot.conversation : []).flatMap(message => {
      if (message?.incidentId !== snapshot.incident?.id || !['wearer', 'responder'].includes(message.speaker)
        || typeof message.speakerName !== 'string' || typeof message.text !== 'string' || typeof message.id !== 'string'
        || !finite(message.at) || !Number.isFinite(new Date(message.at).getTime()) || !Object.hasOwn(sourceNames, message.source)) return [];
      const recorded = new Date(message.at).toISOString();
      return sourceNames[message.source].flatMap(source => {
        const literal = `${message.speakerName}: “${message.text}”; source: ${source}; recorded ${recorded} [conversation:${message.id}]`;
        const start = content.indexOf(literal);
        return start < 0 ? [] : [{ message, recorded, source, literal, start }];
      });
    }).sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const report of reports) {
      if (report.start < cursor) continue;
      const before = content.slice(cursor, report.start).replace(/\n$/, '');
      if (before) appendLines(before);
      const row = appendText(fragment, 'div', 'handoff-report', '');
      const speaker = appendText(row, 'p', 'handoff-report-speaker', '');
      appendText(speaker, 'strong', '', report.message.speakerName);
      appendText(speaker, 'span', '', report.message.source === 'simulated-dispatch' ? 'Local responder report' : report.message.speaker === 'wearer' ? 'Patient report' : 'Responder report');
      appendText(row, 'p', 'handoff-report-quote', `“${report.message.text}”`);
      const metadata = appendText(row, 'p', 'handoff-report-meta', `${report.source === 'Photon iMessage' ? 'Photon message' : report.source === 'Simulated dispatch' ? 'Responder' : report.source} · ${report.recorded} `);
      appendText(metadata, 'span', 'source-ref', `[conversation:${report.message.id}]`);
      cursor = report.start + report.literal.length;
    }
    const after = content.slice(cursor).replace(/^\n/, '');
    if (after) appendLines(after);
    $('#handoff').replaceChildren(fragment);
  }

  function syncContext(previousIncident, previousObservations) {
    const incident = snapshot?.incident;
    const changedIncident = previousIncident?.id !== incident?.id;
    const changedVersion = previousIncident?.version !== incident?.version;
    const changedObservations = previousObservations !== observationKey();
    if (changedIncident || (contextPreview && (changedVersion || changedObservations))) {
      $('#rehearsal-preview').hidden = true;
      contextPreview = null;
      text('#rehearsal-answer', '');
      text('#rehearsal-submitted-question', '');
      text('#rehearsal-context', '');
      text('#rehearsal-message', '');
      $('#rehearsal-message').classList.remove('error');
      if (!changedIncident) text('#rehearsal-message', 'Incident context changed. Generate a new preview using the current reports and phase.');
    }
    if (contextRequest && (changedIncident || changedVersion || changedObservations)) {
      contextRequest.controller.abort();
      contextRequest = null;
      text('#rehearsal-message', 'Incident context changed while generating. Review the current reports and phase, then generate a new preview.');
      $('#rehearsal-message').classList.add('error');
    }
  }

  function renderQuestions() {
    const incident = snapshot?.incident;
    text('#context-incident', incident ? `Context ${incident.id} · ${incident.phase} · version ${incident.version}` : 'No incident context available.');
    const questions = new Map();
    const received = new Map();
    const answered = new Set();
    const questionKey = (responderId, inboundId) => JSON.stringify([responderId, inboundId]);
    for (const event of snapshot.timeline) {
      if (event.incidentId !== incident?.id || !['QUESTION_RECEIVED', 'ANSWER_QUEUED'].includes(event.type)) continue;
      try {
        const detail = JSON.parse(event.detail);
        if (detail?.source !== 'photon-imessage' || typeof detail.question !== 'string') continue;
        const key = typeof detail.inboundId === 'string' && detail.inboundId ? questionKey(event.actor, detail.inboundId) : null;
        if (event.type === 'ANSWER_QUEUED' && typeof detail.actionId === 'string') {
          questions.set(detail.actionId, detail);
          if (key) answered.add(key);
        } else if (event.type === 'QUESTION_RECEIVED' && key && !received.has(key)) {
          received.set(key, { event, detail });
        }
      } catch { /* Older audit entries do not contain the original question. */ }
    }
    const actions = snapshot.actions.filter((action) => action.incidentId === incident?.id && action.type === 'answer').slice().sort((a, b) => b.createdAt - a.createdAt);
    const entries = [
      ...actions.map(action => ({ action, at: action.createdAt })),
      ...[...received].filter(([key]) => !answered.has(key)).map(([, question]) => ({ ...question, at: question.event.at })),
    ].sort((a, b) => b.at - a.at);
    text('#question-count', entries.length);
    const fragment = document.createDocumentFragment();
    if (!entries.length) appendText(fragment, 'li', 'empty-list', 'No responder questions for this incident.');
    for (const entry of entries) {
      if (!entry.action) {
        const { event, detail } = entry;
        const changed = terminal(incident) || detail.incidentVersion !== incident.version
          || incident.declined?.includes(event.actor) || !incident.contacted?.includes(event.actor);
        const row = appendText(fragment, 'li', 'question-item', '');
        const head = appendText(row, 'div', 'question-head', '');
        appendText(head, 'strong', '', nameFor(event.actor));
        appendText(head, 'span', `badge ${changed ? '' : 'warning'}`, changed ? 'Context changed' : 'Answer pending');
        appendText(row, 'p', 'question-label', 'Question');
        appendText(row, 'p', 'question-text', detail.question);
        appendText(row, 'p', 'question-result', changed ? 'Incident context or responder eligibility changed. No answer is recorded as queued.'
          : 'Received for answer preparation. No answer has been queued yet.');
        appendText(row, 'p', 'question-meta', `${time(event.at)} · Photon message · Inbound ${detail.inboundId}`);
        continue;
      }
      const { action } = entry;
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
      appendText(row, 'p', 'question-result', action.status === 'simulated' ? `Local delivery; no provider send or recipient receipt.${action.providerResult ? ` ${action.providerResult}` : ''}` : action.providerResult || 'No provider result yet.');
      const source = detail ? `Photon message${typeof detail.inboundId === 'string' ? ` · Inbound ${detail.inboundId}` : ''}` : 'Original question source unavailable';
      appendText(row, 'p', 'question-meta', `${time(action.createdAt)} · ${source} · Action ${action.id}`);
    }
    $('#responder-questions').replaceChildren(fragment);
  }

  function updateRehearsalControls() {
    const incident = snapshot?.incident;
    const question = $('#rehearsal-question').value.trim();
    $('#rehearsal-submit').disabled = !token || !online || !incident || !!contextRequest || !question || question.length > 2000;
    $('#rehearsal-question').disabled = !!contextRequest;
    text('#rehearsal-availability', !incident ? 'Start a check-in to provide incident context.'
      : !token ? 'Enter a pairing token in Connections to enable this preview.'
      : !online ? 'Reconnect to the server before generating a preview.'
      : contextRequest ? 'Generating against the displayed incident context…'
      : 'Uses this incident, including a recorded terminal phase. Nothing is sent to a responder.');
  }

  async function rehearseQuestion() {
    const incident = snapshot?.incident;
    const question = $('#rehearsal-question').value.trim();
    if (!token || !online || !incident || contextRequest || !question || question.length > 2000) return;
    const request = { incidentId: incident.id, version: incident.version, phase: incident.phase, observations: observationKey(), question, controller: new AbortController() };
    contextRequest = request;
    const current = () => contextRequest === request && snapshot?.incident?.id === request.incidentId && snapshot?.incident?.version === request.version && observationKey() === request.observations;
    updateRehearsalControls();
    $('#rehearsal-message').classList.remove('error');
    text('#rehearsal-message', 'Generating a local preview…');
    try {
      const response = await fetch('/api/context/question', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ incidentId: request.incidentId, question }), signal: AbortSignal.any([request.controller.signal, AbortSignal.timeout(30000)]) });
      const result = await response.json().catch(() => { throw new Error('Preview service returned an unreadable response. Check server availability and try again.'); });
      if (!current()) return;
      if (response.status === 401) throw new Error('Pairing token rejected. Enter a current pairing token in Connections and try again.');
      if (!response.ok || result.error) throw new Error(`${result.error || `Preview unavailable (${response.status})`}. Review the current incident context and try again.`);
      if (result.incidentId !== request.incidentId || result.version !== request.version) throw new Error('Preview context did not match the requested incident and version. Review the current phase and generate a new preview.');
      if (typeof result.answer !== 'string' || typeof result.generation !== 'string' || !Object.hasOwn(generationLabels, result.generation)) throw new Error('Preview service returned an invalid answer. Check server availability and try again.');
      const generation = generationFor(result.generation);
      text('#rehearsal-generation', generation[0]);
      $('#rehearsal-generation').className = `badge ${generation[1]}`;
      text('#rehearsal-context', `Preview context ${request.incidentId} · ${request.phase} · version ${request.version}`);
      text('#rehearsal-submitted-question', `Question: ${request.question}`);
      text('#rehearsal-answer', result.answer);
      contextPreview = { incidentId: request.incidentId, version: request.version, observations: request.observations };
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
      text('#reply-transcript', 'No patient check-in reply received for this incident.');
      text('#reply-meta', 'Patient speech and iMessage replies can request help or preserve the check-in. Cancellation requires the explicit current check-in control.');
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
    const source = reply.actor === 'freewili-local-speech' ? 'FREE-WILi microphone · local Whisper' : reply.actor === 'ios-on-device-speech' ? 'Legacy iPhone on-device speech' : reply.actor === 'photon-imessage' ? 'Patient Photon message' : reply.actor;
    text('#reply-meta', `${time(reply.at)} · ${source} · Cancellation requires the explicit check-in control.`);
    $('#reply-transcript').classList.add('has-reply');
  }

  function renderCheckinAudio() {
    const incident = snapshot?.incident, audio = snapshot?.checkinAudio;
    const matching = !!incident && !!audio && audio.incidentId === incident.id && audio.checkinId === incident.checkinId;
    const active = incident?.phase === 'CONFIRMING';
    const at = matching && finite(audio.at) ? audio.at : null;
    const now = Date.now() + clockOffset;
    const age = at === null ? null : now - at;
    const connected = !!snapshot?.wili?.connected && typeof audio?.sessionId === 'string' && !!audio.sessionId && audio.sessionId === snapshot?.wili?.sessionId;
    const timely = finite(age) && age >= 0 && age < 6000;
    const beforeDeadline = finite(incident?.checkinDeadline) && now < incident.checkinDeadline;
    let label = 'Voice status unavailable', color = '', detail = 'No matching wearable voice report for this check-in.';
    if (!incident) {
      label = 'No active check-in'; detail = 'Wearable voice status appears during an incident check-in.';
    } else if (!active) {
      label = matching && audio.stage === 'complete' ? 'Transcript received' : matching && audio.stage === 'listening' ? 'Listening window ended' : 'Check-in inactive';
      detail = 'This check-in is no longer active.';
    } else if (matching) {
      if (!online || !connected) {
        label = 'Voice unavailable'; detail = !online ? 'Live state interrupted; no current listening window is established.' : 'Wearable disconnected; no current listening window is established.';
      } else if (audio.stage === 'listening') {
        const remaining = timely && beforeDeadline ? Math.ceil(Math.min(6000 - age, incident.checkinDeadline - now) / 1000) : 0;
        label = remaining > 0 ? `LISTENING — speak now (${remaining}s left)` : 'Listening window ended';
        color = timely && beforeDeadline ? 'good' : '';
        detail = timely && beforeDeadline ? 'FREE-WILi microphone is in its reported capture window.' : 'No fresh listening window is established for this check-in.';
      } else {
        const stages = { prompting: ['WILi speaking', ''], transcribing: ['Transcribing', 'warning'], complete: ['Transcript received', 'good'], unavailable: ['Voice unavailable', 'bad'] };
        if (typeof audio.stage === 'string' && Object.hasOwn(stages, audio.stage)) {
          [label, color] = stages[audio.stage]; detail = 'Reported by the connected wearable.';
        }
      }
    }
    text('#checkin-audio-status', label); $('#checkin-audio-status').className = color ? `voice-${color}` : '';
    text('#checkin-audio-detail', `${detail}${at !== null ? ` Last report ${time(at)}.` : ''}`);
    text('#checkin-audio-control', label); $('#checkin-audio-control').className = `field-note checkin-audio-control${color ? ` voice-${color}` : ''}`;
    const current = activeIncident(snapshot);
    let demoTitle = 'Ready', instruction = 'Press Start or yellow on WILi. Wait for the prompt, then speak.';
    let demoState = 'ready';
    if (!online || !snapshot) {
      demoTitle = 'Connecting…'; instruction = 'Waiting for LIFELINE.'; demoState = 'offline';
    } else if (current) {
      demoState = 'active';
      const steps = {
        DETECTED: ['Checking in', 'Wait for WILi’s prompt.'],
        CONFIRMING: ['Listen to WILi', 'Speak when WILi says it’s listening.'],
        HELP_REQUESTED: ['Getting help', 'LIFELINE is contacting the responder. Watch your phone.'],
        ACKNOWLEDGED: ['Help accepted', 'The responder has accepted responsibility.'],
        RESPONDER_EN_ROUTE: ['On the way', 'Replies appear on your phone and play through WILi.'],
        ON_SCENE: ['Help has arrived', 'Waiting for the responder to record the outcome.'],
      };
      [demoTitle, instruction] = Object.hasOwn(steps, current.phase)
        ? steps[current.phase] : ['Incident active', 'Follow the messages on your phone.'];
      if (current.phase === 'CONFIRMING') {
        if (label.startsWith('LISTENING')) {
          demoTitle = 'Speak now'; instruction = 'Tell LIFELINE what happened.'; demoState = 'listening';
        } else if (label === 'Transcribing' || label === 'Transcript received') {
          demoTitle = 'One moment'; instruction = 'LIFELINE is processing your reply.';
        } else if (label === 'Voice unavailable' || label === 'Listening window ended') {
          demoTitle = 'Checking in'; instruction = 'Reply on your phone, or press red if you need help.';
        }
      }
    }
    text('#demo-status', demoTitle); text('#demo-instruction', instruction);
    $('#demo-pulse').dataset.state = demoState;
    const mode = current?.dispatchMode ?? snapshot?.dispatch?.mode;
    text('#demo-mode-label', mode === 'simulated' ? 'LOCAL RESPONDER' : mode === 'live' ? 'LIVE RESPONDER' : 'Connecting');
  }

  function renderConversation() {
    const incident = snapshot?.incident;
    const available = Array.isArray(snapshot?.conversation);
    const messages = incidentMessages(incident);
    const signature = JSON.stringify([incident?.id, incident?.phase, incident?.dispatchMode, available, messages]);
    if (signature === conversationSignature) return;
    conversationSignature = signature;
    text('#conversation-count', incident && !available ? '—' : messages.length);
    text('#conversation-context', incident ? `${terminal(incident) ? 'Saved' : 'Current'} incident · ${incident.id}${simulatedIncident(incident) ? ' · local dispatch' : ''}` : 'No incident conversation yet.');
    const list = $('#conversation'), fragment = document.createDocumentFragment();
    const follow = list.scrollHeight - list.clientHeight - list.scrollTop < 24, priorScroll = list.scrollTop;
    const deliveries = { recorded: ['Recorded', ''], queued: ['Queued', ''], playing: ['Playing on wearable', ''],
      spoken: ['Playback completed', ''], failed: ['Delivery failed', 'bad'], attempting: ['Sending', ''],
      provider_accepted: ['Submitted · receipt unconfirmed', ''], unknown: ['Delivery unknown', ''],
      cancelled: ['Cancelled', ''], simulated: ['Local delivery', ''] };
    if (!messages.length) appendText(fragment, 'li', 'empty-list', !incident ? 'Conversation appears when an incident starts.'
      : !available ? 'Conversation history is unavailable.' : 'No messages recorded for this incident.');
    for (const message of messages) {
      const wearer = message.speaker === 'wearer', responder = message.speaker === 'responder';
      const row = appendText(fragment, 'li', `conversation-message${wearer ? ' conversation-wearer' : responder ? ' conversation-responder' : ' conversation-agent'}`, '');
      const head = appendText(row, 'div', 'conversation-head', '');
      const speaker = appendText(head, 'div', 'conversation-speaker', '');
      appendText(speaker, 'strong', '', message.speakerName || (wearer ? 'Patient' : responder ? 'Responder' : 'Speaker unavailable'));
      appendText(speaker, 'span', 'conversation-role', message.agent ? `To ${message.recipient}`
        : message.source === 'simulated-dispatch' ? 'Local responder' : wearer ? 'Patient' : responder ? 'Responder' : '');
      const [label, color] = deliveries[message.delivery] || ['Status unavailable', ''];
      appendText(head, 'span', `badge ${color}`, label);
      appendText(row, 'p', 'conversation-quote', message.text || 'Message text unavailable.');
      appendText(row, 'p', 'conversation-meta', `${time(message.at)} · ${reportSource(message.source, message.service)}`);
      if (typeof message.detail === 'string' && message.detail) {
        const detail = appendText(row, 'details', 'conversation-detail', '');
        appendText(detail, 'summary', '', 'Delivery details');
        appendText(detail, 'p', '', message.detail);
      }
    }
    list.replaceChildren(fragment);
    list.scrollTop = follow ? list.scrollHeight : priorScroll;
  }

  function validLocationPoint(point) {
    return !!point && finite(point.latitude) && point.latitude >= -90 && point.latitude <= 90
      && finite(point.longitude) && point.longitude >= -180 && point.longitude <= 180;
  }

  function locationPointAge(point) {
    return finite(point?.ageMs) && point.ageMs >= 0 ? point.ageMs + (lastStateReceived ? Math.max(0, Date.now() - lastStateReceived) : 0) : null;
  }

  function updateLocationControls() {
    if (!$('#location-invite')) return;
    const location = snapshot?.location;
    const native = location?.native?.configured === true;
    const invite = native ? location.native.request : location?.invite;
    const active = snapshot?.incident && !terminal(snapshot.incident);
    const pending = ['queued', 'attempting'].includes(invite?.status);
    $('#location-invite').disabled = !token || !online || location?.configured !== true || locationInviteBusy || pending || !!active;
    text('#location-invite', locationInviteBusy ? 'Requesting…' : 'Request location in iMessage');
    const labels = { queued: 'Location request queued', attempting: 'Submitting location request',
      provider_accepted: 'Location request submitted; sharing permission is still required',
      failed: 'Location request failed', unknown: 'Location request outcome unknown', cancelled: 'Location request cancelled' };
    text('#location-invite-state', !location ? 'Location sharing is unavailable in this server state.'
      : !online ? 'Last received state. Reconnect to request location.'
      : active ? 'The incident check-in includes the patient’s location request.'
      : !location.configured ? 'The patient’s location sharing connection is not configured.'
      : !token ? 'Pairing token required to request the approved patient’s location.'
      : typeof invite?.status === 'string' && Object.hasOwn(labels, invite.status) ? labels[invite.status]
      : 'Sends a location request to the approved patient. Sharing requires their consent.');
  }

  function renderLocation() {
    if (!$('#location-invite')) return;
    const location = snapshot?.location;
    const shared = online && ['wearer', 'responder'].some(role => validLocationPoint(location?.[role])
      && location[role].fresh === true && locationPointAge(location[role]) !== null && locationPointAge(location[role]) <= 60000);
    text('#location-status', !location ? 'Unavailable' : !online ? 'Last state' : shared ? 'Location shared' : location.configured ? 'Awaiting location' : 'Not configured');
    $('#location-status').className = 'badge';
    const native = location?.native;
    $('#location-native-detail').hidden = !native;
    const nativePosition = ['wearer', 'responder'].some(role => validLocationPoint(location?.[role]) && location[role].source === 'photon-find-my');
    text('#location-native-detail', native ? `Photon Find My · ${native.configured !== true ? 'Not configured' : nativePosition ? 'Shared position received' : 'Waiting for a shared position'}` : '');
    for (const role of ['wearer', 'responder']) {
      const point = location?.[role], valid = validLocationPoint(point), age = locationPointAge(point);
      const fresh = online && valid && point.fresh === true && age !== null && age <= 60000;
      text(`#location-${role}-name`, typeof point?.name === 'string' && point.name.trim() ? point.name : role === 'wearer' ? 'Patient' : 'Responder');
      text(`#location-${role}-position`, valid ? `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}` : 'Not shared');
      const ageText = age !== null ? age < 1000 ? 'just received' : `${Math.floor(age / 1000)} s old` : 'age unavailable';
      const accuracy = finite(point?.accuracy) && point.accuracy >= 0 ? `accuracy ±${Math.ceil(point.accuracy)} m` : 'accuracy unknown';
      const sources = { 'browser-geolocation': 'Browser location', 'photon-find-my': 'Photon Find My' };
      const source = typeof point?.source === 'string' && Object.hasOwn(sources, point.source) ? sources[point.source] : 'Location source unavailable';
      text(`#location-${role}-meta`, valid ? `${!online ? 'Last received' : fresh ? 'Fresh' : 'Last shared'} · ${ageText} · ${accuracy} · ${source}` : 'No shared location received.');
      const map = $(`#location-${role}-map`); map.hidden = !valid;
      if (valid) map.href = `https://maps.apple.com/?ll=${point.latitude},${point.longitude}&q=${encodeURIComponent(role === 'wearer' ? 'Wearer location' : 'Responder location')}`;
      else map.removeAttribute('href');
    }
    const eta = location?.eta;
    const usable = online && ['wearer', 'responder'].every(role => validLocationPoint(location?.[role]) && location[role].fresh === true
      && locationPointAge(location[role]) !== null && locationPointAge(location[role]) <= 60000
      && finite(location[role].accuracy) && location[role].accuracy >= 0 && location[role].accuracy <= 100)
      && finite(eta?.seconds) && eta.seconds >= 0 && finite(eta.distanceMeters) && eta.distanceMeters >= 0
      && ['apple-maps-walking', 'straight-line-walking-estimate'].includes(eta.method);
    const minutes = usable ? eta.seconds < 60 ? '<1 min' : `${Math.ceil(eta.seconds / 60)} min` : '';
    const distance = usable ? eta.distanceMeters < 1000 ? `${Math.round(eta.distanceMeters)} m` : `${(eta.distanceMeters / 1000).toFixed(1)} km` : '';
    text('#location-eta', usable ? `${eta.method === 'apple-maps-walking' ? 'Walk' : 'Approx. walk'} · ${minutes} · ${distance}` : 'Waiting for two fresh, accurate locations');
    text('#location-eta-detail', usable ? eta.method === 'apple-maps-walking' ? `Apple Maps estimate · updated ${time(eta.updatedAt)}. Location does not confirm arrival.`
      : 'Straight-line estimate; routes and indoor access may take longer. Location does not confirm arrival.' : !online ? 'Reconnecting. Last locations do not establish a current approach estimate.' : 'Both people must share a fresh location with accuracy within 100 m.');
    updateLocationControls();
  }

  async function inviteLocation() {
    if (!$('#location-invite')) return;
    updateLocationControls(); if ($('#location-invite').disabled) return;
    const requestToken = token; locationInviteBusy = true; updateLocationControls();
    $('#location-message').classList.remove('error'); text('#location-message', 'Requesting location in iMessage…');
    try {
      const response = await fetch('/api/location/invite', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${requestToken}` }, body: '{}', signal: AbortSignal.timeout(12000) });
      const result = await response.json(); if (token !== requestToken) return;
      if (!response.ok || result.ok !== true || typeof result.queued !== 'boolean') throw new Error(response.status === 401 ? 'Pairing token rejected. Enter a current operator token.'
        : response.status === 409 ? 'The current incident already handles the patient’s location request.' : response.status === 503 ? 'Location requests are unavailable. Check the patient messaging connection.' : 'Could not request location. Check its status before trying again.');
      text('#location-message', result.queued ? 'Location request queued. Accept LIFELINE’s location-sharing request in iMessage.' : 'A location request already exists. No duplicate was queued.');
      await loadState().catch(() => {});
    } catch (error) {
      if (token !== requestToken) return;
      $('#location-message').classList.add('error'); text('#location-message', error.name === 'TimeoutError' ? 'Request timed out. Check location request status before trying again.' : error.message || 'Location sharing is unavailable.');
    } finally { locationInviteBusy = false; updateLocationControls(); }
  }

  // Indoor access notes are explicitly local, not inferred from GPS or silently sent over Photon.
  function renderAccessNotes(notes = {}) {
    const defaults = { building: 'Apartment building · Unit 111', floor: 'Level 1', room: 'Kitchen floor', route: 'Front door → entry → kitchen' };
    for (const key of ['building', 'floor', 'room', 'route']) {
      const value = typeof notes[key] === 'string' ? notes[key].trim() : '';
      text(`#access-${key}`, value || defaults[key]);
      $('#access-form').elements.namedItem(key).value = value || defaults[key];
    }
  }
  try { renderAccessNotes(JSON.parse(sessionStorage.getItem('lifeline-access-notes') || '{}')); }
  catch { renderAccessNotes(); }
  $('#access-form').addEventListener('submit', event => {
    event.preventDefault();
    const notes = Object.fromEntries(new FormData(event.currentTarget));
    renderAccessNotes(notes);
    try {
      sessionStorage.setItem('lifeline-access-notes', JSON.stringify(notes));
      text('#access-save-state', 'Saved in this browser tab. These notes are not sent to responders.');
    } catch { text('#access-save-state', 'Shown for this session; browser storage is unavailable. These notes are not sent to responders.'); }
  });

  function wellbeingToday(wellbeing = snapshot?.wellbeing) {
    const zone = wellbeing?.schedule?.timeZone;
    if (typeof zone !== 'string' || !zone) return null;
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(new Date(Date.now() + clockOffset));
      const part = (type) => parts.find(item => item.type === type)?.value;
      return `${part('year')}-${part('month')}-${part('day')}`;
    } catch { return null; }
  }

  function updateWellbeingControls() {
    const wellbeing = snapshot?.wellbeing;
    const today = wellbeingToday(wellbeing);
    const alreadyStarted = !!today && wellbeing?.lastCheckinDate === today;
    const pending = Number.isInteger(wellbeing?.pendingCount) && wellbeing.pendingCount > 0;
    const active = snapshot?.incident && !terminal(snapshot.incident);
    $('#wellbeing-brief').disabled = !token || !online || !wellbeing || wellbeingBriefBusy;
    text('#wellbeing-brief', wellbeingBriefBusy ? 'Preparing journal…' : 'Download care journal');
    $('#wellbeing-checkin').disabled = !token || !online || wellbeing?.enabled !== true || !today || wellbeingBusy || alreadyStarted || !!active;
    text('#wellbeing-checkin', wellbeingBusy ? 'Requesting…' : alreadyStarted ? 'Today’s check-in started' : 'Send today’s check-in');
    text('#wellbeing-checkin-state', !wellbeing ? 'Daily check-ins are unavailable in this server state.'
      : !online ? 'Last received state. Reconnect before sending.'
      : !wellbeing.enabled ? 'Daily check-ins are not enabled.'
      : active ? 'Daily check-ins pause during an active incident.'
      : alreadyStarted ? `Today’s prompt already exists.${pending ? ` ${wellbeing.pendingCount} message${wellbeing.pendingCount === 1 ? '' : 's'} pending.` : ''}`
      : pending ? `${wellbeing.pendingCount} message${wellbeing.pendingCount === 1 ? '' : 's'} pending.`
      : !token ? 'Pairing token required for this control.'
      : !today ? 'The schedule time zone is unavailable.'
      : 'The scheduler runs autonomously. Use this button to check in now.');
  }

  function renderWellbeing() {
    const wellbeing = snapshot?.wellbeing;
    const signature = JSON.stringify([online, wellbeing]);
    if (signature === wellbeingSignature) return;
    wellbeingSignature = signature;
    const schedule = wellbeing?.schedule;
    let scheduleLabel = 'Default schedule · 2:00 PM America/New_York';
    if (typeof schedule?.label === 'string' && schedule.label.trim()) scheduleLabel = schedule.label;
    else if (Number.isInteger(schedule?.hour) && schedule.hour >= 0 && schedule.hour <= 23 && typeof schedule.timeZone === 'string')
      scheduleLabel = `Daily · ${schedule.hour % 12 || 12}:00 ${schedule.hour >= 12 ? 'PM' : 'AM'} ${schedule.timeZone}`;
    text('#wellbeing-schedule', scheduleLabel);
    text('#wellbeing-status', !wellbeing ? 'Unavailable' : !online ? 'Last state' : wellbeing.enabled ? 'Scheduled daily' : 'Not enabled');
    $('#wellbeing-status').className = `badge${online && wellbeing?.enabled ? ' good' : ''}`;
    // The daily card is today's conversation; earlier days stay in the care journal export.
    const today = new Date().toDateString();
    const allMessages = Array.isArray(wellbeing?.messages) ? wellbeing.messages.filter(message => message && typeof message === 'object'
        && finite(message.at) && new Date(message.at).toDateString() === today)
      .slice().sort((a, b) => (finite(a.at) ? a.at : 0) - (finite(b.at) ? b.at : 0)).slice(-40) : [];
    const messages = allMessages.slice(-4), earlier = allMessages.slice(0, -4);
    const deliveries = { pending: ['Queued', ''], queued: ['Queued', ''], attempting: ['Submitting', 'warning'], provider_accepted: ['Provider accepted', ''],
      recorded: ['Recorded', ''], failed: ['Failed', 'bad'], unknown: ['Outcome unknown', 'warning'], cancelled: ['Cancelled', ''] };
    const sources = { 'photon-imessage': 'Text · Photon message', 'freewili-local-speech': 'Voice · WILi microphone',
      agent: 'Text · LIFELINE', 'daily-checkin': 'Text · Daily check-in' };
    const renderMessage = (parent, message) => {
      const wearer = message.speaker === 'wearer';
      const row = appendText(parent, 'li', `wellbeing-message${wearer ? ' wellbeing-wearer' : ''}`, '');
      const head = appendText(row, 'div', 'wellbeing-message-head', '');
      appendText(head, 'strong', '', wearer ? 'Patient' : message.speaker === 'lifeline' ? 'LIFELINE' : 'Speaker unavailable');
      const [label, color] = typeof message.delivery === 'string' && Object.hasOwn(deliveries, message.delivery)
        ? deliveries[message.delivery] : ['Status unavailable', ''];
      appendText(head, 'span', `badge ${color}`, wearer && message.delivery === 'recorded' ? 'Reply recorded' : label);
      appendText(row, 'p', 'wellbeing-message-text', typeof message.text === 'string' ? message.text : 'Message text unavailable.');
      const source = typeof message.source === 'string' && Object.hasOwn(sources, message.source) ? sources[message.source] : 'Source unavailable';
      const date = finite(message.at) ? new Date(message.at) : null;
      const recordedAt = date && finite(date.getTime()) ? date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Time unavailable';
      appendText(row, 'p', 'wellbeing-message-meta', `${source} · ${recordedAt}`);
      const record = message.recordContext;
      if (message.speaker === 'lifeline' && record?.source === 'finchnode-synthetic' && record.synthetic === true) {
        const provenance = appendText(row, 'div', 'wellbeing-record-source', '');
        const provenanceHead = appendText(provenance, 'div', 'wellbeing-record-head', '');
        appendText(provenanceHead, 'strong', '', 'FinchNode record');
        const [generation, generationColor] = generationFor(message.generation);
        appendText(provenanceHead, 'span', `badge ${generationColor}`, generation);
        const subject = typeof record.subjectName === 'string' && record.subjectName.trim() ? record.subjectName : 'Unnamed record subject';
        appendText(provenance, 'p', '', `${subject} · FinchNode patient record.`);
        const revision = typeof record.revision === 'string' && record.revision.trim() ? record.revision : 'unavailable';
        appendText(provenance, 'p', 'wellbeing-record-revision', `Saved record revision: ${revision}`);
        const ids = Array.isArray(record.sourceRecordIds) ? record.sourceRecordIds.filter(id => typeof id === 'string' && id.trim()) : [];
        appendText(provenance, 'p', 'wellbeing-record-citations', ids.length ? `Source citations: ${ids.map(id => `[${id}]`).join(' ')}` : 'No source record citations saved for this reply.');
        const retrieved = finite(record.retrievedAt) ? new Date(record.retrievedAt) : null;
        appendText(provenance, 'p', '', `Record retrieved: ${retrieved && finite(retrieved.getTime()) ? retrieved.toISOString() : 'time unavailable'}`);
        if (record.truncated === true) appendText(provenance, 'p', 'wellbeing-record-truncated', 'Reply shortened for messaging. Its linked source snapshot is retained in the care journal.');
      }
    };
    const fragment = document.createDocumentFragment(), olderFragment = document.createDocumentFragment();
    if (!messages.length) appendText(fragment, 'li', 'empty-list', !wellbeing ? 'Daily conversation state is unavailable.' : 'No daily check-in yet today.');
    messages.forEach(message => renderMessage(fragment, message));
    earlier.forEach(message => renderMessage(olderFragment, message));
    $('#wellbeing-messages').replaceChildren(fragment);
    $('#wellbeing-earlier-messages').replaceChildren(olderFragment);
    $('#wellbeing-earlier').hidden = !earlier.length;
    text('#wellbeing-earlier-summary', `Earlier conversation · ${earlier.length} message${earlier.length === 1 ? '' : 's'}`);
    const voice = wellbeing?.voice;
    const voiceStages = { listening: 'Listening', recording: 'Recording', transcribing: 'Transcribing', complete: 'Transcript recorded', unavailable: 'Voice unavailable' };
    $('#wellbeing-voice').hidden = !voice;
    if (voice) text('#wellbeing-voice', `${online ? 'Voice' : 'Last voice report'} · ${typeof voice.stage === 'string' && Object.hasOwn(voiceStages, voice.stage) ? voiceStages[voice.stage] : 'Status unavailable'} · ${time(voice.at)}`);
    updateWellbeingControls();
  }

  async function downloadCareJournal() {
    updateWellbeingControls();
    if ($('#wellbeing-brief').disabled) return;
    const requestToken = token, conversationId = snapshot?.wellbeing?.conversationId;
    const current = () => token === requestToken && snapshot?.wellbeing?.conversationId === conversationId;
    wellbeingBriefBusy = true; updateWellbeingControls();
    $('#wellbeing-brief-message').classList.remove('error'); text('#wellbeing-brief-message', 'Preparing the care journal…');
    try {
      const response = await fetch('/api/wellbeing/brief', { headers: { Authorization: `Bearer ${requestToken}` }, cache: 'no-store', signal: AbortSignal.timeout(20000) });
      if (!current()) return;
      if (!response.ok) throw new Error(response.status === 401 ? 'Pairing token rejected. Enter a current operator token.'
        : response.status === 404 ? 'Care journal is unavailable in this server version.' : 'Care journal is unavailable. Reconnect and try again.');
      const blob = await response.blob(); if (!current()) return;
      const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url;
      link.download = `lifeline-care-journal-${String(conversationId || 'daily').replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
      document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      text('#wellbeing-brief-message', 'Care journal download requested. Daily reports and FinchNode hospital snapshots remain separate.');
    } catch (error) {
      if (!current()) return;
      $('#wellbeing-brief-message').classList.add('error');
      text('#wellbeing-brief-message', error.name === 'TimeoutError' ? 'Care journal read timed out. Reconnect and try again.' : error.message || 'Care journal unavailable. Try again.');
    } finally {
      wellbeingBriefBusy = false;
      if (!current()) text('#wellbeing-brief-message', '');
      updateWellbeingControls();
    }
  }

  async function requestWellbeingCheckin() {
    updateWellbeingControls();
    if ($('#wellbeing-checkin').disabled) return;
    const requestToken = token;
    wellbeingBusy = true; updateWellbeingControls();
    $('#wellbeing-message').classList.remove('error'); text('#wellbeing-message', 'Requesting today’s check-in…');
    try {
      const response = await fetch('/api/wellbeing/checkin', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${requestToken}` },
        body: '{}', signal: AbortSignal.timeout(12000) });
      const result = await response.json();
      if (token !== requestToken) return;
      if (!response.ok || result.error) throw new Error(response.status === 401 ? 'Pairing token rejected. Enter a current operator token.'
        : result.error || (response.status === 409 ? 'Daily check-ins pause during an active incident.'
          : response.status === 503 ? 'Daily check-ins are unavailable. Check the patient messaging connection.' : `Check-in request failed (${response.status}).`));
      if (result.ok !== true || typeof result.queued !== 'boolean') throw new Error('Check-in status was unreadable. Check the daily conversation before trying again.');
      text('#wellbeing-message', result.queued ? 'Today’s check-in queued. Delivery status appears above.' : 'Today’s prompt already exists. No duplicate was queued.');
      await loadState().catch(() => {});
    } catch (error) {
      if (token !== requestToken) return;
      $('#wellbeing-message').classList.add('error');
      text('#wellbeing-message', error.name === 'TimeoutError' ? 'Request timed out. Check today’s status before trying again.' : error.message || 'Could not request today’s check-in.');
    } finally { wellbeingBusy = false; updateWellbeingControls(); }
  }

  function renderReadiness() {
    if (!snapshot) return;
    const sourceRows = [['waist-airpod', 'Waist AirPod stream']].map(([source, label]) => {
      const sensor = snapshot.sensors.find((item) => item.source === source);
      const receiving = online && sensor?.connected && sensor?.fresh;
      const status = !sensor?.connected ? 'Disconnected' : !online ? 'Last received' : !sensor.fresh ? 'Stale' : 'Receiving';
      const detail = sensor?.connected ? `${sensor.calibrated ? 'Standing tilt calibration recorded' : 'Tilt baseline not calibrated; optional for this detector'}${source === 'waist-airpod' && sensor.sensorLocation ? ` · reporting ${sensor.sensorLocation} bud` : ''}` : 'No connected source reported';
      return `<li><div class="readiness-head"><strong>${label}</strong><span class="badge ${receiving ? 'good' : ''}">${status}</span></div><p>${escaped(detail)}</p></li>`;
    });
    const alignments = [['waist-airpod', 'Waist']].map(([source, label]) => {
      const uncertainty = snapshot.sensors.find((sensor) => sensor.source === source)?.alignmentUncertaintyMs;
      return `${label}: ${finite(uncertainty) ? `±${Math.round(uncertainty)} ms` : 'unknown'}`;
    }).join(' · ');
    const audio = snapshot.providers?.elevenlabs;
    const wiliVoice = snapshot.providers?.wiliVoice;
    const wearerMessaging = snapshot.wearerMessaging;
    const wili = snapshot.wili;
    const readiness = detectorReadiness();
    const dispatch = snapshot.dispatch;
    const dispatchRow = ['live', 'simulated'].includes(dispatch?.mode)
      ? `<li><div class="readiness-head"><strong>Responder dispatch</strong><span class="badge ${dispatch.mode === 'simulated' ? 'warning' : ''}">${!online ? 'Last state' : dispatch.mode === 'simulated' ? snapshot.responders.some(person => person.simulated === true) ? 'Ready' : 'Waiting for local responder' : 'Live profile'}</span></div><p>${escaped(dispatch.detail)}${dispatch.mode === 'simulated' ? ' No live responder send or recipient receipt is asserted.' : ''}</p></li>` : '';
    $('#native-readiness').innerHTML = `<li><div class="readiness-head"><strong>FREE-WILi accelerometer</strong><span class="badge">${online && wili?.usable ? 'Acquisition ready' : !online ? 'Last received' : escaped(wili?.quality || 'Unavailable')}</span></div><p>${escaped(`Source body-wili · range ${finite(wili?.fullScaleG) ? `±${wili.fullScaleG} g` : 'unknown'} · ${wili?.captureClock === 'host-receipt' ? 'gateway receipt clock' : 'device capture clock'} mapping ${finite(wili?.alignmentUncertaintyMs) ? `±${Math.round(wili.alignmentUncertaintyMs)} ms` : 'unknown'}. ${wili?.captureClock === 'host-receipt' ? 'Stock timing does not measure sensor capture latency.' : 'No primary orientation is inferred.'}`)}</p></li>` + sourceRows.join('')
      + `<li><div class="readiness-head"><strong>Provisional cross-body detector</strong><span class="badge ${readiness.ready ? 'good' : ''}">${readiness.ready ? 'Signals ready' : 'Waiting'}</span></div><p>${escaped(readiness.detail)} Telemetry readiness does not establish detection accuracy.</p></li>`
      + `<li><div class="readiness-head"><strong>Clock alignment</strong></div><p>${escaped(alignments)}</p></li>`
      + `<li><div class="readiness-head"><strong>WILi voice cache</strong><span class="badge ${wiliVoice?.configured ? 'good' : ''}">${wiliVoice?.configured ? 'Prepared' : 'Unavailable'}</span></div><p>${escaped(wiliVoice?.detail || 'No prepared board voice cache reported.')} Check playback on the wearable.</p></li>`
      + `<li><div class="readiness-head"><strong>ElevenLabs API</strong><span class="badge">${audio?.configured ? 'Configured' : 'Unavailable'}</span></div><p>${escaped(audio?.detail || 'No ElevenLabs API status reported')}</p></li>`
      + `<li><div class="readiness-head"><strong>Patient iMessage</strong><span class="badge">${wearerMessaging?.configured ? 'Configured' : 'Unavailable'}</span></div><p>${escaped(wearerMessaging?.detail || 'No patient messaging configuration reported')}</p></li>` + dispatchRow;
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
    $('#responders').innerHTML = responders.length ? responders.map((person) => `<li class="responder-item"><span class="avatar">${escaped(initials(person.name))}</span><div><strong>${escaped(person.name)}</strong><p>${escaped(person.simulated === true ? 'Local responder · automatic local progression; no live phone alert' : person.phone ? 'Approved phone configured; send result in Delivery activity' : 'Approved phone needed for live alerts')}</p></div>${person.id === ownerId ? `<span class="badge ${simulatedIncident() ? 'warning' : 'good'}">OWNER</span>` : person.simulated === true ? '<span class="badge warning">LOCAL</span>' : ''}</li>`).join('') : `<li class="empty-list">${snapshot.dispatch?.mode === 'simulated' ? 'No local responder reported.' : 'Add an approved responder with a phone for live alerts.'}</li>`;
    const signature = JSON.stringify(responders.map((person) => [person.id, person.name, person.simulated]));
    if (signature !== responderSignature) {
      const selected = $('#responder').value;
      $('#responder').innerHTML = responders.length ? responders.map((person) => `<option value="${escaped(person.id)}">${escaped(person.name)}${person.simulated === true ? ' · local' : ''}</option>`).join('') : '<option value="">No approved responders</option>';
      if (responders.some((person) => person.id === selected)) $('#responder').value = selected;
      responderSignature = signature;
    }
  }

  function renderProviders() {
    const providers = Object.entries(snapshot.providers || {});
    const names = { photon: 'Photon messaging', finchnode: 'FinchNode records', elevenlabs: 'ElevenLabs API', llm: 'Grounded AI', wiliVoice: 'WILi voice cache' };
    $('#providers').innerHTML = providers.length ? providers.map(([name, status]) => `<li class="provider-item"><div class="provider-head"><strong>${escaped(Object.hasOwn(names, name) ? names[name] : name)}</strong><span class="badge ${status.configured ? 'good' : ''}">${status.configured ? name === 'wiliVoice' ? 'Prepared' : 'Configured' : 'Unavailable'}</span></div><p>${escaped(status.detail)}</p></li>`).join('') : '<li class="empty-list">No provider status available.</li>';
  }

  function renderTimeline() {
    const events = snapshot.timeline.filter((event) => event.incidentId === snapshot.incident?.id).slice().sort((a, b) => b.at - a.at);
    text('#event-count', events.length);
    $('#timeline-dispatch-note').hidden = !simulatedIncident();
    $('#timeline').innerHTML = events.length ? events.map((event) => {
      const simulated = simulatedActor(event.actor) || simulatedIncident() && (snapshot.responders.some(person => person.id === event.actor && person.simulated === true)
        || ['ACKNOWLEDGED', 'RESPONDER_EN_ROUTE', 'ON_SCENE', 'RESOLVED'].includes(event.type));
      const actor = `${nameFor(event.actor)}${simulated && !simulatedActor(event.actor) ? ' · local' : ''}`;
      return `<li class="event-item"><div class="event-head"><strong>${escaped(event.type.replaceAll('_', ' ').replace('WEARER', 'PATIENT'))}${simulated ? ' · local' : ''}</strong><time>${escaped(time(event.at))}</time></div><p>${escaped(timelineDetail(event))}</p><span class="event-actor">${escaped(actor)}</span></li>`;
    }).join('') : '<li class="empty-list">Events will appear as the incident progresses.</li>';
  }

  function timelineDetail(event) {
    try {
      const detail = JSON.parse(event.detail);
      if (event.type === 'QUESTION_RECEIVED' && detail?.source === 'photon-imessage' && typeof detail.question === 'string') {
        return `Question received: ${detail.question}\nQueued for answer preparation. This event does not establish an answer or delivery.`;
      }
      if (event.type === 'ANSWER_QUEUED' && detail?.source === 'photon-imessage' && typeof detail.question === 'string') {
        return `Question: ${detail.question}\nAnswer queued · ${generationFor(detail.generation)[0].toLowerCase()}. Delivery is not yet established.`;
      }
      if (event.type === 'CHECKIN_REPLY' && typeof detail?.transcript === 'string') {
        const decisions = { help_requested: 'Help requested', confirmation_required: 'Explicit cancellation still required', unresolved: 'Incident remains unresolved' };
        const decision = typeof detail.decision === 'string' && Object.hasOwn(decisions, detail.decision) ? decisions[detail.decision] : 'Reply recorded';
        return `Patient reply: ${detail.transcript}\n${decision}.`;
      }
      if (event.type === 'WEARER_REPORT' && typeof detail?.transcript === 'string') {
        return `Patient update: ${detail.transcript}\nRecorded from the private Photon conversation. Incident responsibility is unchanged.`;
      }
      if (event.type === 'CONVERSATION_MESSAGE' && detail?.speaker === 'responder' && typeof detail.transcript === 'string') {
        return `Responder message: ${detail.transcript}\nQueued for wearable speech; delivery appears in Conversation.`;
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
      const actionTitles = { wearer_checkin: 'Patient iMessage', wearer_ack: 'Patient iMessage acknowledgement', wearer_status: 'Patient progress update', wearer_location: 'Patient approach update', wearer_relay: 'Patient quote to responder', checkin: 'Device check-in request', answer: 'Responder answer' };
      const actionTitle = Object.hasOwn(actionTitles, action.type) ? actionTitles[action.type] : action.type[0].toUpperCase() + action.type.slice(1);
      const message = action.text ? `<details class="action-message" data-action-id="${escaped(action.id)}"${expanded.has(action.id) ? ' open' : ''}><summary>View message</summary><p>${escaped(action.text)}</p></details>` : '';
      const result = action.status === 'simulated' ? `Local delivery; no provider send or recipient receipt.${action.providerResult ? ` ${action.providerResult}` : ''}` : action.providerResult || 'No provider result yet.';
      return `<li class="action-item"><div class="action-head"><strong>${escaped(actionTitle)}${action.recipientId ? ` · ${escaped(nameFor(action.recipientId))}` : ''}</strong><span class="badge ${color}">${escaped(label)}</span></div><p>${escaped(result)}</p>${message}<span class="action-meta">${escaped(time(action.createdAt))} · ${action.attempts} attempt${action.attempts === 1 ? '' : 's'}${action.providerMessageId ? ` · Message ${escaped(action.providerMessageId.slice(0, 18))}` : ''}</span></li>`;
    }).join('') : '<li class="empty-list">No external actions queued.</li>';
  }

  function updateTime() {
    renderWili();
    renderLocation();
    renderCheckinAudio();
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
    const seconds = Math.ceil((deadline - (online ? Date.now() + clockOffset : snapshot.serverTime)) / 1000);
    text('#deadline', `${seconds > 0 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : 'Deadline reached'}${online ? '' : ' · last known'}`);
    text('#deadline-detail', `${incident.phase === 'CONFIRMING' ? 'Check-in' : incident.phase === 'HELP_REQUESTED' ? 'Responder acceptance' : 'Responder progress'} · ${time(deadline)}`);
  }

  function updateControls() {
    const ready = !!token && online && !!snapshot && !busy;
    const incident = snapshot?.incident;
    const active = !!incident && !terminal(incident);
    const responder = $('#responder').value;
    const isOwner = active && incident.ownerId === responder;
    const automaticResponder = simulatedIncident(incident);
    $('#manual-responder-controls').hidden = automaticResponder;
    $('#simulated-responder-note').hidden = !automaticResponder;
    $('#trigger').disabled = !ready || active;
    $('#manual-help').disabled = !ready || (active && incident.phase !== 'CONFIRMING');
    $('#manual-help').textContent = incident?.phase === 'CONFIRMING' ? 'Request help now' : 'Request help immediately';
    $('#cancel').disabled = !ready || incident?.phase !== 'CONFIRMING';
    $('#responder').disabled = automaticResponder || !snapshot?.responders.length || busy;
    $('#accept').disabled = automaticResponder || !ready || !responder || incident?.phase !== 'HELP_REQUESTED';
    $('#depart').disabled = automaticResponder || !ready || !isOwner || incident?.phase !== 'ACKNOWLEDGED';
    $('#arrive').disabled = automaticResponder || !ready || !isOwner || !['ACKNOWLEDGED', 'RESPONDER_EN_ROUTE'].includes(incident?.phase);
    $('#decline').disabled = automaticResponder || !ready || !isOwner;
    $('#resolve').disabled = automaticResponder || !ready || !isOwner || incident?.phase !== 'ON_SCENE' || $('#outcome-input').value.trim().length < 5;
    $('#outcome-input').disabled = automaticResponder;
    $('#calibrate').disabled = busy || !!calibrationGuide;
    $('#reset').disabled = !ready;
    const recording = ['recording', 'stopping'].includes(snapshot?.trial?.status);
    $('#trial-start').disabled = !ready || trialBusy || active || recording || !$('#trial-label').value.trim() || $('#trial-label').value.trim().length > 80;
    $('#trial-stop').disabled = !ready || trialBusy || snapshot?.trial?.status !== 'recording';
    $('#trial-download').disabled = !token || trialBusy || snapshot?.trial?.status !== 'stopped';
    $('#trial-label').disabled = trialBusy || recording;
    $('#trial-scenario').disabled = trialBusy || recording;
    const markerLabel = $('#trial-marker-label').value.trim();
    const pairedRecording = snapshot?.trial?.status === 'recording' && snapshot.trial.captureMode === 'wili-waist';
    $('#trial-marker-label').disabled = trialBusy || !pairedRecording;
    $('#trial-marker').disabled = !ready || trialBusy || !pairedRecording || !markerLabel || markerLabel.length > 80 || /[\u0000-\u001f]/.test(markerLabel);
    updateRehearsalControls();
    updatePatientControls();
    updateWellbeingControls();
    updateLocationControls();
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
    const message = '#command-message';
    busy = true;
    updateControls();
    text(message, 'Applying command…');
    $(message).classList.remove('error');
    try {
      const response = await fetch('/api/commands', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(payload), signal: AbortSignal.timeout(12000) });
      const result = await response.json();
      if (!response.ok || result.error) throw new Error(result.error || `Command failed (${response.status})`);
      text(message, payload.type === 'reset' ? 'Back at the start. Ready for another check-in; no calibration required.' : 'Command accepted by the controller.');
      if (payload.type === 'resolve' || payload.type === 'reset') $('#outcome-input').value = '';
      await loadState().catch(() => {});
    } catch (error) {
      $(message).classList.add('error');
      text(message, error.name === 'TimeoutError'
        ? 'Request timed out. Check incident state before repeating the command.'
        : error.message || 'Command failed.');
    } finally {
      busy = false;
      updateControls();
    }
  }

  function renderTrial() {
    const trial = snapshot?.trial;
    const labels = { recording: 'RECORDING', stopping: 'STOPPING', stopped: 'STOPPED', error: 'ERROR' };
    const scenarios = { standing: 'Standing', 'phone-drop': 'Device drop', sit: 'Sit', bend: 'Bend', 'staged-fall': 'Staged fall', other: 'Other' };
    const active = ['recording', 'stopping'].includes(trial?.status);
    const status = trial ? Object.hasOwn(labels, trial.status) ? labels[trial.status] : String(trial.status) : 'NO RECORDING';
    text('#trial-status', !online && active ? `${status} · LAST STATE` : status);
    $('#trial-status').className = `badge ${trial?.status === 'error' ? 'bad' : active && !online ? 'warning' : trial?.status === 'recording' ? 'good' : trial?.status === 'stopping' ? 'warning' : ''}`;
    const wiliCount = trial?.sampleCounts?.['body-wili'], waistCount = trial?.sampleCounts?.['waist-airpod'];
    const countAvailable = value => Number.isInteger(value) && value >= 0;
    text('#trial-wili-count', countAvailable(wiliCount) ? wiliCount.toLocaleString() : '—');
    text('#trial-waist-count', countAvailable(waistCount) ? waistCount.toLocaleString() : '—');
    const measured = !trial ? 'Counts appear when measurements are recorded.'
      : trial.captureMode === 'legacy-core-motion' ? 'Legacy CoreMotion capture; FREE-WILi was not recorded.'
        : !countAvailable(wiliCount) ? 'FREE-WILi count unavailable for this recording.'
        : !countAvailable(waistCount) ? 'Waist AirPod count unavailable for this recording.'
          : wiliCount > 0 && waistCount > 0 ? 'Measurements from both streams recorded.'
            : wiliCount === 0 && waistCount === 0 ? `No measurements recorded${active ? ' yet' : ''}.`
              : `Only ${wiliCount > 0 ? 'FREE-WILi' : 'waist AirPod'} measurements recorded${active ? `; waiting for ${wiliCount > 0 ? 'waist AirPod' : 'FREE-WILi'}` : ''}.`;
    text('#trial-measurements', `${measured}${trial?.status === 'error' ? ' Recording is incomplete.' : ''}${!online && active ? ' Counts are the last received state.' : ''}`);
    $('#trial-markers').hidden = !trial;
    text('#trial-markers', trial?.captureMode === 'legacy-core-motion' ? 'Operator markers are unavailable for legacy capture.'
      : countAvailable(trial?.markerCount) ? `${trial.markerCount.toLocaleString()} operator marker${trial.markerCount === 1 ? '' : 's'} recorded.` : 'Operator marker count unavailable.');
    const scenario = trial && Object.hasOwn(scenarios, trial.scenario) ? scenarios[trial.scenario] : trial?.scenario;
    const mode = trial?.captureMode === 'wili-waist' ? ' · WILi + waist capture' : trial?.captureMode === 'legacy-core-motion' ? ' · Legacy CoreMotion capture' : '';
    text('#trial-summary', trial ? `${trial.label} · ${scenario}${mode} · ID ${trial.id}${trial.reason ? ` · ${trial.reason}` : ''}` : 'No trial has been recorded.');
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
    const label = $(operation === 'marker' ? '#trial-marker-label' : '#trial-label').value.trim();
    if (['start', 'marker'].includes(operation) && (!label || label.length > 80 || /[\u0000-\u001f]/.test(label))) return;
    if (operation === 'marker' && (!online || busy || snapshot?.trial?.status !== 'recording' || snapshot.trial.captureMode !== 'wili-waist')) return;
    trialBusy = true;
    updateControls();
    $('#trial-message').classList.remove('error');
    text('#trial-message', operation === 'start' ? 'Starting recording…' : operation === 'marker' ? 'Recording operator marker…' : 'Stopping recording…');
    try {
      const body = operation === 'start' ? { label, scenario: $('#trial-scenario').value } : operation === 'marker' ? { label } : {};
      const response = await fetch(`/api/trials/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
      const result = await response.json();
      if (!response.ok || result.error) throw new Error(result.error || `Recording request failed (${response.status})`);
      if (snapshot) snapshot.trial = result;
      renderTrial();
      text('#trial-message', operation === 'start'
        ? result.status === 'recording' ? 'Recording started. Counts increase only for recorded measurements.' : 'Recording request accepted. Check its current status.'
        : operation === 'marker' ? 'Operator marker accepted. Check the recording status before continuing.'
        : result.status === 'stopped' ? 'Recording stopped. Monitoring and incident response remain active.' : 'Stop requested. Monitoring and incident response remain active.');
      if (operation === 'marker') $('#trial-marker-label').value = '';
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

  function toggleDeveloperTools() {
    developerEnabled = !developerEnabled;
    location.hash = developerEnabled ? '#developer' : '#motion';
    updateWorkspaceNavigation();
  }
  $('#developer-toggle').addEventListener('click', toggleDeveloperTools);
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'd') {
      event.preventDefault(); toggleDeveloperTools();
    }
  });
  $('#token-form').addEventListener('submit', (event) => { event.preventDefault(); setToken($('#token').value); });
  $('#copy-token').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(token); $('#copy-token').textContent = 'Pairing token copied'; }
    catch { $('#copy-token').textContent = 'Clipboard unavailable — use localhost /api/setup'; }
  });
  $('#responder').addEventListener('change', updateControls);
  $('#outcome-input').addEventListener('input', updateControls);
  $('#trial-label').addEventListener('input', updateControls);
  $('#trial-marker-label').addEventListener('input', updateControls);
  $('#patient-refresh').addEventListener('click', () => loadPatientRecord(true));
  $('#patient-scope').addEventListener('change', (event) => { patientScope = event.target.value; void loadPatientRecord(); });
  $('#patient-question').addEventListener('input', updatePatientControls);
  $('#patient-question-form').addEventListener('submit', (event) => { event.preventDefault(); askPatientQuestion(); });
  $('#care-brief').addEventListener('click', downloadCareBrief);
  $('#rehearsal-question').addEventListener('input', updateRehearsalControls);
  $('#rehearsal-form').addEventListener('submit', (event) => { event.preventDefault(); rehearseQuestion(); });
  $('#trial-start').addEventListener('click', () => trialRequest('start'));
  $('#trial-stop').addEventListener('click', () => trialRequest('stop'));
  $('#trial-marker').addEventListener('click', () => trialRequest('marker'));
  $('#trial-download').addEventListener('click', downloadTrial);
  $('#wellbeing-checkin').addEventListener('click', requestWellbeingCheckin);
  $('#wellbeing-brief').addEventListener('click', downloadCareJournal);
  $('#location-invite')?.addEventListener('click', inviteLocation);
  $('#trigger').addEventListener('click', () => command({ type: 'trigger', kind: 'synthetic', summary: 'Check-in started manually. No fall was measured.' }));
  $('#manual-help').addEventListener('click', () => command({ type: 'trigger', kind: 'manual', summary: 'Help requested manually.' }));
  $('#cancel').addEventListener('click', () => { const incident = snapshot?.incident; if (incident) command({ type: 'cancel', incidentId: incident.id, checkinId: incident.checkinId }); });
  for (const type of ['accept', 'depart', 'arrive', 'decline']) $(`#${type}`).addEventListener('click', () => { const incident = snapshot?.incident; if (incident) command({ type, incidentId: incident.id, responderId: $('#responder').value }); });
  $('#resolve').addEventListener('click', () => { const incident = snapshot?.incident; if (incident) command({ type: 'resolve', incidentId: incident.id, responderId: $('#responder').value, outcome: $('#outcome-input').value.trim() }); });
  $('#calibrate').addEventListener('click', openCalibrationGuide);
  $('#calibration-close').addEventListener('click', closeCalibrationGuide);
  $('#calibration-guide').addEventListener('cancel', (event) => { event.preventDefault(); closeCalibrationGuide(); });
  $('#calibration-guide').addEventListener('close', () => { if (calibrationGuide) closeCalibrationGuide(); });
  $('#guide-primary').addEventListener('click', guidePrimaryAction);
  document.addEventListener('visibilitychange', () => { if (document.hidden && ['still', 'requesting', 'verifying', 'calibrated', 'movement'].includes(calibrationGuide?.stage)) failCalibrationGuide('Keep this screen visible during calibration. Retry when ready.'); });
  $('#reset').addEventListener('click', () => command({ type: 'reset', readyImmediately: true }));
  window.addEventListener('pagehide', () => { closeCalibrationGuide(); clearTimeout(reconnectTimer); socket = null; contextRequest?.controller.abort(); contextRequest = null; patientRequest?.controller.abort(); patientRequest = null; patientQuestionRequest?.controller.abort(); patientQuestionRequest = null; });

  $('#phase-list').innerHTML = phases.map(([, label]) => `<li>${label}</li>`).join('');
  updateControls();
  if (location.hash === '#calibration' || (location.pathname === '/calibration' && !location.hash)) openCalibrationGuide();
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

// Watch preview vitals update like a live feed: bounded variation around the sample
// baseline, and the trace scrolls one beat per heartbeat. Presentation only.
{
  const [heart, oxygen, breathing] = document.querySelectorAll('.watch-vitals strong');
  const trace = document.querySelector('.watch-vitals svg path');
  if (heart && oxygen && breathing && trace) {
    const period = 71, beat = x => `H${x}L${x + 8} 20L${x + 14} 27L${x + 22} 7L${x + 29} 35L${x + 37} 24`;
    let path = 'M0 24'; for (let x = 27; x < 240 + period * 2; x += period) path += beat(x);
    trace.setAttribute('d', path); trace.closest('svg').style.overflow = 'hidden';
    const vitals = { hr: watchPreview.heartRate, spo2: watchPreview.oxygen, rr: watchPreview.respiratoryRate };
    const drift = (value, base, spread, low, high) =>
      Math.min(high, Math.max(low, Math.round(value + (base - value) * .3 + (Math.random() - .5) * spread)));
    const show = (element, value) => { if (element.firstChild) element.firstChild.nodeValue = `${value} `; };
    let tick = 0;
    setInterval(() => {
      tick++;
      vitals.hr = drift(vitals.hr, watchPreview.heartRate, 4, 68, 86); show(heart, vitals.hr);
      if (tick % 3 === 0) { vitals.rr = drift(vitals.rr, watchPreview.respiratoryRate, 2.4, 13, 19); show(breathing, vitals.rr); }
      if (tick % 5 === 0) { vitals.spo2 = drift(vitals.spo2, watchPreview.oxygen, 1.6, 96, 99); show(oxygen, vitals.spo2); }
    }, 1000);
    const still = matchMedia('(prefers-reduced-motion: reduce)');
    let offset = 0, last = performance.now();
    const scroll = now => {
      const elapsed = Math.min(.1, (now - last) / 1000); last = now;
      if (!still.matches && !document.hidden) {
        offset = (offset + period * vitals.hr / 60 * elapsed) % period;
        trace.setAttribute('transform', `translate(${(-offset).toFixed(2)} 0)`);
      }
      requestAnimationFrame(scroll);
    };
    requestAnimationFrame(scroll);
  }
}
