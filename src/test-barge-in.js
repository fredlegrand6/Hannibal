// node src/test-barge-in.js
const assert = require('assert');
const B = require('./barge-in');
const { mentionsName } = require('./name-gate');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('✓', name); };
const said = ['Your next meeting is at three with the team from HTS.', 'After that you have a call with Jay.'];

t('his own voice through the speakers is ignored', () => {
  assert.strictEqual(B.decide('your next meeting is at three with the team', said, { mentionsName }).barge, false);
});
t('his name stops him', () => {
  const d = B.decide('Hannibal, what about tomorrow?', said, { mentionsName });
  assert.ok(d.barge); assert.strictEqual(d.why, 'name');
});
t('stop words in four languages', () => {
  for (const s of ['stop', 'wacht even', 'attends', 'espera', 'okay okay']) {
    const d = B.decide(s, said, { mentionsName }); assert.ok(d.barge, s); assert.ok(d.stopOnly, s);
  }
});
t('Fred saying something new stops him', () => {
  assert.ok(B.decide('no I meant the other client', said, { mentionsName }).barge);
});
t('a stray word does not', () => {
  assert.strictEqual(B.decide('hmm', said, { mentionsName }).barge, false);
  assert.strictEqual(B.decide('', said, { mentionsName }).barge, false);
});
t('watcher: onset after sustained level, done after quiet', () => {
  const w = B.createWatcher();
  for (let i = 0; i < 40; i++) assert.strictEqual(w.push(0.01), null);   // room + echo
  let ev = null; for (let i = 0; i < 10 && !ev; i++) ev = w.push(0.2);
  assert.strictEqual(ev, 'onset');
  ev = null; for (let i = 0; i < 20 && !ev; i++) ev = w.push(0.005);
  assert.strictEqual(ev, 'done');
});
t('watcher: a short click is not an onset', () => {
  const w = B.createWatcher();
  for (let i = 0; i < 20; i++) w.push(0.01);
  assert.strictEqual(w.push(0.3), null); assert.strictEqual(w.push(0.3), null);
  assert.strictEqual(w.push(0.01), null); assert.strictEqual(w.active, false);
});
t('his name or "stop" counts even buried in his own echo', () => {
  const d = B.decide('your next meeting is at three Hannibal stop with the team', said, { mentionsName });
  assert.ok(d.barge); assert.strictEqual(d.why, 'name');
  assert.ok(B.decide('after that you have a call stop', said, { mentionsName }).barge);
  assert.ok(B.decide('Hannibal stopp', said, { mentionsName }).stopOnly);
});
t('a stop word he says himself is not Fred', () => {
  assert.strictEqual(B.decide('the bus stop is close', ['The bus stop is close to the office.'], { mentionsName }).barge, false);
});
t('watcher: speech with gaps (or empty mic ticks) still counts', () => {
  const w = B.createWatcher({ minBar: 0.01 });
  for (let i = 0; i < 20; i++) w.push(0.002);
  let ev = null; for (let i = 0; i < 20 && !ev; i++) ev = w.push(i % 2 ? 0 : 0.2);
  assert.strictEqual(ev, 'onset');
});
console.log(`${n} passed`);
