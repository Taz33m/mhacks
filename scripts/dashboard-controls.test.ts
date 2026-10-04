import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Exercise the actual small control/label functions with generated state only.
// Loading app.js itself would initialize a live browser connection.
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const labelCode = source.slice(source.indexOf('  const reportSource ='), source.indexOf('\n  function incidentMessages('));
const reportSource = runInNewContext(`${labelCode}\nreportSource;`) as (source: unknown, service?: unknown) => string;
const controlCode = source.slice(source.indexOf('  function updateControls() {'), source.indexOf('\n  function setToken('));

function controls(phase: string, changes: { ownerId?: string | null; dispatchMode?: string; online?: boolean; token?: string } = {}) {
  const nodes = new Map<string, { value: string; disabled: boolean; hidden: boolean; textContent: string }>();
  const node = (selector: string) => {
    if (!nodes.has(selector)) nodes.set(selector, { value: selector === '#responder' ? 'fixture-owner' : 'Generated valid fixture input', disabled: false, hidden: false, textContent: '' });
    return nodes.get(selector)!;
  };
  const incident = { id: 'LF-GENERATED-CONTROL', phase, ownerId: changes.ownerId === undefined ? 'fixture-owner' : changes.ownerId,
    dispatchMode: changes.dispatchMode || 'live' };
  const noop = () => {};
  runInNewContext(`${controlCode}\nupdateControls();`, {
    $: node, token: changes.token === undefined ? 'generated-local-test-token' : changes.token, busy: false, online: changes.online !== false,
    snapshot: { incident, responders: [{ id: 'fixture-owner', name: 'Generated owner', phone: null }], trial: null },
    calibrationGuide: null, trialBusy: false,
    terminal: (i: typeof incident) => ['RESOLVED', 'CANCELLED_FALSE_ALARM'].includes(i.phase),
    simulatedIncident: (i: typeof incident) => i.dispatchMode === 'simulated',
    updateRehearsalControls: noop, updatePatientControls: noop, updateWellbeingControls: noop, updateLocationControls: noop,
  });
  return node;
}

test('an authorized owner can report direct arrival after acceptance or departure, without fabricating departure', () => {
  for (const phase of ['ACKNOWLEDGED', 'RESPONDER_EN_ROUTE']) assert.equal(controls(phase)('#arrive').disabled, false, phase);
  for (const phase of ['DETECTED', 'CONFIRMING', 'HELP_REQUESTED', 'ON_SCENE', 'RESOLVED', 'CANCELLED_FALSE_ALARM'])
    assert.equal(controls(phase)('#arrive').disabled, true, phase);
});

test('direct arrival retains owner, authorization, connection and automatic-dispatch boundaries', () => {
  for (const changes of [{ ownerId: null }, { ownerId: 'different-generated-owner' }, { online: false }, { token: '' }, { dispatchMode: 'simulated' }])
    assert.equal(controls('ACKNOWLEDGED', changes)('#arrive').disabled, true, JSON.stringify(changes));
  assert.equal(controls('ACKNOWLEDGED', { dispatchMode: 'simulated' })('#manual-responder-controls').hidden, true);
});

test('unknown Photon service never implies iMessage, while explicitly supplied transports remain visible', () => {
  for (const service of [undefined, null, '', 'unknown', 'imessage', 'constructor', '<img src=x>'])
    assert.equal(reportSource('photon-imessage', service), 'Photon message');
  for (const service of ['iMessage', 'SMS', 'RCS']) assert.equal(reportSource('photon-imessage', service), `Photon ${service}`);
  assert.equal(reportSource('freewili-local-speech', 'iMessage'), 'WILi voice');
  assert.equal(reportSource('simulated-dispatch'), 'Local responder');
  for (const source of [undefined, '__proto__', 'constructor', '<svg onload=alert(1)>']) assert.equal(reportSource(source), 'Recorded report');
});
