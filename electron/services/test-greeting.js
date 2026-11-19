// TEST — greeting when Fred walks in. Run: node electron/services/test-greeting.js
'use strict';
const assert = require('assert');
const { createArrivalWatch, greetingFor } = require('./face-follow');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n${e.stack}`); process.exitCode = 1; } };
const MIN = 60000;

t('no greeting at start-up while Fred is sitting there', () => {
  const w = createArrivalWatch({ awayMs: 10 * MIN, now: 0 });
  for (let s = 0; s < 60; s++) assert.strictEqual(w.see(true, s * 1000), null);
});

t('greets once after 10+ min away, after 1.5 s of steady sighting', () => {
  const w = createArrivalWatch({ awayMs: 10 * MIN, now: 0 });
  w.see(true, 0);
  for (let s = 1; s <= 12 * 60; s += 5) w.see(false, s * 1000);
  const back = 12 * MIN;
  assert.strictEqual(w.see(true, back), null, 'not on the first glimpse');
  const a = w.see(true, back + 1600);
  assert.ok(a && a.arrived);
  assert.ok(Math.abs(a.awayMs - back) < 10000, `away ~12 min, got ${a.awayMs}`);
  assert.strictEqual(w.see(true, back + 3000), null, 'only once');
});

t('a short absence (coffee in 5 min) is not an arrival', () => {
  const w = createArrivalWatch({ awayMs: 10 * MIN, now: 0 });
  w.see(true, 0);
  assert.strictEqual(w.see(true, 5 * MIN), null);
  assert.strictEqual(w.see(true, 5 * MIN + 2000), null);
});

t('a passing glimpse does not trigger it', () => {
  const w = createArrivalWatch({ awayMs: 10 * MIN, now: 0 });
  w.see(true, 0);
  assert.strictEqual(w.see(true, 20 * MIN), null);
  w.see(false, 20 * MIN + 500);
  w.see(false, 20 * MIN + 5000);
  assert.strictEqual(w.see(true, 20 * MIN + 9000), null, 'new run starts here');
  const a = w.see(true, 20 * MIN + 10600);
  assert.ok(a, 'greets once he stays');
  assert.ok(a.awayMs >= 20 * MIN, 'away time counts from when he left, not the glimpse');
});

t('greeting fits the time of day and how long he was gone', () => {
  const at = (h) => new Date(Date.UTC(2026, 10, 19, h - 1, 0)); // Amsterdam = UTC+1
  assert.match(greetingFor({ awayMs: 10 * 3600000, date: at(8), pick: () => 0 }), /Good morning, Fred/);
  assert.match(greetingFor({ awayMs: 3 * 3600000, date: at(15), pick: () => 0 }), /about 3 hours/);
  assert.match(greetingFor({ awayMs: 15 * MIN, date: at(15), pick: () => 0 }), /Welcome back/);
  assert.match(greetingFor({ awayMs: 10 * 3600000, date: at(21), pick: () => 0 }), /Good evening/);
});

console.log(`\n${n} passed`);
