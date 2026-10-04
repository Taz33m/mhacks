import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pcm16Wav, readMonoPcm16Wav } from './audio.ts';
import { transcribeOgUtterance } from './audio-transcription.ts';

const utterance = (): Buffer => {
  const pcm = Buffer.alloc(8000 * 2 / 10);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(i % 2 ? 1000 : -1000, i * 2);
  return pcm16Wav(pcm, 8000);
};
async function fixture(run: (modelPath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'lifeline-offline-whisper-test-'));
  try {
    const model = join(directory, 'offline-model.bin'), handle = await open(model, 'w', 0o600);
    await handle.truncate(1_000_000); await handle.close(); // Sparse test fixture; never runs inference.
    await run(model);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('STT uses 16k mono bounded utterance, actual CLI argument list, and cleans transient files', async () => {
  await fixture(async modelPath => {
    let directory = '';
    const result = await transcribeOgUtterance(utterance(), { modelPath, run: async (cli, args) => {
      assert.equal(cli, '/opt/homebrew/bin/whisper-cli');
      assert.equal(args[args.indexOf('-m') + 1], modelPath);
      assert.ok(args.includes('-ng')); assert.ok(args.includes('-otxt')); assert.ok(args.includes('-nt'));
      const audio = args[args.indexOf('-f') + 1]!; directory = dirname(audio);
      const wav = readMonoPcm16Wav(await readFile(audio));
      assert.equal(wav.sampleRate, 16000); assert.equal(wav.durationMs, 100);
      await writeFile(args[args.indexOf('-of') + 1]! + '.txt', '  I need help.\n');
    } });
    assert.deepEqual(result, { status: 'transcribed', transcript: 'I need help.', source: 'freewili-og-microphone', engine: 'whisper.cpp' });
    await assert.rejects(access(directory));
  });
});

test('positive speech is returned as recognized text without a cancellation decision', async () => {
  await fixture(async modelPath => {
    const result = await transcribeOgUtterance(utterance(), { modelPath, run: async (_cli, args) => {
      await writeFile(args[args.indexOf('-of') + 1]! + '.txt', "I'm okay.");
    } });
    assert.deepEqual(result, { status: 'transcribed', transcript: "I'm okay.", source: 'freewili-og-microphone', engine: 'whisper.cpp' });
  });
});

test('wellbeing 15s uses the local CLI with exact duration while default incident rejects it', async () => {
  await fixture(async modelPath => {
    const wav = pcm16Wav(Buffer.alloc(8000 * 2 * 15, 1), 8000); let calls = 0, directory = '';
    const run = async (_cli: string, args: string[]) => {
      calls++; const audio = args[args.indexOf('-f') + 1]!; directory = dirname(audio);
      const parsed = readMonoPcm16Wav(await readFile(audio));
      assert.equal(parsed.sampleRate, 16000); assert.equal(parsed.durationMs, 15000);
      await writeFile(args[args.indexOf('-of') + 1]! + '.txt', 'I had breakfast and feel better today.');
    };
    assert.equal((await transcribeOgUtterance(wav, { modelPath, run })).status, 'unavailable');
    assert.equal(calls, 0);
    const result = await transcribeOgUtterance(wav, { modelPath, run, maxDurationMs: 15000 });
    assert.equal(result.status, 'transcribed'); assert.equal(calls, 1);
    await assert.rejects(access(directory));
  });
});

test('invalid/zero microphone data and missing model do not start a recognition process', async () => {
  let calls = 0; const run = async () => { calls++; };
  for (const input of [Buffer.from('not wav'), pcm16Wav(Buffer.alloc(16), 8000)])
    assert.equal((await transcribeOgUtterance(input, { modelPath: '/missing/model.bin', run })).status, 'unavailable');
  assert.equal((await transcribeOgUtterance(utterance(), { modelPath: '/missing/model.bin', run })).status, 'unavailable');
  assert.equal(calls, 0);
});

test('empty/no-speech/malformed/oversized model results are unavailable with temp cleanup', async () => {
  await fixture(async modelPath => {
    for (const output of ['', '[BLANK_AUDIO]', '[Silence]', 'a'.repeat(501), 'a'.repeat(4097), 'I\u0000 need help']) {
      let directory = '';
      const result = await transcribeOgUtterance(utterance(), { modelPath, run: async (_cli, args) => {
        const prefix = args[args.indexOf('-of') + 1]!; directory = dirname(prefix);
        await writeFile(prefix + '.txt', output);
      } });
      assert.equal(result.status, 'unavailable'); await assert.rejects(access(directory));
    }
  });
});

test('failed CLI and abort prevent late recognized text, and remove temporary audio', async () => {
  await fixture(async modelPath => {
    let directory = '';
    const failure = await transcribeOgUtterance(utterance(), { modelPath, run: async (_cli, args) => {
      directory = dirname(args[args.indexOf('-f') + 1]!); throw new Error('Synthetic process failure');
    } });
    assert.equal(failure.status, 'unavailable'); await assert.rejects(access(directory));
    const controller = new AbortController();
    const result = await transcribeOgUtterance(utterance(), { modelPath, signal: controller.signal, run: async (_cli, args, signal) => {
      assert.equal(signal, controller.signal);
      directory = dirname(args[args.indexOf('-f') + 1]!);
      await writeFile(args[args.indexOf('-of') + 1]! + '.txt', 'I need help'); controller.abort();
    } });
    assert.equal(result.status, 'unavailable'); await assert.rejects(access(directory));
    let called = false;
    assert.equal((await transcribeOgUtterance(utterance(), { modelPath, signal: controller.signal, run: async () => { called = true; } })).status, 'unavailable');
    assert.equal(called, false);
  });
});
