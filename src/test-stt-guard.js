// TEST — ask, don't guess (src/stt-guard.js). Run: node src/test-stt-guard.js
'use strict';
const assert = require('assert');
const G = require('./stt-guard');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n${e.stack}`); process.exitCode = 1; } };
const volumeUp = { kind: 'mac', action: 'volume-up', reply: 'Volume up.' };

t('a normal clear command ("volume up") runs as before, no extra question', () => {
  assert.deepStrictEqual(G.commandPlan(volumeUp, 'Volume up.', 'high'), { run: true, reply: 'Volume up.' });
  assert.deepStrictEqual(G.commandPlan(volumeUp, 'Volume up.', 'medium'), { run: true, reply: 'Volume up.' });
  assert.deepStrictEqual(G.commandPlan(volumeUp, 'Volume up.', null), { run: true, reply: 'Volume up.' });
  assert.strictEqual(G.brainNote({ text: 'What is on my calendar tomorrow?', confidence: 'high' }), '\nSPEECH-TO-TEXT: confidence high.');
});
t('an unsure harmless command still runs, but says what it understood', () => {
  const p = G.commandPlan({ kind: 'mac', action: 'spotify-play', reply: 'Playing.' }, 'Press play.', 'low');
  assert.deepStrictEqual(p, { run: true, reply: 'I heard "Press play". Playing.' });
});
t('an unsure command that is not harmless does not run: he asks for it again', () => {
  const p = G.commandPlan({ kind: 'mac', action: 'quit-app', params: 'Safari', reply: 'Quitting Safari.' }, 'Quit Safari.', 'low');
  assert.strictEqual(p.run, false);
  assert.match(p.say, /I heard "Quit Safari"/);
  assert.strictEqual(G.commandPlan({ kind: 'mac', action: 'lock' }, 'lock', 'low').run, false);
});
t('"pleasure day" with low confidence right after music talk → the brain is told to check ("did you mean press play?")', () => {
  const note = G.brainNote({ text: 'Pleasure day.', confidence: 'low', prevLine: 'Put some music on Spotify', lastTask: 'spotify' });
  assert.match(note, /confidence low/);
  assert.match(note, /Heard exactly: "Pleasure day"/);
  assert.match(note, /previous line: "Put some music on Spotify"/);
  assert.match(note, /did you mean press play/);
  assert.match(note, /NOT sure/);
});
t('"Mm" or "No, there\'s no way" with no context → no mood is read, the brain asks neutrally', () => {
  for (const [line, conf] of [['Mm.', 'medium'], ["No, there's no way.", 'low'], ["No, there's no way.", 'medium']]) {
    assert.strictEqual(G.shouldReadMood(line, conf), false, line);
    const note = G.brainNote({ text: line, confidence: conf });
    assert.match(note, /Do not read a mood or feeling into it/, line);
    assert.match(note, /ask once/, line);
  }
  assert.strictEqual(G.shouldReadMood('I am really fed up with this server today', 'high'), true);
});
t('a low-confidence "send WhatsApp to ..." → he states it back before the yes/no', () => {
  const now = Date.now();
  const echo = G.writeEcho({ text: 'Send a WhatsApp to Mandy saying I am late.', confidence: 'low', at: now - 5000 }, now);
  assert.strictEqual(echo, 'I want to be sure I heard you right. I heard "Send a WhatsApp to Mandy saying I am late".');
  assert.strictEqual(G.writeEcho({ text: 'Send a WhatsApp to Mandy.', confidence: 'high', at: now }, now), '');
  assert.strictEqual(G.writeEcho({ text: 'Send it.', confidence: 'low', at: now - G.UNSURE_MS - 1 }, now), '');
  assert.strictEqual(G.writeEcho(null, now), '');
});
t('an unsure line is not stored as a memory', () => {
  assert.strictEqual(G.shouldRemember('low'), false);
  assert.strictEqual(G.shouldRemember('high'), true);
  assert.strictEqual(G.shouldRemember(null), true);
});
console.log(`\n${n} passed`);
