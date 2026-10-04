(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const text = (selector, value) => { $(selector).textContent = value; };
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const validPoint = point => !!point && finite(point.latitude) && point.latitude >= -90 && point.latitude <= 90
    && finite(point.longitude) && point.longitude >= -180 && point.longitude <= 180;
  let grant = readGrant();
  let access = null, locationView = null, viewReceivedAt = null;
  let validGrant = false, disposed = false, stopping = false, stopFailed = false;
  let state = 'idle', generation = 0, watchId = null, watchEpoch = 0;
  let pendingPosition = null, lastPosition = null, lastSubmitAt = 0, lastSequence = 0;
  let sendTimer = null, pollTimer = null, getRequest = null, postRequest = null, stopRequest = null;
  let statusDetail = 'You choose when to share. You can stop at any time.';

  function readGrant() {
    const params = new URLSearchParams(location.hash.slice(1));
    if ([...params.keys()].length !== 1 || params.getAll('grant').length !== 1) return null;
    const value = params.get('grant');
    return typeof value === 'string' && /^[A-Za-z0-9_-]{24,256}$/.test(value) ? value : null;
  }

  function showError(message) { $('#sharing-error').hidden = !message; text('#sharing-error', message || ''); }
  function clearWatch() {
    watchEpoch++;
    if (watchId !== null) navigator.geolocation?.clearWatch(watchId);
    watchId = null; pendingPosition = null; clearTimeout(sendTimer); sendTimer = null;
  }
  function cancelRequests() {
    generation++; getRequest?.controller.abort(); getRequest = null; postRequest?.controller.abort(); postRequest = null;
  }
  function stopPolling() { clearInterval(pollTimer); pollTimer = null; }
  function startPolling() {
    stopPolling();
    if (validGrant && grant && !disposed && !document.hidden && !stopFailed && !stopping)
      pollTimer = setInterval(() => { if (!postRequest) void loadAccess(); }, 5000);
  }

  function render() {
    const labels = { idle: validGrant ? 'Ready to share' : 'Checking invitation', waiting: 'Waiting for location', sharing: 'Sharing', paused: 'Paused', stopping: 'Stopping', stopped: 'Stopped', unavailable: 'Unavailable' };
    text('#sharing-status', labels[state] || 'Unavailable');
    $('#sharing-status').className = `status${state === 'sharing' ? ' sharing' : state === 'paused' ? ' paused' : ''}`;
    text('#sharing-identity', access ? `This invitation is for ${typeof access.name === 'string' && access.name.trim() ? access.name : access.role === 'wearer' ? 'the patient' : 'the responder'}.`
      : grant ? 'Checking your invitation.' : 'Open the location invitation from your LIFELINE message.');
    text('#sharing-context', access ? `${access.role === 'wearer' ? 'Patient' : 'Responder'}${typeof access.incidentId === 'string' ? ' · incident location sharing' : ' · approved location sharing'}` : '');
    text('#sharing-detail', statusDetail);
    const supported = window.isSecureContext && !!navigator.geolocation;
    $('#start-sharing').disabled = !validGrant || !grant || !supported || locationView?.configured !== true || document.hidden || disposed || stopping || stopFailed || watchId !== null;
    text('#start-sharing', state === 'paused' ? 'Resume sharing' : 'Share my location');
    $('#stop-sharing').disabled = !validGrant || !grant || stopping || disposed;
    text('#stop-sharing', stopFailed ? 'Retry stop' : stopping ? 'Stopping…' : 'Stop browser sharing');
    $('#travel-mode').disabled = !validGrant || stopping || stopFailed || disposed;
    $('#retry-access').hidden = !grant || validGrant || stopping || disposed;
    renderLocations();
  }

  function pointAge(point) {
    return finite(point?.ageMs) && point.ageMs >= 0 ? point.ageMs + (viewReceivedAt === null ? 0 : Math.max(0, Date.now() - viewReceivedAt)) : null;
  }
  function renderLocations() {
    for (const role of ['wearer', 'responder']) {
      const point = locationView?.[role], valid = validPoint(point), age = pointAge(point);
      const fresh = valid && point.fresh === true && age !== null && age <= 60000;
      text(`#${role}-name`, typeof point?.name === 'string' && point.name.trim() ? point.name : role === 'wearer' ? 'Patient' : 'Responder');
      text(`#${role}-position`, valid ? `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}` : 'Not shared');
      const accuracy = finite(point?.accuracy) && point.accuracy >= 0 ? `accuracy ±${Math.ceil(point.accuracy)} m` : 'accuracy unknown';
      const sources = { 'browser-geolocation': 'Browser location', 'photon-find-my': 'Photon Find My' };
      const source = typeof point?.source === 'string' && Object.hasOwn(sources, point.source) ? sources[point.source] : 'Location source unavailable';
      text(`#${role}-meta`, valid ? `${fresh ? 'Fresh' : 'Last shared'} · ${age === null ? 'age unavailable' : `${Math.floor(age / 1000)} s old`} · ${accuracy} · ${source}` : 'No shared location received.');
      const map = $(`#${role}-map`); map.hidden = !valid;
      if (valid) map.href = `https://maps.apple.com/?ll=${point.latitude},${point.longitude}&q=${encodeURIComponent(role === 'wearer' ? 'Wearer location' : 'Responder location')}`;
      else map.removeAttribute('href');
    }
    const nativeShared = ['wearer', 'responder'].some(role => validPoint(locationView?.[role]) && locationView[role].source === 'photon-find-my');
    text('#sharing-scope', nativeShared ? 'Stop controls browser sharing only. Stop Find My sharing in Messages.' : 'Browser location requires permission. Stop controls browser sharing only.');
    const eta = locationView?.eta;
    const usable = validGrant && ['wearer', 'responder'].every(role => validPoint(locationView?.[role]) && locationView[role].fresh === true
      && pointAge(locationView[role]) !== null && pointAge(locationView[role]) <= 60000
      && finite(locationView[role].accuracy) && locationView[role].accuracy >= 0 && locationView[role].accuracy <= 100)
      && finite(eta?.seconds) && eta.seconds >= 0 && finite(eta.distanceMeters) && eta.distanceMeters >= 0
      && ['apple-maps-walking', 'straight-line-walking-estimate'].includes(eta.method);
    const minutes = usable ? eta.seconds < 60 ? '<1 min' : `${Math.ceil(eta.seconds / 60)} min` : '';
    const distance = usable ? eta.distanceMeters < 1000 ? `${Math.round(eta.distanceMeters)} m` : `${(eta.distanceMeters / 1000).toFixed(1)} km` : '';
    text('#approach-eta', usable ? `${eta.method === 'apple-maps-walking' ? 'Walk' : 'Approx. walk'} · ${minutes} · ${distance}` : 'Waiting for two fresh, accurate locations');
    const updated = finite(eta?.updatedAt) ? new Date(eta.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'time unavailable';
    text('#approach-detail', usable ? eta.method === 'apple-maps-walking' ? `Apple Maps estimate · updated ${updated}. Location does not confirm arrival.`
      : 'Straight-line estimate; routes and indoor access may take longer. Location does not confirm arrival.' : 'Both people need a fresh location with accuracy within 100 m.');
  }

  function invalidateAccess(message) {
    clearWatch(); cancelRequests(); stopPolling(); grant = null; validGrant = false; access = null; locationView = null; viewReceivedAt = null;
    state = 'unavailable'; statusDetail = message; showError(message); render();
  }
  function accessError(status) {
    return status === 410 ? 'This invitation has expired. Request a new location invitation.'
      : 'This invitation is no longer valid. Open a new location invitation from LIFELINE.';
  }
  async function loadAccess() {
    if (!grant || disposed || document.hidden || getRequest || stopping || stopFailed || postRequest) return;
    const request = { grant, generation, controller: new AbortController() }; getRequest = request;
    const current = () => getRequest === request && grant === request.grant && generation === request.generation && !disposed && !document.hidden;
    try {
      const response = await fetch('/api/location/share', { headers: { Authorization: `Bearer ${request.grant}` }, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
        signal: AbortSignal.any([request.controller.signal, AbortSignal.timeout(10000)]) });
      if (!current()) return;
      if ([401, 403, 410].includes(response.status)) { invalidateAccess(accessError(response.status)); return; }
      if (!response.ok) throw new Error('Location sharing is temporarily unavailable. Retry the connection.');
      const result = await response.json(); if (!current()) return;
      if (!['wearer', 'responder'].includes(result.role) || typeof result.name !== 'string' || !result.location || typeof result.location.configured !== 'boolean')
        throw new Error('The invitation could not be verified. Retry the connection.');
      if (access && (result.role !== access.role || result.incidentId !== access.incidentId)) { invalidateAccess('This invitation has changed. Open a new location invitation.'); return; }
      access = { role: result.role, name: result.name, incidentId: result.incidentId };
      locationView = result.location; viewReceivedAt = Date.now(); validGrant = true;
      if (state === 'idle' || state === 'unavailable') {
        state = 'idle';
        statusDetail = !window.isSecureContext ? 'Location sharing requires HTTPS. Open this invitation in a secure browser.'
          : !navigator.geolocation ? 'This browser does not support location sharing. Open the invitation in another browser.'
          : !locationView.configured ? 'Location sharing is not available right now. You can revoke this invitation with Stop.'
            : access.role === 'wearer' ? 'Tap Share to allow this browser to share with LIFELINE and your approved responder.' : 'Tap Share to show your approach to the patient and LIFELINE.';
      }
      showError(''); render(); startPolling();
    } catch (error) {
      if (!current() || error.name === 'AbortError') return;
      showError(error.name === 'TimeoutError' ? 'The connection timed out. Retry while keeping this page open.' : 'Could not connect to location sharing. Check your connection and retry.');
      if (!validGrant) state = 'unavailable'; render();
    } finally { if (getRequest === request) getRequest = null; }
  }

  function schedulePosition() {
    if (!pendingPosition || watchId === null || disposed || document.hidden || stopping || stopFailed || !validGrant || !grant) return;
    clearTimeout(sendTimer);
    const delay = lastSubmitAt ? Math.max(0, 5000 - (Date.now() - lastSubmitAt)) : 0;
    if (delay === 0 && !postRequest) void submitPosition();
    else sendTimer = setTimeout(() => { sendTimer = null; if (!postRequest) void submitPosition(); }, Math.max(1, delay));
  }
  async function submitPosition() {
    if (!pendingPosition || postRequest || watchId === null || !validGrant || !grant || disposed || document.hidden || stopping || stopFailed) return;
    const position = pendingPosition; pendingPosition = null;
    getRequest?.controller.abort(); getRequest = null;
    const request = { grant, generation, watchEpoch, controller: new AbortController() }; postRequest = request;
    const current = () => postRequest === request && grant === request.grant && generation === request.generation && watchEpoch === request.watchEpoch && !disposed && !document.hidden;
    lastSubmitAt = Date.now(); lastSequence = Math.max(lastSequence + 1, lastSubmitAt);
    try {
      const mode = $('#travel-mode').value === 'driving' ? 'driving' : 'walking';
      const response = await fetch('/api/location/share', { method: 'POST', headers: { Authorization: `Bearer ${request.grant}`, 'Content-Type': 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer',
        body: JSON.stringify({ ...position, sequence: lastSequence, mode }), signal: AbortSignal.any([request.controller.signal, AbortSignal.timeout(10000)]) });
      if (!current()) return;
      if ([401, 403, 410].includes(response.status)) { invalidateAccess(accessError(response.status)); return; }
      if (!response.ok) throw new Error('Could not update the shared location.');
      const result = await response.json(); if (!current()) return;
      if (result.ok !== true || !result.location || typeof result.location.configured !== 'boolean') throw new Error('Location update was not confirmed.');
      locationView = result.location; viewReceivedAt = Date.now(); state = 'sharing'; statusDetail = 'Sharing while this page is visible. Your latest accepted location appears below.';
      showError(''); render();
    } catch (error) {
      if (!current() || error.name === 'AbortError') return;
      state = 'waiting'; statusDetail = 'Location was captured; its server update is unconfirmed.';
      showError(error.name === 'TimeoutError' ? 'The update timed out. Keep the page open and check the last shared location.' : 'Could not update your location. Check your connection and keep this page open.'); render();
    } finally { if (postRequest === request) { postRequest = null; schedulePosition(); } }
  }

  function startSharing() {
    render(); if ($('#start-sharing').disabled) return;
    showError(''); state = 'waiting'; statusDetail = 'Waiting for browser permission and an actual location fix.';
    const epoch = ++watchEpoch;
    try {
      watchId = navigator.geolocation.watchPosition(position => {
        if (watchEpoch !== epoch || watchId === null || disposed || document.hidden || stopping || stopFailed) return;
        const coordinates = position.coords;
        if (!validPoint(coordinates) || !finite(coordinates.accuracy) || coordinates.accuracy < 0 || !finite(position.timestamp) || position.timestamp < 0) {
          showError('The browser has not provided a usable location yet. Keep this page open.'); return;
        }
        lastPosition = { latitude: coordinates.latitude, longitude: coordinates.longitude, accuracy: coordinates.accuracy, timestamp: position.timestamp };
        pendingPosition = lastPosition; schedulePosition();
      }, error => {
        if (watchEpoch !== epoch || disposed || document.hidden || stopping || stopFailed) return;
        if (error.code === 1) { void stopSharing('Browser location permission was denied. Browser sharing stopped; request a new browser invitation after allowing location.'); return; }
        state = 'waiting'; statusDetail = 'Waiting for a browser location fix.';
        showError(error.code === 3 ? 'Location timed out. Check Location Services and keep this page open.' : 'Your location is unavailable. Check browser permissions and Location Services.'); render();
      }, { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 });
      render();
    } catch { void stopSharing('The browser could not start location sharing. Request a new invitation in a supported browser.'); }
  }

  async function stopSharing(reason = 'Browser sharing stopped. This browser invitation has been revoked. Find My sharing is managed in Messages.') {
    if (!grant || stopping || disposed) return;
    const requestGrant = grant;
    clearWatch(); cancelRequests(); stopPolling(); lastPosition = null; locationView = null; viewReceivedAt = null;
    stopping = true; stopFailed = false; state = 'stopping'; statusDetail = 'Browser location collection has stopped. Revoking the browser invitation…'; showError(''); render();
    const request = { grant: requestGrant, controller: new AbortController() }; stopRequest = request;
    const current = () => stopRequest === request && grant === requestGrant;
    try {
      const response = await fetch('/api/location/share', { method: 'DELETE', headers: { Authorization: `Bearer ${requestGrant}` }, credentials: 'omit', referrerPolicy: 'no-referrer',
        signal: AbortSignal.any([request.controller.signal, AbortSignal.timeout(10000)]) });
      if (!current()) return;
      if (!response.ok && ![401, 403, 410].includes(response.status)) throw new Error('Revocation unconfirmed.');
      grant = null; validGrant = false; access = null; state = 'stopped'; statusDetail = reason;
    } catch {
      if (!current()) return;
      stopFailed = true; state = 'stopped'; statusDetail = 'Browser location collection has stopped; browser invitation revocation is unconfirmed.';
      showError('Could not revoke the invitation. Reconnect and tap Retry stop.');
    } finally { if (stopRequest === request) { stopRequest = null; stopping = false; if (!disposed && !document.hidden) render(); } }
  }

  function pauseSharing() {
    const wasWatching = watchId !== null;
    clearWatch(); cancelRequests(); stopPolling();
    if (wasWatching) { state = 'paused'; statusDetail = 'Sharing paused while the page is hidden. Tap Resume when you return.'; }
    render();
  }
  $('#start-sharing').addEventListener('click', startSharing);
  $('#stop-sharing').addEventListener('click', () => { void stopSharing(); });
  $('#retry-access').addEventListener('click', () => { void loadAccess(); });
  $('#travel-mode').addEventListener('change', () => {
    if (watchId !== null && lastPosition && Date.now() - lastPosition.timestamp < 10000) { pendingPosition = lastPosition; schedulePosition(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseSharing();
    else if (!disposed) { render(); void loadAccess(); startPolling(); }
  });
  window.addEventListener('pagehide', () => { pauseSharing(); disposed = true; });
  window.addEventListener('pageshow', () => { if (disposed) { disposed = false; render(); void loadAccess(); startPolling(); } });
  window.addEventListener('hashchange', () => {
    clearWatch(); cancelRequests(); stopPolling(); stopRequest?.controller.abort(); stopRequest = null;
    grant = readGrant(); validGrant = false; access = null; locationView = null; viewReceivedAt = null;
    stopping = false; stopFailed = false; state = 'idle'; lastPosition = null; lastSubmitAt = 0;
    statusDetail = 'You choose when to share. You can stop at any time.'; showError(''); render(); if (grant) void loadAccess();
  });
  render();
  if (grant) void loadAccess();
  else { state = 'unavailable'; statusDetail = 'Open the full location invitation from your message. A sharing link is required.'; render(); }
  setInterval(renderLocations, 1000);
})();
