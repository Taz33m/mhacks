import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_UTTERANCE_MS, OgUtterance, convertPreparedAudioToOgWav, ogWavForWhisper,
  parseOgAudioFrame, pcm16Wav, readMonoPcm16Wav,
} from './audio.ts';

const pcm = (...samples: number[]): Buffer => {
  const bytes = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => bytes.writeInt16LE(sample, index * 2)); return bytes;
};

test('stock audio parser separates native metadata/status from signed PCM payload', () => {
  const frame = parseOgAudioFrame('[*audio 0E00CC80AEF767E4 6165 -956 -1192 -1296 -1276 -1268 -1260 -1136 -940 1]');
  assert.deepEqual(frame, { timestampNs: BigInt('0x0E00CC80AEF767E4').toString(), sequence: 6165,
    samples: [-956, -1192, -1296, -1276, -1268, -1260, -1136, -940] });
  assert.equal(parseOgAudioFrame('[*accel 0E00CC80AEF767E4 6166 1 2 3 1]'), null);
  assert.deepEqual(parseOgAudioFrame('[*audio FFFFFFFFFFFFFFFF 9 -32768 0 32767 1]')?.samples, [-32768, 0, 32767]);
});

test('malformed/error/oversized stock microphone data never becomes PCM', () => {
  for (const frame of [
    '[*audio 00 1 123 0]', '[*audio 00 1 32768 1]', '[*audio 00 1 -32769 1]',
    '[*audio 00 1 1.2 1]', '[*audio 00 9007199254740992 3 1]', '[*audio 00 1 1]',
    '[*audio 00 1 4 1] unexpected', `[*audio 00 1 ${Array(1025).fill('1').join(' ')} 1]`,
  ]) assert.throws(() => parseOgAudioFrame(frame));
});

test('bounded utterance uses host deadline and allows skipped global sequences without duplicates', () => {
  let now = 1000;
  const capture = new OgUtterance(() => now, 1000);
  const frame = parseOgAudioFrame('[*audio 01 3 -32768 0 32767 1]')!;
  assert.equal(capture.append(frame), true);
  assert.equal(capture.append(frame), false);
  assert.equal(capture.append({ ...frame, sequence: 2 }), false);
  now = 1999;
  assert.equal(capture.append({ ...frame, sequence: 8, timestampNs: '2' }), true);
  now = 2000;
  assert.equal(capture.append({ ...frame, sequence: 9 }), false);
  const result = capture.finish();
  assert.equal(result.status, 'captured');
  if (result.status !== 'captured') return;
  assert.deepEqual(readMonoPcm16Wav(result.wav).pcm, pcm(-32768, 0, 32767, -32768, 0, 32767));
  assert.equal(result.durationMs, 6 / 8000 * 1000);
  assert.equal(capture.append({ ...frame, sequence: 10 }), false);
  assert.equal(capture.finish().status, 'unavailable');
});

test('utterance sample bound cannot grow from bursts; absent/aborted audio remains unavailable', () => {
  const capture = new OgUtterance(() => 0, 1);
  assert.equal(capture.append({ sequence: 1, timestampNs: '0', samples: Array(100).fill(123) }), true);
  assert.equal(capture.append({ sequence: 2, timestampNs: '0', samples: [321] }), false);
  const result = capture.finish();
  assert.equal(result.status, 'captured');
  if (result.status === 'captured') assert.equal(result.durationMs, 1);
  assert.equal(new OgUtterance(() => 0).finish().status, 'unavailable');
  const aborted = new OgUtterance(() => 0);
  aborted.append({ sequence: 1, timestampNs: '0', samples: [123] }); aborted.abort();
  assert.equal(aborted.finish().status, 'unavailable');
  assert.throws(() => new OgUtterance(() => 0, MAX_UTTERANCE_MS + 1));
});

test('a backwards or invalid host clock aborts the microphone window', () => {
  let now = 2;
  const capture = new OgUtterance(() => now);
  capture.append({ sequence: 1, timestampNs: '0', samples: [123] }); now = 1;
  assert.throws(() => capture.append({ sequence: 2, timestampNs: '0', samples: [456] }), /clock/);
  assert.equal(capture.finish().status, 'unavailable');
});

test('WAV encoding preserves signed sample values and actual 8kHz mono format', () => {
  const bytes = pcm(-32768, -1, 0, 1, 32767), wav = pcm16Wav(bytes, 8000);
  assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(24), 8000); assert.equal(wav.readUInt32LE(28), 16000);
  const parsed = readMonoPcm16Wav(wav);
  assert.deepEqual(parsed.pcm, bytes); assert.equal(parsed.durationMs, 0.625);
});

test('WAV validation rejects truncation, wrong channel/rate/encoding, empty or excessive audio', () => {
  const source = pcm16Wav(pcm(0, 1), 8000);
  assert.throws(() => readMonoPcm16Wav(source.subarray(0, source.length - 1)));
  for (const [offset, value] of [[20, 3], [22, 2], [34, 8]] as const) {
    const copy = Buffer.from(source); copy.writeUInt16LE(value, offset);
    assert.throws(() => readMonoPcm16Wav(copy));
  }
  const copy = Buffer.from(source); copy.writeUInt32LE(44100, 24);
  assert.throws(() => readMonoPcm16Wav(copy));
  assert.throws(() => pcm16Wav(Buffer.alloc(0), 8000));
  assert.throws(() => pcm16Wav(Buffer.alloc(8000 * 2 * 16), 8000));
});

test('Whisper conversion doubles sample rate and count while preserving utterance duration', () => {
  const source = pcm16Wav(pcm(-1000, 1000, -1000), 8000);
  const converted = readMonoPcm16Wav(ogWavForWhisper(source));
  assert.equal(converted.sampleRate, 16000);
  assert.equal(converted.durationMs, readMonoPcm16Wav(source).durationMs);
  assert.deepEqual(converted.pcm, pcm(-1000, 0, 1000, 0, -1000, -1000));
  assert.throws(() => ogWavForWhisper(pcm16Wav(pcm(1), 16000)));
  assert.throws(() => ogWavForWhisper(pcm16Wav(Buffer.alloc(8000 * 2 * 7), 8000)));
});

test('installed Core Audio conversion prepares 8kHz mono WAV without playback', { skip: process.platform !== 'darwin' }, async () => {
  const samples = Buffer.alloc(16000 * 2 / 10);
  for (let i = 0; i < samples.length / 2; i++) samples.writeInt16LE(Math.round(Math.sin(i / 16000 * 440 * 2 * Math.PI) * 1000), i * 2);
  const converted = await convertPreparedAudioToOgWav(pcm16Wav(samples, 16000));
  const parsed = readMonoPcm16Wav(converted);
  assert.equal(parsed.sampleRate, 8000); assert.equal(parsed.durationMs, 100);
  assert.equal(converted.length, 44 + parsed.pcm.length);
  assert.equal(converted.toString('ascii', 36, 40), 'data');
  assert.equal(converted.readUInt32LE(40), parsed.pcm.length);
  assert.ok(parsed.pcm.some(byte => byte !== 0));
  await assert.rejects(convertPreparedAudioToOgWav(Buffer.from('not audio')), /convert/);
  await assert.rejects(convertPreparedAudioToOgWav(Buffer.alloc(0)), /size/);
});
