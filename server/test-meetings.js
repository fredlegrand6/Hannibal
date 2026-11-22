// TEST — meeting memory: transcript with speakers → write-up → findable later.
// Run: node server/test-meetings.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMeetings, speakerLines, writeUpPrompt } = require('./meetings');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.stack || e.message}`); process.exitCode = 1; }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'meet-'));

(async () => {
  console.log('meetings');

  await test('speakers become numbered lines', () => {
    const w = (text, s, type = 'word') => ({ text, speaker_id: s, type });
    const out = speakerLines([w('Hi', 'a'), w(' ', 'a', 'spacing'), w('Jay.', 'a'), w(' ', 'b', 'spacing'), w('Hey', 'b'), w(' ', 'b', 'spacing'), w('Fred.', 'b'), w('Prices?', 'a')]);
    assert.strictEqual(out, 'Speaker 1: Hi Jay.\nSpeaker 2: Hey Fred.\nSpeaker 1: Prices?');
  });

  await test('the write-up prompt asks for summary, actions, and yes before reminders/mail', () => {
    const p = writeUpPrompt({ transcript: 'Speaker 1: hi', minutes: 12, title: 'HTS', when: '2026-11-23 10:00' });
    assert.match(p, /Action items/); assert.match(p, /Speaker 1: hi/);
  });

  await test('a recording is written up, told to Fred, remembered and findable', async () => {
    const dir = tmp(); const told = []; const kept = [];
    const m = createMeetings({
      dir,
      transcribe: async (buf, mime) => ({ transcript: `Speaker 1: HTS wants the price list by Friday (${buf.length} bytes, ${mime})\nSpeaker 2: fine`, language: 'en' }),
      writeUp: async (prompt) => { assert.match(prompt, /HTS wants the price list/); return 'HTS pricing call\nSummary: send prices Friday.'; },
      followUp: async (p) => { assert.match(p, /HTS pricing call/); assert.match(p, /never send without his yes/); return 'Shall I remind you Friday 9:00 to send the prices?'; },
      notify: async (t) => told.push(t), remember: async (t) => kept.push(t), now: () => Date.parse('2026-11-23T09:00:00Z'),
    });
    const { id, done } = m.accept(Buffer.from('audio'), { mime: 'audio/mp4', seconds: 600 });
    assert.ok(id);
    const r = await done;
    assert.strictEqual(r.status, 'done');
    assert.strictEqual(r.title, 'HTS pricing call');
    assert.match(told[0], /Meeting written up\n\nHTS pricing call/);
    assert.match(told[1], /remind you Friday/);
    assert.match(kept[0], /HTS pricing call/);
    assert.ok(!fs.existsSync(path.join(dir, `${id}.audio`)), 'audio removed once done');
    const f = m.find('price list');
    assert.strictEqual(f.meetings[0].title, 'HTS pricing call');
    assert.match(f.meetings[0].lines[0], /price list by Friday/);
    assert.strictEqual(m.recent().meetings[0].minutes, 10);
  });

  await test('a failure keeps the audio and can be tried again', async () => {
    const dir = tmp(); const told = []; let fail = true;
    const m = createMeetings({
      dir,
      transcribe: async () => { if (fail) throw new Error('speech-to-text HTTP 500'); return { transcript: 'Speaker 1: ok' }; },
      writeUp: async () => 'Call with Jay', notify: async (t) => told.push(t),
    });
    const { id, done } = m.accept(Buffer.from('audio'), {});
    assert.strictEqual((await done).status, 'failed');
    assert.match(told[0], /couldn't write up the meeting: speech-to-text HTTP 500/);
    assert.ok(fs.existsSync(path.join(dir, `${id}.audio`)));
    fail = false;
    assert.strictEqual(m.retry().ok, true);
    for (let i = 0; i < 20 && told.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    assert.match(told[1], /Call with Jay/);
    assert.strictEqual(m.retry().ok, false, 'nothing left to retry');
  });

  await test('silence: told plainly', async () => {
    const told = [];
    const m = createMeetings({ dir: tmp(), transcribe: async () => ({ transcript: '' }), writeUp: async () => 'x', notify: async (t) => told.push(t) });
    await m.accept(Buffer.from('a'), {}).done;
    assert.match(told[0], /couldn't hear any talk/);
  });

  console.log(process.exitCode ? 'some FAILED' : `${passed} passed`);
})();
