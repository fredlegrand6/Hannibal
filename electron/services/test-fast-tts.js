// TEST — fast TTS request shape. Run: node electron/services/test-fast-tts.js
'use strict';
const assert = require('assert');
const { ttsRequest, speakToMp3 } = require('./fast-tts');
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n${e.stack}`); process.exitCode = 1; } };
(async () => {
  await t('uses Daniel, flash v2.5 by default, mp3', () => {
    const { url, init } = ttsRequest('Hello Fred', { apiKey: 'k' });
    assert.ok(url.includes('/text-to-speech/onwK4e9ZLuTAKqWW03F9') && url.includes('mp3_44100_128'));
    const body = JSON.parse(init.body);
    assert.deepStrictEqual([body.text, body.model_id, init.headers['xi-api-key']], ['Hello Fred', 'eleven_flash_v2_5', 'k']);
  });
  await t('returns the audio bytes', async () => {
    const buf = await speakToMp3('Hi', { apiKey: 'k', fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) });
    assert.deepStrictEqual([...buf], [1, 2, 3]);
  });
  await t('an API error is thrown (so the old path can take over)', async () => {
    await assert.rejects(speakToMp3('Hi', { apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'bad key' }) }), /401/);
  });
  console.log(`\n${n} passed`);
})();
