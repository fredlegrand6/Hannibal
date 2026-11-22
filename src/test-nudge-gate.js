'use strict';
// Fred's four tests for when a nudge may be spoken (src/nudge-gate.js).
const assert = require('assert');
const { canDeliver, isQuietRequest } = require('./nudge-gate');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };
const S = 1000;
const base = { now: 100 * S, idleMs: 25 * S, lastHeardAt: 0, lastSpokeAt: 0, fredTalking: false, hannibalBusy: false, confirmPending: false, quietMode: false };
const at = (over) => canDeliver({ ...base, ...over }).ok;

t('1. mid-conversation: not spoken until ~25 s of silence', () => {
  assert.strictEqual(at({ lastHeardAt: 95 * S }), false, '5 s after Fred');
  assert.strictEqual(at({ lastSpokeAt: 90 * S }), false, '10 s after Hannibal answered');
  assert.strictEqual(at({ lastHeardAt: 80 * S, lastSpokeAt: 76 * S }), false, '20 s');
  assert.strictEqual(at({ lastHeardAt: 74 * S, lastSpokeAt: 70 * S }), true, '26 s of quiet');
  assert.strictEqual(at({ lastHeardAt: 74 * S, fredTalking: true }), false, 'never while Fred talks');
  assert.strictEqual(at({ lastHeardAt: 74 * S, hannibalBusy: true }), false, 'never while Hannibal speaks or works');
  assert.strictEqual(at({ lastHeardAt: 85 * S, idleMs: 10 * S }), true, 'the gap is configurable');
});

t('2. a pending yes/no: the nudge waits until it is answered', () => {
  assert.strictEqual(at({ confirmPending: true }), false);
  assert.strictEqual(at({ confirmPending: true, urgent: true }), false, 'even an urgent one');
  assert.strictEqual(at({ confirmPending: false }), true);
});

t('3. "stay quiet": no nudges until Fred speaks to Hannibal again', () => {
  for (const q of ['Stay quiet for now', "We're busy", 'Not now, Hannibal', 'Ik ben bezig', 'Even stil', 'Pas maintenant', 'Estoy ocupado'])
    assert.ok(isQuietRequest(q), q);
  for (const q of ['What is on my calendar?', 'Send it to Jay', 'Yes'])
    assert.ok(!isQuietRequest(q), q);
  assert.strictEqual(at({ quietMode: true }), false);
  assert.strictEqual(at({ quietMode: false }), true, 'he spoke to Hannibal again: quiet mode is off');
});

t("4. urgent: right after Fred's current sentence ends, no 25 s wait", () => {
  assert.strictEqual(at({ urgent: true, fredTalking: true }), false, 'not over his sentence');
  assert.strictEqual(at({ urgent: true, lastHeardAt: 99.5 * S }), true, 'as soon as he stops');
  assert.strictEqual(at({ urgent: true, quietMode: true }), true, 'a meeting in 4 minutes beats "stay quiet"');
  assert.strictEqual(at({ urgent: true, hannibalBusy: true }), false, 'not over his own sentence either');
});

console.log(`\n${n} passed`);
