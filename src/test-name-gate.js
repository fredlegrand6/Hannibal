// TEST — "Hannibal" as the wake word. Run: node src/test-name-gate.js
'use strict';
const assert = require('assert');
const { decide, stripName, mentionsName } = require('./name-gate');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n${e.stack}`); process.exitCode = 1; } };
const NOW = 1_000_000;

t('hears his name in the ways Whisper writes it', () => {
  for (const s of ['Hannibal, open Spotify', 'hey hannibal what time is it', 'Hanibal?', 'Okay Hannible, play music', 'what do you think, Hannibal?'])
    assert.ok(mentionsName(s), s);
  for (const s of ['open Spotify', 'the cannibal movie', 'Hannah called', 'channel four']) assert.ok(!mentionsName(s), s);
});

t('also hears the live mishearings ("They handle looks in the camera")', () => {
  for (const s of ['They handle looks in the camera', 'The handle, what time is it', 'Hey, Hanni Ball open Spotify', 'Handy ball?', 'Hanna bell, play music'])
    assert.ok(mentionsName(s), s);
  assert.strictEqual(stripName('They handle looks in the camera'), 'looks in the camera');
  for (const s of ['hold it by the handle', 'they handle the money', 'I can handle it']) assert.ok(!mentionsName(s) || /^they handle/i.test(s), s);
});

t('strips the name from the request', () => {
  assert.strictEqual(stripName('Hannibal, open Spotify'), 'open Spotify');
  assert.strictEqual(stripName('Hey Hannibal what time is it'), 'what time is it');
  assert.strictEqual(stripName('what do you think, Hannibal?'), 'what do you think');
  assert.strictEqual(stripName('Hannibal.'), '');
});

t('room talk without his name is ignored', () => {
  const d = decide('yeah I will call him tomorrow', { now: NOW, lastSpokeAt: NOW - 5 * 60000 });
  assert.strictEqual(d.answer, false);
});

t('with his name: answers, without the name in the text', () => {
  const d = decide('Hannibal, what is on my calendar', { now: NOW });
  assert.deepStrictEqual([d.answer, d.text, d.why], [true, 'what is on my calendar', 'name']);
});

t('just "Hannibal" → acts like a wake word', () => {
  const d = decide('Hey Hannibal.', { now: NOW });
  assert.ok(d.answer && d.nameOnly);
});

t('follow-ups within 20 s of his reply need no name', () => {
  assert.ok(decide('and tomorrow?', { now: NOW, lastSpokeAt: NOW - 8000 }).answer);
  assert.ok(!decide('and tomorrow?', { now: NOW, lastSpokeAt: NOW - 25000 }).answer);
});

t('a pending yes/no or the wake word lets it through', () => {
  assert.ok(decide('yes', { now: NOW, pending: true }).answer);
  assert.ok(decide('open Chrome', { now: NOW, wokeAt: NOW - 3000 }).answer);
});

t('Whisper\'s morning spellings count as his name', () => {
  for (const said of ['Annable.', 'Anable?', 'Hannable, are you there', 'Annabel', 'Hanibel what time is it']) assert.ok(decide(said, { now: NOW }).answer, said);
  for (const said of ['a table for two', 'the cable is loose', 'unable to come', 'animal planet']) assert.ok(!decide(said, { now: NOW }).answer, said);
});

t('gate off answers everything (old behaviour)', () => {
  assert.ok(decide('anything at all', { now: NOW, enabled: false }).answer);
});

console.log(`\n${n} passed`);
