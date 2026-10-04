const $ = id => document.getElementById(id);
let token = '', view = null, busy = false, refreshing = false, actionError = '';
const names = { 'controlled-descent': 'Controlled descent', 'fall-like-movement': 'Fall-like movement', shaking: 'Shaking',
  walking: 'Walking', sitting: 'Sitting', bending: 'Bending', 'device-adjustment': 'Device adjustment', standing: 'Standing' };
function render() {
  if (!view) return;
  const latest = view.examples[0];
  $('teach-record').disabled = busy || view.recording;
  $('teach-label').disabled = busy || view.recording || !latest;
  $('teach-save').disabled = busy || view.recording || !latest || !$('teach-label').value;
  $('teach-resume').disabled = busy || !view.practiceMode;
  $('teach-status').textContent = actionError || view.error || (view.recording ? `Recording · ${Math.ceil(view.remainingMs / 1000)} seconds left. Perform your movement.`
    : view.practiceMode ? 'Movement saved. Choose its label, record another, or resume monitoring.' : 'Monitoring active. Ready to record a movement.');
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
  actionError = ''; busy = true; render();
  try { await request(body); if (body.action === 'start') $('teach-label').value = ''; }
  catch (error) { actionError = error.message; $('teach-status').textContent = actionError; }
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
  if (busy || refreshing || $('teaching').hidden) return;
  refreshing = true;
  try {
    if (!token) { const setup = await (await fetch('/api/setup', { signal: AbortSignal.timeout(5000) })).json(); token = setup.token || ''; }
    if (!token) throw new Error('Use the local workspace to record movements.');
    await request();
  } catch (error) { $('teach-status').textContent = error.message; }
  finally { refreshing = false; }
}
window.addEventListener('hashchange', refresh);
setInterval(refresh, 1000); void refresh();

async function switchPhoneRole(role) {
  const status=$('role-state');
  try {
    if(!token) { const setup=await(await fetch('/api/setup',{signal:AbortSignal.timeout(5000)})).json(); token=setup.token||''; }
    const state=await(await fetch('/api/state',{signal:AbortSignal.timeout(5000)})).json();
    const responder=state.responders.find(r=>r.name==='Maya')||state.responders[0];
    const response=await fetch('/api/rehearsal/role',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({role,incidentId:state.incident?.id,responderId:responder?.id}),signal:AbortSignal.timeout(5000)});
    const result=await response.json(); if(!response.ok)throw new Error(result.error||'Role switch unavailable.');
    status.textContent=result.role ? 'Phone role: Maya. Reply “on it”, ask a medical question, then “on my way”. Reset or return to Morgan when finished.' : 'Phone role: Morgan. Normal two-phone routing restored.';
  }catch(error){status.textContent=error.message;}
}
$('role-patient').addEventListener('click',()=>switchPhoneRole('patient'));
$('role-responder').addEventListener('click',()=>switchPhoneRole('responder'));

async function refreshPhoneRole() {
  if(!token || $('teaching').hidden)return;
  try {
    const response=await fetch('/api/rehearsal/role',{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(5000)});
    if(!response.ok)return;
    const result=await response.json();
    $('role-state').textContent=result.role ? 'Phone role: Maya. Reply “on it”, ask about health, then “on my way”. This is an operator rehearsal.' : 'Phone role: Morgan. Switch to Maya after help is requested.';
  } catch { /* Existing explicit role status remains visible during temporary disconnects. */ }
}
setInterval(refreshPhoneRole,3000);void refreshPhoneRole();
