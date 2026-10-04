import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { FreeWili, validBodyWiliSample } from './freewili.ts';
import type { BodyWiliSample } from './freewili.ts';
import { MAX_LINE_BYTES, WiliDeviceProtocol, WiliNdjson, validDevicePacket, validHostPacket, validWiliHello } from '../native/freewili/protocol.ts';
import { checkWiliFile } from '../native/freewili/bridge.ts';

// Deterministic protocol fixtures, never physical motion or a fall accuracy trial.
const sample = (sequence = 0, sensorTime = 101, fullScaleG: BodyWiliSample['fullScaleG'] = 8): BodyWiliSample => ({
  type: 'accel.sample', source: 'body-wili', sessionId: 'synthetic-og-boot-1', sequence, sensorTime,
  captureClock: 'device-monotonic', accelerationG: [0, 0, 1], fullScaleG, fresh: true, saturated: false, quality: 'measured',
});
const hello = () => ({ type: 'device.hello', protocolVersion: 1, source: 'body-wili', sessionId: 'synthetic-og-boot-1',
  deviceModel: 'freewili-og', fullScaleG: 8, capabilities: { accelerometer: true, speaker: true, microphone: true, buttons: true } });

test('microphone status requires declared capability and matching, unreplayed device provenance', () => {
  const audio = { type: 'checkin.audio', source: 'body-wili', sessionId: 'synthetic-og-boot-1',
    eventId: 'listening-event', incidentId: 'LF-SYNTHETIC', checkinId: 'synthetic-checkin', stage: 'listening' };
  const protocol = new WiliDeviceProtocol(); protocol.accept(hello());
  assert.equal(validDevicePacket(audio), true); protocol.accept(audio);
  assert.throws(() => protocol.accept(audio), /Repeated/);
  assert.equal(validDevicePacket({ ...audio, stage: 'safe' }), false);
  assert.equal(validDevicePacket({ ...audio, incidentId: null }), false);
  assert.throws(() => protocol.accept({ ...audio, eventId: 'different-event', sessionId: 'other-boot' }), /matching/);
  const noMic = new WiliDeviceProtocol();
  noMic.accept({ ...hello(), capabilities: { ...hello().capabilities, microphone: false } });
  assert.throws(() => noMic.accept(audio), /microphone/);
});
function fixture(fullScale: BodyWiliSample['fullScaleG'] = 8, initialTime = 101) {
  let now = 1000;
  const adapter = new FreeWili(() => now); adapter.connected();
  assert.equal(adapter.sample(sample(0, initialTime, fullScale)), true);
  const ping = adapter.ping('synthetic-clock-1');
  assert.equal(adapter.pong({ type: 'clock.pong', id: ping.id, sessionId: sample().sessionId,
    deviceReceivedMs: 101000, deviceSentMs: 101000 }), true);
  return { adapter, advance(ms: number) { now += ms; }, now: () => now,
    next(sequence: number, delta = 0) { return sample(sequence, (now + 100000 + delta) / 1000, fullScale); } };
}

test('trial boundary discards old measurements/alignment while retaining boot and replay/range guards', () => {
  const f = fixture(); f.advance(20); const before = f.next(1); assert.equal(f.adapter.sample(before), true);
  const oldPing = f.adapter.ping('old-pending-ping');
  f.adapter.resetForTrial();
  const view = f.adapter.view();
  assert.equal(view.connected, true); assert.equal(view.sessionId, before.sessionId);
  assert.equal(view.quality, 'awaiting-sample'); assert.equal(view.fresh, false);
  assert.equal(view.receivedAgeMs, null); assert.equal(view.alignmentUncertaintyMs, null);
  assert.deepEqual(f.adapter.observations(), []);
  assert.equal(f.adapter.sample(before), false, 'old frames are not accepted again after a trial boundary');
  assert.equal(f.adapter.sample({ ...f.next(2), sessionId: 'different-boot' }), false);
  assert.equal(f.adapter.sample({ ...f.next(2), fullScaleG: 4 }), false);
  f.advance(20); assert.equal(f.adapter.sample(f.next(2)), true);
  assert.equal(f.adapter.view().usable, false, 'new measurements do not reuse pre-trial alignment');
  const pong = { type: 'clock.pong', id: oldPing.id, sessionId: before.sessionId,
    deviceReceivedMs: f.now() + 100000, deviceSentMs: f.now() + 100000 };
  assert.equal(f.adapter.pong(pong), false);
  const freshPing = f.adapter.ping('new-trial-ping'); assert.equal(f.adapter.pong({ ...pong, id: freshPing.id }), true);
  f.advance(20); f.adapter.sample(f.next(3)); assert.equal(f.adapter.view().usable, true);
});

test('raw acceleration validates declared units/capabilities without fabricated fused fields', () => {
  assert.equal(validBodyWiliSample(sample()), true);
  assert.equal(validBodyWiliSample({ ...sample(), accelerationG: [0, 0, 0] }), true, 'zero acceleration can be an actual measurement');
  for (const change of [{ source: 'chest-phone' }, { gravity: [0, 0, 1] }, { quaternion: [0, 0, 0, 1] },
    { rotationRate: [0, 0, 0] }, { quality: 'estimated' }, { fresh: false }, { captureClock: 'host-receive' },
    { accelerationG: [NaN, 0, 1] }, { accelerationG: [100, 0, 0] }, { sensorTime: Infinity },
    { fullScaleG: '8' }, { sequence: 1.5 }, { sessionId: '../unsafe' }])
    assert.equal(validBodyWiliSample({ ...sample(), ...change }), false);
});

test('clock exchange maps device acquisition independently of host receipt', () => {
  let now = 1000;
  const adapter = new FreeWili(() => now); adapter.connected(); adapter.sample(sample());
  assert.equal(adapter.view().fresh, false, 'receipt without a capture-clock estimate is not fresh evidence');
  const ping = adapter.ping(); now += 10;
  assert.equal(adapter.pong({ type: 'clock.pong', id: ping.id, sessionId: sample().sessionId,
    deviceReceivedMs: 101004, deviceSentMs: 101005 }), true);
  now += 10; assert.equal(adapter.sample(sample(1, 101.020)), true);
  const view = adapter.view();
  assert.equal(view.source, 'body-wili'); assert.equal(view.sensorLocation, 'body');
  assert.equal(view.alignmentUncertaintyMs, 4.5); assert.equal(view.fresh, true); assert.equal(view.usable, true);
  assert.equal(adapter.observations().at(-1)!.hostReceivedMs, 1020);
  assert.equal(adapter.observations().at(-1)!.alignedAtMs, 1020.5);
  assert.equal(view.totalG, 1); assert.equal('quaternion' in view, false);
});

test('stock gateway timing is explicit and sparse board events do not invent quiet or reset the host clock', () => {
  let now = 1000;
  const wili = new FreeWili(() => now); wili.connected();
  const stock = (sequence: number): BodyWiliSample => ({ ...sample(sequence, now / 1000, 2),
    captureClock: 'host-receipt', frameTimestamp: '1015894500660534528' });
  wili.sample(stock(0)); const ping = wili.ping('stock-clock');
  assert.equal(wili.pong({type:'clock.pong',id:ping.id,sessionId:sample().sessionId,deviceReceivedMs:now,deviceSentMs:now}),true);
  now += 20; wili.sample(stock(1)); assert.equal(wili.view().usable,true);
  now += 600; assert.equal(wili.view().fresh,false,'sparse stock events become stale between receipts');
  wili.sample(stock(2));
  assert.equal(wili.view().captureClock,'host-receipt'); assert.equal(wili.view().usable,true);
  assert.equal(wili.observations().length,3,'historical observations retain actual gaps without filling missing motion');
  assert.equal(wili.sample({...stock(3),captureClock:'device-monotonic'}),false,'clock domain cannot change within a session');
  now += 15_000; wili.sample(stock(4)); assert.equal(wili.view().usable,false,'the gateway estimate still expires');
});

test('increasing delayed or future acquisition timestamps cannot become fresh through receipt', () => {
  for (const skew of [-10000, 1000]) {
    const f = fixture(8, 80); f.advance(10);
    assert.equal(f.adapter.sample(f.next(1, skew)), true, 'raw diagnostic observation is retained');
    assert.equal(f.adapter.view().fresh, false); assert.equal(f.adapter.view().usable, false);
    assert.equal(f.adapter.view().quality, 'capture-stale');
    assert.equal(f.adapter.observations().at(-1)!.captureFresh, false);
    f.advance(10);
    assert.equal(f.adapter.sample(f.next(2)), skew < 0,
      'a future-stamped observation prevents a later packet from rolling acquisition time backward');
    assert.equal(f.adapter.view().usable, skew < 0);
    assert.equal(f.adapter.observations()[1].usable, false, 'one current packet cannot rehabilitate old evidence');
  }
});

test('session replay, duplicate sequence and non-increasing capture time are rejected', () => {
  const f = fixture(); f.advance(10); const p = f.next(1); f.adapter.sample(p);
  assert.equal(f.adapter.sample(p), false);
  assert.equal(f.adapter.sample({ ...p, sequence: 2 }), false);
  assert.equal(f.adapter.sample({ ...f.next(3), sessionId: 'other-boot' }), false);
  f.adapter.disconnected(); f.adapter.connected();
  assert.equal(f.adapter.view().fresh, false);
  assert.equal(f.adapter.sample(f.next(4)), false, 'retired boot/session cannot rejoin after disconnect');
  assert.equal(f.adapter.sample({ ...f.next(4), sessionId: 'new-boot' }), true);
  assert.equal(f.adapter.view().quality, 'unsynchronized');
});

test('stale receive gaps invalidate alignment instead of bridging lost motion', () => {
  const f = fixture(); f.advance(10); f.adapter.sample(f.next(1));
  f.advance(500);
  assert.equal(f.adapter.view().quality, 'stale'); assert.equal(f.adapter.view().totalG, null);
  f.adapter.sample(f.next(2));
  assert.equal(f.adapter.view().quality, 'unsynchronized'); assert.equal(f.adapter.observations().length, 1);
});

test('range and saturation remain visible and never imply detector readiness', () => {
  const narrow = fixture(2); narrow.advance(10); narrow.adapter.sample(narrow.next(1));
  assert.equal(narrow.adapter.view().fresh, true); assert.equal(narrow.adapter.view().quality, 'insufficient-range');
  assert.equal(narrow.adapter.view().usable, false);
  const f = fixture(); f.advance(10);
  f.adapter.sample({ ...f.next(1), accelerationG: [7.9, 0, 0] });
  assert.equal(f.adapter.view().quality, 'saturated'); assert.equal(f.adapter.view().fresh, true);
  assert.equal(f.adapter.view().usable, false); assert.equal(f.adapter.view().saturated, true);
  f.advance(10); assert.equal(f.adapter.sample({ ...f.next(2), fullScaleG: 4 }), false, 'range changes require a new session');
});

test('unknown/replayed/slow clock responses cannot establish a new estimate', () => {
  const f = fixture();
  assert.equal(f.adapter.pong({ type: 'clock.pong', id: 'unknown', sessionId: sample().sessionId, deviceReceivedMs: 1, deviceSentMs: 2 }), false);
  const ping = f.adapter.ping('synthetic-clock-slow'); f.advance(1100);
  assert.equal(f.adapter.pong({ type: 'clock.pong', id: ping.id, sessionId: sample().sessionId,
    deviceReceivedMs: 101000, deviceSentMs: 101000 }), false);
  assert.equal(f.adapter.pong({ type: 'clock.pong', id: ping.id, sessionId: sample().sessionId,
    deviceReceivedMs: 101000, deviceSentMs: 101000 }), false);
});

test('capture clock expires, history stays bounded and returned vectors cannot mutate stored evidence', () => {
  const f = fixture();
  for (let sequence = 1; sequence <= 1800; sequence++) {
    f.advance(10); const p = f.next(sequence); f.adapter.sample(p); p.accelerationG[2] = 100;
  }
  assert.equal(f.adapter.view().quality, 'unsynchronized'); assert.equal(f.adapter.view().fresh, false);
  assert.equal(f.adapter.observations().length <= 1600, true);
  const copy = f.adapter.observations(); copy.at(-1)!.sample.accelerationG[2] = 100;
  assert.equal(f.adapter.observations().at(-1)!.totalG, 1);
  assert.equal(f.adapter.observations().at(-1)!.sample.accelerationG[2], 1);
});

test('bounded NDJSON handles split UTF-8, malformed packets and unfinished/oversized lines', () => {
  const decoder = new WiliNdjson(), bytes = Buffer.from('{"text":"café"}\n');
  const split = bytes.indexOf(0xc3) + 1;
  assert.deepEqual(decoder.push(bytes.subarray(0, split)), []);
  assert.deepEqual(decoder.push(bytes.subarray(split)), [{ text: 'café' }]); decoder.finish();
  assert.throws(() => new WiliNdjson().push(Buffer.alloc(MAX_LINE_BYTES + 1, 65)), /4096/);
  assert.throws(() => new WiliNdjson().push(Buffer.from('not-json\n')), /Invalid/);
  const partial = new WiliNdjson(); partial.push(Buffer.from('{}')); assert.throws(() => partial.finish(), /Incomplete/);
});

test('custom protocol rejects missing hello, identity changes and duplicate control events', () => {
  const protocol = new WiliDeviceProtocol(); assert.throws(() => protocol.accept(sample()), /hello/);
  assert.equal(validWiliHello({ ...hello(), fullScaleG: '8' }), false);
  protocol.accept(hello()); protocol.accept(sample());
  assert.throws(() => protocol.accept(sample()), /repeated/);
  assert.throws(() => protocol.accept({ ...hello(), sessionId: 'changed' }), /identity/);
  const button = { type: 'button.press', source: 'body-wili', sessionId: sample().sessionId,
    eventId: 'synthetic-help-1', action: 'help', incidentId: null, checkinId: null };
  assert.equal(validDevicePacket(button), true); protocol.accept(button);
  assert.equal(validDevicePacket({ ...button, action: ['help'] }), false);
  assert.throws(() => protocol.accept(button), /Repeated/);
  assert.equal(validDevicePacket({ ...button, action: 'cancel' }), false);
  assert.equal(validHostPacket({ type: 'audio.command', sessionId: sample().sessionId, commandId: 'synthetic-play-1',
    incidentId: 'LF-SYNTHETIC', checkinId: 'synthetic-checkin', action: 'play', asset: 'fall-checkin' }), true);
  assert.equal(validHostPacket({ type: 'audio.command', sessionId: sample().sessionId, commandId: 'synthetic-play-1',
    incidentId: 'LF-SYNTHETIC', checkinId: 'synthetic-checkin', action: ['play'], asset: 'fall-checkin' }), false);
  assert.equal(validHostPacket({ type: 'incident.context', sessionId: sample().sessionId, incidentId: null,
    checkinId: null, phase: 'CONFIRMING', checkinDeadline: null, serverTime: 1 }), false);
});

test('capability and range declarations constrain later board packets', () => {
  for (const capabilities of [{ accelerometer: false, speaker: true, microphone: false, buttons: true },
    { accelerometer: true, speaker: 'true', microphone: false, buttons: true },
    { accelerometer: true, speaker: true, microphone: false }])
    assert.equal(validWiliHello({ ...hello(), capabilities }), false);
  const protocol = new WiliDeviceProtocol();
  protocol.accept({ ...hello(), capabilities: { accelerometer: true, speaker: false, microphone: false, buttons: false } });
  assert.throws(() => protocol.accept({ ...sample(), fullScaleG: 4 }), /range/);
  assert.throws(() => protocol.accept({ type: 'button.press', source: 'body-wili', sessionId: sample().sessionId,
    eventId: 'unadvertised-help', action: 'help', incidentId: null, checkinId: null }), /buttons/);
  assert.throws(() => protocol.accept({ type: 'audio.ack', source: 'body-wili', sessionId: sample().sessionId,
    eventId: 'unadvertised-playback', commandId: 'synthetic-play', incidentId: 'LF-SYNTHETIC', checkinId: 'synthetic-checkin', status: 'finished' }), /speaker/);
  assert.equal(validDevicePacket({ type: 'device.status', source: 'body-wili', sessionId: sample().sessionId, status: ['sensor-error'] }), false);
  assert.equal(validHostPacket({ type: 'incident.context', sessionId: sample().sessionId, incidentId: 'LF-SYNTHETIC',
    checkinId: 'synthetic-checkin', phase: 'CONFIRMING', checkinDeadline: NaN, serverTime: 1 }), false);
});

test('offline bridge checks a clearly synthetic file without serial/network/provider startup', async () => {
  const path = fileURLToPath(new URL('../native/freewili/fixtures/synthetic-protocol.ndjson', import.meta.url));
  const result = await checkWiliFile(path);
  assert.equal(result.mode, 'offline-protocol-check'); assert.equal(result.physicalHardwareVerified, false);
  assert.equal((result.counts as Record<string, number>)['accel.sample'], 2);
});
