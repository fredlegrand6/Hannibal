// TEST — place reminders (offline). Run: node server/test-place-reminders.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPlaceReminders } = require('./place-reminders');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.stack || e.message}`); process.exitCode = 1; }
}
console.log('place reminders');
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-')), 'p.json');
let changes = 0;
const p = createPlaceReminders({ filePath: file, onChange: () => { changes += 1; } });

test('add needs a message and a place; arrive is the default', () => {
  assert.strictEqual(p.add('', 'Ibiza').ok, false);
  const r = p.add('Call Jay', 'Ibiza airport');
  assert.deepStrictEqual([r.ok, r.on, r.place], [true, 'arrive', 'Ibiza airport']);
  assert.strictEqual(p.add('Lock the door', 'Revalis office, Abcoude', 'leave').on, 'leave');
  assert.strictEqual(changes, 2);
});

test('saved to disk and read back by a fresh store', () => {
  const again = createPlaceReminders({ filePath: file });
  assert.deepStrictEqual(again.upcoming().reminders.map((r) => r.message), ['Call Jay', 'Lock the door']);
});

test('fired once only, then gone from the list', () => {
  const id = p.upcoming().reminders[0].id;
  assert.strictEqual(p.fired(id).message, 'Call Jay');
  assert.strictEqual(p.fired(id), null);
  assert.deepStrictEqual(p.upcoming().reminders.map((r) => r.message), ['Lock the door']);
});

test('failed is recorded and leaves the list', () => {
  const r = p.add('Buy milk', 'Nowhereville 999');
  assert.strictEqual(p.failed(r.id, 'not found').place, 'Nowhereville 999');
  assert.ok(!p.upcoming().reminders.some((x) => x.id === r.id));
});

test('cancel by words; ambiguous asks which', () => {
  p.add('Buy bread', 'Bussum');
  p.add('Buy wine', 'Bussum');
  assert.strictEqual(p.cancel('bussum').ok, false);
  assert.strictEqual(p.cancel('bread').cancelled.message, 'Buy bread');
  assert.strictEqual(p.cancel('nothing like it').ok, false);
});

test('at most 18 at once (iPhone geofence limit)', () => {
  for (let i = 0; i < 30; i += 1) p.add(`r${i}`, 'X');
  assert.ok(p.upcoming().reminders.length <= 18);
});

console.log(`\n${passed} passed`);
