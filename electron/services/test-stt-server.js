// TEST — Hannibal's speech-to-text helpers. Run: node electron/services/test-stt-server.js
'use strict';
const assert = require('assert');
const { pickModel, cleanTranscript } = require('./stt-server');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n${e.stack}`); process.exitCode = 1; } };
const D = '/Users/Shared/HoloAssistant/models/whisper/';
const has = (...files) => (p) => files.some((f) => D + f === p);

t('picks large-v3-turbo when it is on disk, even if the old small model is asked for', () => {
  assert.strictEqual(pickModel({ WHISPER_MODEL: D + 'ggml-small.bin' }, has('ggml-small.bin', 'ggml-large-v3-turbo.bin')), D + 'ggml-large-v3-turbo.bin');
});
t('falls back to the small model when the big one is missing', () => {
  assert.strictEqual(pickModel({}, has('ggml-small.bin', 'ggml-small.en.bin')), D + 'ggml-small.bin');
});
t('an explicitly chosen other model wins', () => {
  assert.strictEqual(pickModel({ WHISPER_MODEL: '/x/ggml-medium.bin' }, (p) => p === '/x/ggml-medium.bin' || p === D + 'ggml-large-v3-turbo.bin'), '/x/ggml-medium.bin');
});
t('drops non-speech lines Whisper writes', () => {
  assert.strictEqual(cleanTranscript('*Multiple people talking* Started on Valvinesura'), 'Started on Valvinesura');
  assert.strictEqual(cleanTranscript(' [BLANK_AUDIO] '), '');
  assert.strictEqual(cleanTranscript('(music)'), '');
  assert.strictEqual(cleanTranscript('Thank you.'), '');
  assert.strictEqual(cleanTranscript('Hannibal, look in the camera.'), 'Hannibal, look in the camera.');
});
console.log(`\n${n} passed`);
