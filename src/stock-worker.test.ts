import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { validBodyWiliSample, validWiliPong } from './freewili.ts';
import { validDevicePacket, validWiliHello } from '../native/freewili/protocol.ts';
import { readMonoPcm16Wav } from '../native/freewili/audio.ts';

test('stock Python gateway controls, capture bounds and shutdown pass offline SDK doubles and strict shared packets', async () => {
  const harness = join(dirname(fileURLToPath(import.meta.url)), '..', 'native', 'freewili', 'stock_io_test.py');
  const { stdout, stderr } = await promisify(execFile)('/usr/bin/python3', [harness], {
    timeout: 10_000, maxBuffer: 140_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.match(stderr, /Ran \d+ tests/); assert.match(stderr, /OK/);
  const packets = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(packets.some(packet => validWiliHello(packet)));
  const sample = packets.find(packet => packet.type === 'accel.sample');
  assert.ok(validBodyWiliSample(sample));
  assert.deepEqual(sample.accelerationG, [.004, -.048, 1.028]);
  assert.equal(sample.captureClock, 'host-receipt'); assert.equal(sample.frameTimestamp, '999');
  const buttons = packets.filter(packet => packet.type === 'button.press');
  assert.equal(buttons.length, 3); assert.ok(buttons.every(validDevicePacket));
  const cancel = buttons.find(packet => packet.type === 'button.press' && packet.action === 'cancel')!,
    help = buttons.find(packet => packet.type === 'button.press' && packet.action === 'help')!,
    rehearsal = buttons.find(packet => packet.type === 'button.press' && packet.action === 'rehearse')!;
  assert.ok(cancel.type === 'button.press' && help.type === 'button.press' && rehearsal.type === 'button.press');
  assert.equal(cancel.action, 'cancel'); assert.equal(cancel.incidentId, 'LF-TEST1234');
  assert.equal(help.action, 'help'); assert.equal(help.incidentId, null); assert.equal(help.checkinId, null);
  assert.equal(rehearsal.incidentId, null); assert.equal(rehearsal.checkinId, null);
  assert.ok(validWiliPong(packets.find(packet => packet.type === 'clock.pong')));
  const audioStates = packets.filter(packet => packet.type === 'checkin.audio');
  assert.deepEqual(audioStates.map(packet => packet.stage), ['prompting', 'listening']);
  assert.ok(audioStates.every(validDevicePacket));
  const utterance = packets.find(packet => packet.type === 'stock.utterance');
  assert.equal(utterance.incidentId, 'LF-TEST1234'); assert.equal(utterance.checkinId, 'test-checkin');
  const wav = readMonoPcm16Wav(Buffer.from(utterance.audioBase64, 'base64'));
  assert.equal(wav.sampleRate, 8000); assert.equal(wav.pcm.length, 6);
  assert.deepEqual([wav.pcm.readInt16LE(0), wav.pcm.readInt16LE(2), wav.pcm.readInt16LE(4)], [-32768, 0, 32767]);
});
