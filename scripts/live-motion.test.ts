import test from 'node:test';
import assert from 'node:assert/strict';

const { motionPresentation, liveMotion } = await import(new URL('../public/dashboard-view.js', import.meta.url).href);
const at = 1_800_000_000_000;
// Waist trace uses sensor seconds; WILi points use receipt milliseconds, matching the live payloads.
const waistTrace = [
  { at: 100, totalG: 1, angularSpeed: .1, tiltDegrees: null },
  { at: 101, totalG: 1.4, angularSpeed: 2.6, tiltDegrees: null },
  { at: 102, totalG: 1, angularSpeed: .1, tiltDegrees: null },
  { at: 107, totalG: 1, angularSpeed: .05, tiltDegrees: null },
];
const wiliPoints = [{ at: at - 20_000, totalG: 3.1 }, { at: at - 4_000, totalG: 1.92 }, { at, totalG: 1 }];
const sensors = [{ source: 'waist-airpod', connected: true, fresh: true, calibrated: false, sampleHz: 48, totalG: 1, trace: waistTrace }];
const snapshot = (incident: object | null = null) =>
  ({ serverTime: at, incident, responders: [], timeline: [], actions: [], conversation: [], sensors });
const incident = (evidence: object) => ({ id: 'LF-LIVE-FIXTURE', phase: 'HELP_REQUESTED', version: 1, createdAt: at,
  updatedAt: at, checkinDeadline: null, progressDeadline: null, ownerId: null, handoff: '', evidence });

test('idle monitoring shows the last 10 s of live readings instead of static placeholders', () => {
  const view = motionPresentation(snapshot(), true, wiliPoints);
  assert.equal(view.event, 'Monitoring');
  assert.equal(view.impact, '1.92 g peak · live', 'the 3.1 g reading is older than the window');
  assert.equal(view.rotation, '2.60 rad/s peak · live');
  assert.equal(view.quiet, '6 s still · live');
});

test('a manually started incident populates from live readings, labelled as live, never as detection', () => {
  const view = motionPresentation(snapshot(incident({ kind: 'manual', summary: 'Help requested.' })), true, wiliPoints);
  assert.equal(view.event, 'Help requested');
  for (const value of [view.impact, view.rotation, view.quiet]) assert.match(value, / · live$/);
  assert.match(view.source, /Started manually/);
});

test('a detected fall keeps the measurements captured at detection', () => {
  const view = motionPresentation(snapshot(incident({ kind: 'cross-body', summary: 'Possible fall',
    assessment: { detector: 'wili-waist-provisional-v1', impact: { totalG: 1.72 }, supportingWaist: { angularSpeed: 2.5 },
      quietWaist: { durationMs: 2400 } } })), true, wiliPoints);
  assert.deepEqual([view.impact, view.rotation, view.quiet], ['1.72 g', '2.50 rad/s', '2.4 s']);
});

test('offline or missing sensor data never invents a reading', () => {
  assert.deepEqual(liveMotion(snapshot(), wiliPoints, false), { impact: 'Not recorded', rotation: 'Not recorded', quiet: 'Not recorded' });
  const bare = { ...snapshot(), sensors: [] };
  assert.deepEqual(liveMotion(bare, []), { impact: 'Not recorded', rotation: 'Not recorded', quiet: 'Not recorded' });
  const disconnected = { ...snapshot(), sensors: [{ ...sensors[0], connected: false }] };
  assert.equal(liveMotion(disconnected, []).rotation, 'Not recorded');
});
