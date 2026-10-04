import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Location } from './location.ts';
import type { LocationInput, NativeLocationPoint, NativeLocationSubject } from './location.ts';
import type { Incident, ProviderResult } from './contracts.ts';
import { Controller } from './controller.ts';

const start = Date.parse('2026-10-04T02:00:00Z');
const incident: Incident = { id: 'LF-LOCATION', phase: 'ACKNOWLEDGED', version: 3, createdAt: start, updatedAt: start,
  evidence: { kind: 'synthetic', summary: 'Offline location test.' }, checkinId: 'checkin', checkinDeadline: start + 20_000,
  ownerId: 'maya', progressDeadline: start + 120_000, handoff: '', outcome: null, resolutionActor: null };
const wearerInput = { key: 'wearer-link', role: 'wearer' as const, name: 'Tazeem' };
const responderInput = { key: 'responder-link', role: 'responder' as const, name: 'Maya', incidentId: incident.id, responderId: 'maya' };
const nativeWearer: NativeLocationSubject = { role: 'wearer', name: 'Tazeem' };
const nativeResponder: NativeLocationSubject = { role: 'responder', name: 'Maya', incidentId: incident.id, responderId: 'maya' };
const nativePoint = (extra: Partial<NativeLocationPoint> = {}): NativeLocationPoint => ({ latitude: 42.2808, longitude: -83.7430,
  accuracy: 8, timestamp: start, receivedAt: start, sourceSequence: 0, source: 'photon-find-my', ...extra });
function setup(path = ':memory:') {
  let at = start; const l = new Location(path, { wearerName: 'Tazeem' }, () => at);
  const sample = (extra: Partial<LocationInput> = {}): LocationInput => ({ latitude: 42.2808, longitude: -83.7430, accuracy: 8,
    timestamp: at, sequence: 0, mode: 'walking', ...extra });
  return { l, sample, advance: (ms: number) => { at += ms; } };
}

test('grants use strong persistent bearers, fixed two-hour expiry and exact idempotency keys', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lifeline-location-')), path = join(directory, 'state.sqlite');
  let { l, advance } = setup(path);
  try {
    const token = l.issue(wearerInput); assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(l.issue(wearerInput), token); const grant = l.authorize(token, null)!;
    assert.equal(grant.expiresAt - grant.issuedAt, 2 * 60 * 60 * 1000);
    assert.ok(!JSON.stringify(grant).includes(token));
    assert.throws(() => l.issue({ ...responderInput, key: wearerInput.key }), /already belongs/);
    l.close(); ({ l, advance } = setup(path)); assert.equal(l.issue(wearerInput), token);
    advance(2 * 60 * 60 * 1000); assert.equal(l.authorize(token, null), null);
    assert.equal(l.issue(wearerInput), token, 'retry does not silently extend an expired consent grant');
    assert.notEqual(l.issue({ ...wearerInput, key: 'new-consent' }), token);
  } finally { l.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('responder grants are incident-bound and owner-bound while wearer consent works standalone', () => {
  const { l } = setup();
  try {
    const wearer = l.issue(wearerInput), responder = l.issue(responderInput);
    assert.ok(l.authorize(wearer, null)); assert.equal(l.authorize(responder, null), null);
    assert.ok(l.authorize(responder, { ...incident, ownerId: null })); assert.ok(l.authorize(responder, incident));
    for (const active of [{ ...incident, id: 'LF-OLD' }, { ...incident, ownerId: 'jordan' }, { ...incident, phase: 'RESOLVED' as const },
      { ...incident, phase: 'CANCELLED_FALSE_ALARM' as const }]) assert.equal(l.authorize(responder, active), null);
    for (const invalid of ['', 'x'.repeat(64), wearer.toUpperCase(), 'other']) assert.equal(l.authorize(invalid, incident), null);
    assert.throws(() => l.issue({ key: 'missing-responder', role: 'responder', name: 'Maya' }), /Invalid/);
  } finally { l.close(); }
});

test('browser measurements validate numeric ranges, capture age, future clock and strict sequence without coercion', () => {
  const { l, sample } = setup(); const token = l.issue(wearerInput);
  try {
    for (const invalid of [{ latitude: 90.001 }, { longitude: -180.001 }, { accuracy: 1000.01 }, { accuracy: -1 },
      { latitude: NaN }, { longitude: Infinity }, { timestamp: start - 120_001 }, { timestamp: start + 10_001 },
      { sequence: -1 }, { sequence: 1.5 }, { mode: 'flying' }, { latitude: '42' }, { source: 'invented' }])
      assert.equal(l.update(token, { ...sample(), ...invalid } as LocationInput, null), false);
    assert.equal(l.view(null).wearer, null);
    assert.equal(l.update(token, sample({ accuracy: 1000, timestamp: start - 120_000 }), null), true);
    assert.equal(l.view(null).wearer!.fresh, false);
    assert.equal(l.update(token, sample(), null), false, 'same sequence is replayed even with a newer capture timestamp');
    assert.equal(l.update(token, sample({ sequence: 1, timestamp: start + 10_000, latitude: -90, longitude: 180, accuracy: 0 }), null), true);
    assert.equal(l.view(null).wearer!.ageMs, 0); assert.equal(l.view(null).wearer!.source, 'browser-geolocation');
    assert.equal(l.update(token, sample({ sequence: 0 }), null), false);
  } finally { l.close(); }
});

test('the replay guard and last actual position persist across a database restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lifeline-location-replay-')), path = join(directory, 'state.sqlite');
  let f = setup(path);
  try {
    const token = f.l.issue(wearerInput); assert.equal(f.l.update(token, f.sample({ sequence: 5 }), null), true); f.l.close();
    f = setup(path); assert.equal(f.l.update(token, f.sample({ sequence: 5 }), null), false);
    assert.equal(f.l.update(token, f.sample({ sequence: 6, latitude: 42.29 }), null), true);
    assert.equal(f.l.view(null).wearer!.latitude, 42.29);
  } finally { f.l.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('only the accepted owner is exposed; fresh accurate walking data gets an honest straight-line estimate', () => {
  const { l, sample, advance } = setup();
  try {
    const wearer = l.issue(wearerInput), maya = l.issue(responderInput), jordan = l.issue({ ...responderInput, key: 'jordan-link', responderId: 'jordan', name: 'Jordan' });
    assert.equal(l.update(wearer, sample(), null), true);
    assert.equal(l.update(maya, sample({ longitude: -83.7440 }), { ...incident, ownerId: null }), true);
    assert.equal(l.update(jordan, sample({ longitude: -83.7450 }), { ...incident, ownerId: null }), true);
    assert.equal(l.view({ ...incident, ownerId: null }).responder, null); assert.equal(l.view({ ...incident, ownerId: null }).eta, null);
    const view = l.view(incident); assert.equal(view.responder!.name, 'Maya'); assert.equal(view.wearer!.name, 'Tazeem');
    assert.equal(view.eta!.method, 'straight-line-walking-estimate');
    assert.ok(view.eta!.distanceMeters > 80 && view.eta!.distanceMeters < 85);
    assert.equal(view.eta!.seconds, Math.ceil(view.eta!.distanceMeters / 1.2)); assert.match(view.detail, /not a road route or confirmed arrival/);
    assert.equal(l.view({ ...incident, ownerId: 'jordan' }).responder!.name, 'Jordan');
    assert.equal(l.view({ ...incident, phase: 'RESOLVED' }).responder, null);
    advance(60_000); assert.equal(l.view(incident).wearer!.fresh, true); advance(1);
    assert.equal(l.view(incident).wearer!.fresh, false); assert.equal(l.view(incident).eta, null);
    for (const secret of [wearer, maya, jordan, 'responder-link', 'providerMessageId']) assert.ok(!JSON.stringify(view).includes(secret));
  } finally { l.close(); }
});

test('poor accuracy or driving mode never generates a walking ETA, even with both positions present', () => {
  for (const extra of [{ accuracy: 100.01 }, { mode: 'driving' as const }]) {
    const { l, sample } = setup();
    try {
      const wearer = l.issue(wearerInput), responder = l.issue(responderInput);
      l.update(wearer, sample(), null); l.update(responder, sample({ longitude: -83.744, ...extra }), incident);
      assert.equal(l.view(incident).eta, null); assert.ok(l.view(incident).responder);
      l.update(responder, sample({ sequence: 1, longitude: -83.744 }), incident);
      l.update(wearer, sample({ sequence: 1, ...extra }), null); assert.equal(l.view(incident).eta, null);
    } finally { l.close(); }
  }
});

test('newest wearer updates win same-millisecond ties and stop cannot fall back to an older consent link', () => {
  const { l, sample } = setup();
  try {
    const older = l.issue(wearerInput), newer = l.issue({ ...wearerInput, key: 'second-wearer-link' });
    l.update(older, sample(), null); l.update(newer, sample({ latitude: 42.3 }), null);
    assert.equal(l.view(null).wearer!.latitude, 42.3);
    l.update(older, sample({ sequence: 1, latitude: 42.4 }), null); assert.equal(l.view(null).wearer!.latitude, 42.4);
    assert.equal(l.stop(older, null), true); assert.equal(l.view(null).wearer, null);
    assert.equal(l.authorize(older, null), null); assert.equal(l.authorize(newer, null), null);
    assert.equal(l.update(newer, sample({ sequence: 1 }), null), false);
    assert.equal(l.stop(older, null), false);
  } finally { l.close(); }
});

test('revocation and expiry hide coordinates while stopping one responder leaves other subjects untouched', () => {
  const { l, sample, advance } = setup();
  try {
    const wearer = l.issue(wearerInput), responder = l.issue(responderInput);
    l.update(wearer, sample(), null); l.update(responder, sample(), incident);
    assert.equal(l.stop(responder, incident), true); assert.equal(l.view(incident).responder, null); assert.ok(l.view(incident).wearer);
    advance(2 * 60 * 60 * 1000); assert.equal(l.view(null).wearer, null); assert.equal(l.update(wearer, sample({ sequence: 1 }), null), false);
  } finally { l.close(); }
});

test('invitation submission persists UNKNOWN after interruption, never auto-retries, and hides tokens and native IDs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lifeline-location-invite-')), path = join(directory, 'state.sqlite');
  let f = setup(path);
  try {
    const token = f.l.issue(wearerInput), text = `Share your position: https://lifeline.example/location#${token}`;
    assert.equal(f.l.queueInvite(text), true); assert.equal(f.l.queueInvite('Another simultaneous invitation.'), false);
    const invite = f.l.claimInvite()!; assert.equal(invite.text, text); assert.equal(f.l.claimInvite(), null); f.l.close();
    f = setup(path); assert.equal(f.l.inviteStatus()!.status, 'unknown'); assert.equal(f.l.claimInvite(), null);
    assert.equal(f.l.queueInvite(text), false, 'identical unknown invite cannot be requeued as a new automatic attempt');
    f.l.finishInvite(invite.id, { status: 'provider_accepted', messageId: 'cannot-rewrite-unknown', detail: token });
    assert.equal(f.l.inviteStatus()!.status, 'unknown');
    assert.equal(f.l.queueInvite('A distinct, explicitly requested fresh invitation.'), true);
    const fresh = f.l.claimInvite()!;
    f.l.finishInvite(fresh.id, { status: 'provider_accepted', messageId: 'private-message', chatId: 'private-chat', lineId: 'private-line', detail: `Private token ${token}` });
    const visible = JSON.stringify(f.l.view(null));
    for (const secret of [token, 'private-message', 'private-chat', 'private-line']) assert.ok(!visible.includes(secret));
    assert.equal(f.l.inviteStatus()!.status, 'provider_accepted'); assert.match(f.l.inviteStatus()!.detail, /delivery is unverified/);
  } finally { f.l.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('missing provider IDs and submitted uncertainty stay UNKNOWN; definite failures are not retried', () => {
  for (const result of [{ status: 'provider_accepted', detail: 'No ID.' }, { status: 'unknown', detail: 'Uncertain.' },
    { status: 'failed', detail: 'Definite failure.' }, { status: 'cancelled', detail: 'Authorization ended.' }] as ProviderResult[]) {
    const { l } = setup();
    try {
      l.queueInvite('Offline explicit location invitation.'); const invite = l.claimInvite()!; l.finishInvite(invite.id, result);
      assert.equal(l.claimInvite(), null);
      assert.equal(l.inviteStatus()!.status, result.status === 'provider_accepted' ? 'unknown' : result.status);
    } finally { l.close(); }
  }
});

test('location storage can share the incident database without changing ownership, phase or resolution', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lifeline-location-shared-')), path = join(directory, 'state.sqlite');
  const c = new Controller(path, [{ id: 'maya', name: 'Maya', phone: null }]), f = setup(path);
  try {
    const i = c.trigger({ kind: 'manual', summary: 'Offline independent incident.' }); c.accept(i.id, 'maya');
    const before = JSON.stringify(c.active()), events = c.events(i.id).length;
    const wearer = f.l.issue(wearerInput), responder = f.l.issue({ ...responderInput, incidentId: i.id });
    f.l.update(wearer, f.sample(), c.active()); f.l.update(responder, f.sample(), c.active());
    assert.equal(f.l.recordNative(nativeWearer, nativePoint(), c.active()), true);
    assert.equal(f.l.recordNative({ ...nativeResponder, incidentId: i.id }, nativePoint(), c.active()), true);
    assert.equal(f.l.view(c.active()).eta!.seconds, 0, 'zero distance is an estimate, not an arrival transition');
    assert.equal(JSON.stringify(c.active()), before); assert.equal(c.events(i.id).length, events); assert.equal(c.active()!.phase, 'ACKNOWLEDGED');
  } finally { f.l.close(); c.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('trusted native measurements persist with Find My provenance without creating browser consent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lifeline-native-location-')), path = join(directory, 'state.sqlite');
  let f = setup(path);
  try {
    assert.equal(f.l.recordNative(nativeWearer, nativePoint(), null), true);
    const point = f.l.view(null).wearer!;
    assert.equal(point.source, 'photon-find-my'); assert.equal(point.name, 'Tazeem'); assert.equal(point.fresh, true);
    assert.equal(f.l.authorize('0'.repeat(64), null), null);
    assert.equal(f.l.stop('0'.repeat(64), null), false); assert.ok(f.l.view(null).wearer);
    for (const key of ['sourceSequence', 'expiresAt', 'subject_key', 'token']) assert.ok(!JSON.stringify(point).includes(key));
    f.l.close(); f = setup(path);
    assert.equal(f.l.view(null).wearer!.source, 'photon-find-my');
    assert.equal(f.l.recordNative(nativeWearer, nativePoint(), null), false, 'native replay guard survives restart');
  } finally { f.l.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('native ingestion validates captured time, bounds and actual source without coercion', () => {
  const { l } = setup();
  try {
    for (const invalid of [{ latitude: 90.001 }, { longitude: -180.001 }, { accuracy: 1000.01 }, { accuracy: -1 },
      { latitude: NaN }, { longitude: Infinity }, { accuracy: '8' }, { timestamp: start - 7_200_001 },
      { timestamp: start + 10_001 }, { receivedAt: start + 10_001 }, { receivedAt: NaN }, { sourceSequence: -1 },
      { sourceSequence: 1.5 }, { expiresAt: start }, { expiresAt: Infinity }, { source: 'browser-geolocation' }, { mode: 'walking' }]) {
      assert.equal(l.recordNative(nativeWearer, { ...nativePoint(), ...invalid } as NativeLocationPoint, null), false);
    }
    assert.equal(l.view(null).wearer, null);
    assert.equal(l.recordNative(nativeWearer, nativePoint({ latitude: -90, longitude: 180, accuracy: 1000,
      timestamp: start + 10_000 }), null), true);
    assert.equal(l.recordNative({ ...nativeWearer, role: 'invented' } as unknown as NativeLocationSubject, nativePoint(), null), false);
    assert.equal(l.recordNative({ ...nativeWearer, name: '\u0000' }, nativePoint(), null), false);
  } finally { l.close(); }
});

test('native capture order is monotonic; a newer capture permits a restarted local sequence', () => {
  const { l, advance } = setup();
  try {
    assert.equal(l.recordNative(nativeWearer, nativePoint({ sourceSequence: 9 }), null), true);
    assert.equal(l.recordNative(nativeWearer, nativePoint({ sourceSequence: 9, latitude: 42.4 }), null), false);
    assert.equal(l.recordNative(nativeWearer, nativePoint({ sourceSequence: 8 }), null), false);
    assert.equal(l.recordNative(nativeWearer, nativePoint({ sourceSequence: 10 }), null), true);
    assert.equal(l.recordNative(nativeWearer, nativePoint({ timestamp: start - 1, sourceSequence: 99 }), null), false);
    advance(1000);
    assert.equal(l.recordNative(nativeWearer, nativePoint({ timestamp: start + 1000, receivedAt: start + 1000,
      sourceSequence: 0, latitude: 42.3 }), null), true);
    assert.equal(l.view(null).wearer!.latitude, 42.3);
    l.clearNative(nativeWearer); assert.equal(l.view(null).wearer, null);
    assert.equal(l.recordNative(nativeWearer, nativePoint({ timestamp: start + 1000, receivedAt: start + 1000,
      sourceSequence: 0 }), null), false, 'an explicitly removed cached sample cannot reappear');
  } finally { l.close(); }
});

test('native freshness uses capture time; a cached receipt and unknown accuracy do not enable ETA', () => {
  const { l, advance } = setup();
  try {
    assert.equal(l.recordNative(nativeWearer, nativePoint({ timestamp: start - 90_000, receivedAt: start }), null), true);
    assert.equal(l.recordNative(nativeResponder, nativePoint({ longitude: -83.744 }), incident), true);
    let view = l.view(incident); assert.equal(view.wearer!.ageMs, 90_000); assert.equal(view.wearer!.fresh, false); assert.equal(view.eta, null);
    assert.equal(l.recordNative(nativeWearer, nativePoint({ accuracy: null }), null), true);
    view = l.view(incident); assert.equal(view.wearer!.accuracy, null); assert.equal(view.wearer!.fresh, true); assert.equal(view.eta, null);
    assert.equal(l.recordNative(nativeWearer, nativePoint({ sourceSequence: 1, accuracy: 8 }), null), true);
    assert.ok(l.view(incident).eta);
    assert.equal(l.recordNative(nativeResponder, nativePoint({ sourceSequence: 1, accuracy: null }), incident), true);
    assert.equal(l.view(incident).eta, null, 'unknown responder accuracy also excludes an estimate');
    advance(60_001); assert.equal(l.view(incident).wearer!.fresh, false);
  } finally { l.close(); }
});

test('native responder ingestion and public positions respect the exact active incident and current owner', () => {
  const { l } = setup();
  try {
    const unowned = { ...incident, ownerId: null };
    assert.equal(l.recordNative(nativeResponder, nativePoint(), unowned), true);
    assert.equal(l.view(unowned).responder, null);
    assert.equal(l.view(incident).responder!.name, 'Maya');
    for (const active of [null, { ...incident, id: 'LF-OLD' }, { ...incident, ownerId: 'jordan' },
      { ...incident, phase: 'RESOLVED' as const }, { ...incident, phase: 'CANCELLED_FALSE_ALARM' as const }]) {
      assert.equal(l.recordNative(nativeResponder, nativePoint({ sourceSequence: 1 }), active), false);
      assert.equal(l.view(active).responder, null);
    }
    assert.equal(l.recordNative({ role: 'responder', name: 'Maya' }, nativePoint(), unowned), false);
    assert.equal(l.recordNative(nativeWearer, nativePoint(), null), true, 'approved wearer sharing also works without an incident');
  } finally { l.close(); }
});

test('provider expiry hides native points and capture retention cannot be extended by cached receipts', () => {
  const { l, advance } = setup();
  try {
    assert.equal(l.recordNative(nativeWearer, nativePoint({ expiresAt: start + 1000 }), null), true);
    advance(999); assert.ok(l.view(null).wearer); advance(1); assert.equal(l.view(null).wearer, null);
    assert.equal(l.recordNative(nativeWearer, nativePoint({ receivedAt: start + 1000, expiresAt: start + 2000 }), null), false,
      'expiry cleanup preserves the replay cursor rather than resurrecting the same native sample');
    assert.equal(l.recordNative(nativeWearer, nativePoint({ timestamp: start + 1000, receivedAt: start + 1000 }), null), true);
    advance(7_200_000); assert.equal(l.view(null).wearer, null);
    assert.equal(l.recordNative(nativeWearer, nativePoint({ timestamp: start + 1000, receivedAt: start + 7_201_000,
      sourceSequence: 1 }), null), true);
    assert.equal(l.view(null).wearer, null, 'a two-hour-old capture does not get two more hours from receipt');
    advance(1); assert.equal(l.recordNative(nativeWearer, nativePoint({ timestamp: start + 1000,
      receivedAt: start + 7_201_001, sourceSequence: 2 }), null), false);
  } finally { l.close(); }
});

test('newest actual capture wins across native and browser sources, even when an older capture arrives last', () => {
  const { l, sample, advance } = setup(); const token = l.issue(wearerInput);
  try {
    assert.equal(l.update(token, sample(), null), true); advance(1000);
    assert.equal(l.recordNative(nativeWearer, nativePoint({ timestamp: start - 1000, receivedAt: start + 1000 }), null), true);
    assert.equal(l.view(null).wearer!.source, 'browser-geolocation');
    assert.equal(l.recordNative(nativeWearer, nativePoint({ timestamp: start + 1000, receivedAt: start + 1000 }), null), true);
    assert.equal(l.view(null).wearer!.source, 'photon-find-my'); advance(1000);
    assert.equal(l.update(token, sample({ timestamp: start + 500, sequence: 1 }), null), true);
    assert.equal(l.view(null).wearer!.source, 'photon-find-my', 'new browser receipt cannot beat newer native capture');
    assert.equal(l.update(token, sample({ sequence: 2 }), null), true); assert.equal(l.view(null).wearer!.source, 'browser-geolocation');
    const laterLink = l.issue({ ...wearerInput, key: 'late-cached-browser' }); advance(1000);
    assert.equal(l.update(laterLink, sample({ timestamp: start + 1000 }), null), true);
    assert.equal(l.view(null).wearer!.timestamp, start + 2000, 'capture ordering also applies across browser links');
  } finally { l.close(); }
});

test('browser stop and native removal control their own independent permission sources', () => {
  const { l, sample, advance } = setup();
  try {
    const token = l.issue(wearerInput); l.update(token, sample(), null);
    advance(1000); l.recordNative(nativeWearer, nativePoint({ timestamp: start + 1000, receivedAt: start + 1000 }), null);
    assert.equal(l.stop(token, null), true); assert.equal(l.view(null).wearer!.source, 'photon-find-my');
    l.clearNative(nativeWearer); assert.equal(l.view(null).wearer, null);
    const newToken = l.issue({ ...wearerInput, key: 'new-browser-consent' }); l.update(newToken, sample(), null);
    advance(1000); l.recordNative(nativeWearer, nativePoint({ timestamp: start + 2000, receivedAt: start + 2000 }), null);
    l.clearNative(nativeWearer); assert.equal(l.view(null).wearer!.source, 'browser-geolocation');
    assert.ok(l.authorize(newToken, null));
  } finally { l.close(); }
});
