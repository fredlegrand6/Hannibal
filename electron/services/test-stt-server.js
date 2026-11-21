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
t("auto-detect only picks Fred's languages", () => {
  const { pickLanguage } = require('./stt-server');
  const four = ['en', 'nl', 'fr', 'es'];
  assert.strictEqual(pickLanguage('nl', { nl: 0.9 }, four, 'en'), null);                      // fine as is
  assert.strictEqual(pickLanguage('dutch', { nl: 0.99, en: 0.01 }, four, 'en'), null);         // whisper.cpp gives names
  assert.strictEqual(pickLanguage('icelandic', { is: 0.6, nl: 0.3 }, four, 'en'), 'nl');
  assert.strictEqual(pickLanguage('is', { is: 0.5, nl: 0.3, en: 0.1 }, four, 'en'), 'nl');      // Icelandic → Dutch
  assert.strictEqual(pickLanguage('zh', { zh: 0.8, en: 0.15, fr: 0.01 }, four, 'nl'), 'en');   // Chinese → English
  assert.strictEqual(pickLanguage('ko', {}, four, 'fr'), 'fr');                                 // no odds → conversation language
  assert.strictEqual(pickLanguage('ko', {}, four, 'de'), 'en');
});
console.log(`\n${n} passed`);
