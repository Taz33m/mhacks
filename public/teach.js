const $ = id => document.getElementById(id);
let token = '', view = null, busy = false;
const names = { 'controlled-descent': 'Controlled descent', 'fall-like-movement': 'Fall-like movement', shaking: 'Shaking',
  walking: 'Walking', sitting: 'Sitting', bending: 'Bending', 'device-adjustment': 'Device adjustment', standing: 'Standing' };
function render() {
  if (!view) return;
  const latest = view.examples[0];
  $('teach-record').disabled = busy || view.recording;
  $('teach-label').disabled = busy || view.recording || !latest;
  $('teach-save').disabled = busy || view.recording || !latest || !$('teach-label').value;
  $('teach-resume').disabled = busy || !view.practiceMode;
  $('teach-status').textContent = view.recording ? `Recording · ${Math.ceil(view.remainingMs / 1000)} seconds left. Perform your movement.`
    : view.practiceMode ? 'Movement saved. Choose its label, record another, or resume monitoring.' : 'Monitoring active. Ready to record a movement.';
  $('teach-count').textContent = `${view.examples.filter(e => e.label).length} labelled · ${view.examples.filter(e => !e.label).length} awaiting labels`;
  $('teach-examples').replaceChildren(...view.examples.map(e => {
    const row = document.createElement('li');
    row.textContent = `${e.label ? names[e.label] : 'Unlabelled movement'} · ${e.bodySamples} chest / ${e.waistSamples} waist samples`
      + (!e.quality.continuousBody ? ' · sparse chest data' : '') + (!e.quality.continuousWaist ? ' · incomplete waist data' : '');
    return row;
  }));
}
async function request(body) {
  const response = await fetch('/api/teaching', { method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
  if (response.status === 404) throw new Error('Recorder is installed; restart the backend after the current incident to activate it.');
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Recorder unavailable.');
  view = data; render();
}
async function action(body) {
  busy = true; render();
  try { await request(body); if (body.action === 'start') $('teach-label').value = ''; }
  catch (error) { $('teach-status').textContent = error.message; }
  finally { busy = false; if (view) {
    $('teach-record').disabled = view.recording;
    $('teach-save').disabled = view.recording || !view.examples[0] || !$('teach-label').value;
  } }
}
$('teach-calibrate').addEventListener('click', () => $('calibrate').click());
$('teach-record').addEventListener('click', () => action({ action: 'start' }));
$('teach-resume').addEventListener('click', () => action({ action: 'cancel' }));
$('teach-label').addEventListener('change', render);
$('teach-save').addEventListener('click', () => action({ action: 'label', id: view.examples[0].id, label: $('teach-label').value }));
async function refresh() {
  if (busy || $('teaching').hidden) return;
  try {
    if (!token) { const setup = await (await fetch('/api/setup')).json(); token = setup.token || ''; }
    if (!token) throw new Error('Use the local workspace to record movements.');
    await request();
  } catch (error) { $('teach-status').textContent = error.message; }
}
window.addEventListener('hashchange', refresh);
setInterval(refresh, 1000); void refresh();
