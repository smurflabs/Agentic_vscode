'use strict';
// Dictation mode's microphone in VS Code (src/speech.ts): a turn ends at the user's pause and its WAV is transcribed; Send
// ends it now; Pause throws it away; a recorder that cannot run says why; the Windows recorder is PowerShell.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { SpeechInput, recorderCandidates, wavOf, RATE } = require('../out/speech.js');

const mic = (pattern, extra = '') => `"${process.execPath}" "${path.join(__dirname, 'fake-mic.js')}" ${pattern} ${extra}`.trim();

test('a turn ends at the pause after speech, and its recording is transcribed', async () => {
  const speech = new SpeechInput(() => mic('q600,t1200,q6000'));
  let wav = null, language = null;
  const started = Date.now();
  const r = await speech.listen({ silenceMs: 700, sensitivity: 5, language: 'de' }, async (w, l) => { wav = w; language = l; return ' hello there '; });
  const took = Date.now() - started;
  speech.release();
  assert.strictEqual(r.text, 'hello there');
  assert.strictEqual(language, 'de');
  assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(wav.readUInt32LE(24), RATE);
  // About 0.6 s quiet + 1.2 s speech + 0.7 s pause.
  const seconds = (wav.length - 44) / 2 / RATE;
  assert.ok(seconds > 2 && seconds < 3.5, `recorded ${seconds} s`);
  assert.ok(took < 5000, `took ${took} ms`);
  assert.strictEqual(speech.state.state, 'idle');
});

test('nothing said: the turn ends after noSpeechSeconds without transcribing', async () => {
  const speech = new SpeechInput(() => mic('q10000'));
  let called = false;
  const r = await speech.listen({ noSpeechSeconds: 3 }, async () => { called = true; return 'x'; });
  speech.release();
  assert.strictEqual(r.text, '');
  assert.strictEqual(called, false);
});

test('Send ends the turn now with what was heard; Pause throws it away', async () => {
  const speech = new SpeechInput(() => mic('q300,t30000'));
  let state = null;
  const turn = speech.listen({ silenceMs: 700 }, async () => 'sent early');
  await new Promise(r => setTimeout(r, 1500));
  state = speech.state;
  speech.stop(false);
  assert.strictEqual((await turn).text, 'sent early');
  assert.strictEqual(state.state, 'listening');
  assert.ok(state.level > 0.4, `level ${state.level}`);

  let called = false;
  const second = speech.listen({ silenceMs: 700 }, async () => { called = true; return 'x'; });
  await new Promise(r => setTimeout(r, 800));
  speech.stop(true);
  assert.strictEqual((await second).text, '');
  assert.strictEqual(called, false);
  speech.release();
});

test('a recorder that cannot record says why', async () => {
  const speech = new SpeechInput(() => mic('q100', 'die'));
  await assert.rejects(speech.listen({}, async () => 'x'), /No microphone here/);
  speech.release();
  // Linux tries the usual recorders in turn.
  const cands = recorderCandidates('linux', undefined).map(c => c[0]);
  assert.deepStrictEqual(cands, ['parecord', 'arecord', 'sox', 'ffmpeg']);
});

test('the Windows recorder is PowerShell with the waveIn API', () => {
  const [cmd, args] = recorderCandidates('win32', undefined)[0];
  assert.strictEqual(cmd, 'powershell.exe');
  const script = Buffer.from(args[args.length - 1], 'base64').toString('utf16le');
  assert.match(script, /waveInOpen/);
  assert.match(script, /AgenticMic\]::Run\(16000\)/);
  assert.strictEqual(recorderCandidates('win32', 'my-rec --raw')[0][0], 'my-rec --raw');
  assert.strictEqual(wavOf(Buffer.alloc(320)).length, 364);
});
