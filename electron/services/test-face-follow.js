// TEST — follow-me controller (faces in, gimbal speeds out). Offline.
// Run: node electron/services/test-face-follow.js
'use strict';
const assert = require('assert');
const { createFollowController } = require('./face-follow');

let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n${e.stack}`); process.exitCode = 1; } };
const face = (cx, cy, s = 0.16) => ({ x: cx - s / 2, y: cy - s / 2, w: s, h: s });
const opts = { smooth: 1 };

t('centred face: no movement', () => {
  const c = createFollowController(opts);
  assert.deepStrictEqual(c.step([face(0.5, 0.38)]), []);
});

t('face on the right: turn right; face low: tilt down', () => {
  const c = createFollowController(opts);
  const out = c.step([face(0.8, 0.7)]);
  assert.deepStrictEqual(out.map((o) => o.dir), ['right', 'down']);
  assert.ok(out.every((o) => o.speed > 0));
});

t('slows down near the target, stops inside it (hysteresis)', () => {
  const c = createFollowController(opts);
  c.step([face(0.8, 0.38)]);
  const slower = c.step([face(0.58, 0.38)]);
  assert.strictEqual(slower.length, 1, 'still outside the stop band: keeps going, slower');
  assert.ok(slower[0].dir === 'right' && slower[0].speed > 0);
  assert.deepStrictEqual(c.step([face(0.53, 0.38)]), [{ dir: 'right', speed: 0 }]);
});

t('switching sides stops the old direction first', () => {
  const c = createFollowController(opts);
  c.step([face(0.8, 0.38)]);
  const out = c.step([face(0.2, 0.38)]);
  assert.deepStrictEqual(out[0], { dir: 'right', speed: 0 });
  assert.strictEqual(out[1].dir, 'left');
});

t('speed is capped', () => {
  const c = createFollowController({ ...opts, maxSpeed: 20 });
  assert.ok(c.step([face(1, 0.38)]).every((o) => o.speed <= 20));
});

t('face lost: keeps going briefly, then stops everything', () => {
  const c = createFollowController(opts);
  c.step([face(0.9, 0.9)], 1000);
  assert.deepStrictEqual(c.step([], 1300), []);
  const out = c.step([], 2000);
  assert.deepStrictEqual(out.map((o) => o.speed), [0, 0]);
  assert.deepStrictEqual(c.step([], 3000), []);
});

t('follows the biggest (closest) face', () => {
  const c = createFollowController(opts);
  const out = c.step([face(0.1, 0.38, 0.05), face(0.85, 0.38, 0.3)]);
  assert.strictEqual(out[0].dir, 'right');
});

t('halt zeroes whatever is moving', () => {
  const c = createFollowController(opts);
  c.step([face(0.9, 0.9)]);
  assert.deepStrictEqual(c.halt().map((o) => o.speed), [0, 0]);
  assert.deepStrictEqual(c.halt(), []);
});

console.log(`\n${n} passed`);
