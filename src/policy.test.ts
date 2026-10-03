import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePolicy, DEMO_CHECKIN_TIMEOUT } from './policy.ts';
import { Controller } from './controller.ts';

test('normal policy defaults to 20 seconds and retains configured durations', () => {
  assert.deepEqual(parsePolicy({}), {
    demoMode: false, configuredCheckinMs: 20_000, checkinMs: 20_000,
    acceptMs: 60_000, progressMs: 120_000,
  });
  const configured = { LIFELINE_CHECKIN_MS: '30000', LIFELINE_ACCEPT_MS: '90000', LIFELINE_PROGRESS_MS: '180000' };
  for (const mode of [undefined, '0', 'true']) {
    assert.deepEqual(parsePolicy({ ...configured, LIFELINE_DEMO_MODE: mode }), {
      demoMode: false, configuredCheckinMs: 30_000, checkinMs: 30_000,
      acceptMs: 90_000, progressMs: 180_000,
    });
  }
});

test('explicit demo opt-in changes only the check-in timeout and keeps normal metadata', () => {
  assert.equal(DEMO_CHECKIN_TIMEOUT, 5);
  assert.deepEqual(parsePolicy({ LIFELINE_DEMO_MODE: '1', LIFELINE_CHECKIN_MS: '45000',
    LIFELINE_ACCEPT_MS: '80000', LIFELINE_PROGRESS_MS: '150000' }), {
    demoMode: true, configuredCheckinMs: 45_000, checkinMs: 5000,
    acceptMs: 80_000, progressMs: 150_000,
  });
  assert.equal(parsePolicy({ LIFELINE_DEMO_MODE: '1' }).configuredCheckinMs, 20_000);
});

test('demo mode still validates the configured policy instead of hiding invalid values', () => {
  for (const name of ['LIFELINE_CHECKIN_MS', 'LIFELINE_ACCEPT_MS', 'LIFELINE_PROGRESS_MS']) {
    for (const invalid of ['', 'NaN', 'Infinity', '999', '86400001'])
      assert.throws(() => parsePolicy({ LIFELINE_DEMO_MODE: '1', [name]: invalid }), new RegExp(name));
  }
});

test('demo check-in escalates exactly at five seconds using the existing controller', () => {
  let now = 1000;
  const controller = new Controller(':memory:', [{ id: 'maya', name: 'Maya', phone: null }], () => now,
    parsePolicy({ LIFELINE_DEMO_MODE: '1', LIFELINE_CHECKIN_MS: '30000' }));
  try {
    const incident = controller.trigger({ kind: 'synthetic', summary: 'Offline policy fixture' });
    assert.equal(incident.checkinDeadline, 6000);
    now = 5999; controller.tick(); assert.equal(controller.active()?.phase, 'CONFIRMING');
    now = 6000; controller.tick(); assert.equal(controller.active()?.phase, 'HELP_REQUESTED');
    assert.equal(controller.active()?.progressDeadline, 66_000, 'acceptance duration is unchanged');
    assert.throws(() => controller.cancel(incident.id, incident.checkinId), /current unresolved check-in/);
  } finally { controller.close(); }
});
