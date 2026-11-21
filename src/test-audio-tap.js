// TEST — the always-open mic buffer. Run: node src/test-audio-tap.js
'use strict';
const assert = require('assert');
const { createRing, downsample, encodeWav } = require('./audio-tap');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n${e.stack}`); process.exitCode = 1; } };
const seq = (a, b) => Float32Array.from({ length: b - a }, (_, i) => a + i);

t('a turn includes the pre-roll from before it opened', () => {
  const r = createRing(10, 10);            // 10 Hz, 10 s → 100 samples
  r.write(seq(0, 30));
  const mark = r.total;                    // turn opens at sample 30
  r.write(seq(30, 50));
  assert.deepStrictEqual(Array.from(r.read(mark - 8)), Array.from(seq(22, 50)));
});
t('old audio that fell out of the ring is clamped, not garbage', () => {
  const r = createRing(10, 1);             // 10 samples
  r.write(seq(0, 25));
  assert.deepStrictEqual(Array.from(r.read(0)), Array.from(seq(15, 25)));
});
t('48 kHz → 16 kHz keeps a third of the samples', () => {
  assert.strictEqual(downsample(new Float32Array(48000), 48000, 16000).length, 16000);
  assert.deepStrictEqual(Array.from(downsample(Float32Array.from([1, 1, 1, 4, 4, 4]), 3, 1)), [1, 4]);
});
t('writes a valid 16-bit mono WAV', () => {
  const w = encodeWav(Float32Array.from([0, 1, -1]), 16000);
  const s = Buffer.from(w);
  assert.strictEqual(s.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(s.toString('ascii', 8, 12), 'WAVE');
  assert.strictEqual(s.readUInt32LE(24), 16000);
  assert.strictEqual(s.length, 44 + 6);
  assert.strictEqual(s.readInt16LE(46), 32767);
  assert.strictEqual(s.readInt16LE(48), -32768);
});
console.log(`\n${n} passed`);
