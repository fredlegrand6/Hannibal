// TEST — interpreter: heard language → the other side's language, in his voice.
// Run: node server/test-interpreter.js
'use strict';
const assert = require('assert');
const { createInterpreter, direction, norm } = require('./interpreter');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.stack || e.message}`); process.exitCode = 1; }
}

(async () => {
  console.log('interpreter');

  await test('language codes from Scribe', () => {
    assert.strictEqual(norm('spa'), 'es'); assert.strictEqual(norm('eng'), 'en'); assert.strictEqual(norm('nld'), 'nl'); assert.strictEqual(norm('fr'), 'fr'); assert.strictEqual(norm('xyz'), '');
  });

  await test('direction: whoever speaks, it goes to the other side', () => {
    assert.deepStrictEqual(direction('eng', 'en', 'es'), { from: 'en', to: 'es' });
    assert.deepStrictEqual(direction('spa', 'en', 'es'), { from: 'es', to: 'en' });
    assert.deepStrictEqual(direction('', 'en', 'es'), { from: 'en', to: 'es' });
    assert.deepStrictEqual(direction('fra', 'en', 'es'), { from: 'fr', to: 'en' }, 'a third language goes to Fred');
  });

  await test('one sentence: translated text + his voice; silence returns nothing', async () => {
    const asked = [];
    const it = createInterpreter({
      transcribe: async (buf) => (buf.length > 1 ? { text: '¿Cuánto cuesta la habitación?', language: 'spa' } : { text: '', language: '' }),
      translate: async (system, user) => { asked.push(user); assert.match(system, /interpreter/); return 'How much is the room?'; },
      speak: async (t) => Buffer.from(`mp3:${t}`),
    });
    const r = await it.interpret(Buffer.from('audio'), 'audio/wav', { mine: 'en', theirs: 'es' });
    assert.strictEqual(r.text, 'How much is the room?'); assert.strictEqual(r.to, 'en'); assert.strictEqual(r.from, 'es');
    assert.match(asked[0], /^Target language: English\./);
    assert.strictEqual(Buffer.from(r.audio, 'base64').toString(), 'mp3:How much is the room?');
    assert.deepStrictEqual(await it.interpret(Buffer.from('a'), 'audio/wav', {}), { ok: true, heard: '' });
  });

  console.log(process.exitCode ? 'some FAILED' : `${passed} passed`);
})();
