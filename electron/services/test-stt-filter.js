// TEST — the speech filter (silence, Whisper's scores, phantom lines, confidence).
// Run: node electron/services/test-stt-filter.js
'use strict';
const assert = require('assert');
const F = require('./stt-filter');
const { transcribe, PROMPT } = require('./stt-server');
let n = 0; const pending = [];
const t = (name, fn) => pending.push(async () => {
  try { await fn(); n++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n${e.stack}`); process.exitCode = 1; }
});

// 16 kHz mono 16-bit PCM wav: `parts` = [[ms, amplitude], ...] (sine at 220 Hz; 0 = silence, small = room noise)
function wav(parts) {
  const samples = [];
  for (const [ms, amp] of parts) {
    for (let i = 0; i < ms * 16; i++) samples.push(amp ? Math.round(amp * Math.sin(i / 16000 * 2 * Math.PI * 220) + (Math.random() - 0.5) * 40) : Math.round((Math.random() - 0.5) * 40));
  }
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0, 'ascii');
  samples.forEach((v, i) => b.writeInt16LE(Math.max(-32768, Math.min(32767, v)), 44 + i * 2));
  return b;
}
const noLog = () => {};
const seg = (text, avg = -0.2, ns = 0.02) => ({ text, avg_logprob: avg, no_speech_prob: ns });
const fakeEngine = (segments) => async () => ({ text: segments.map((s) => s.text).join(''), segments });
const run = (audio, segments, drops = []) => transcribe(audio, 'en', 'en', {
  toWav: async (x) => x,
  inference: segments ? fakeEngine(segments) : async () => { throw new Error('Whisper must not be called'); },
  logDrop: (d) => drops.push(d),
});

t('a silent 2-second clip never reaches Whisper (so nothing reaches the brain)', async () => {
  const drops = [];
  const r = await run(wav([[2000, 0]]), null, drops);
  assert.strictEqual(r.text, '');
  assert.strictEqual(drops[0].reason, 'silence');
});
t('a 2-second clip with only a tiny blip (< 250 ms of voice) is dropped as silence', async () => {
  const r = await run(wav([[900, 0], [120, 6000], [980, 0]]), null);
  assert.strictEqual(r.text, '');
  assert.strictEqual(r.dropped, 'silence');
});
t('a short clear "ja" (~300 ms) still gets through', async () => {
  const r = await run(wav([[500, 0], [320, 5000], [500, 0]]), [seg(' Ja.')]);
  assert.strictEqual(r.text, 'Ja.');
});
t('a clip that comes out as "This is a production of WGBH" is dropped', async () => {
  const drops = [];
  const r = await run(wav([[300, 0], [1500, 4000], [300, 0]]), [seg(' This is a production of WGBH.')], drops);
  assert.strictEqual(r.text, '');
  assert.ok(drops.some((d) => d.reason === 'blocklist'));
});
t('a normal clear command ("volume up") comes through with high confidence', async () => {
  const r = await run(wav([[300, 0], [800, 5000], [300, 0]]), [seg(' Volume up.', -0.15, 0.01)]);
  assert.strictEqual(r.text, 'Volume up.');
  assert.strictEqual(r.confidence, 'high');
});
t('"pleasure day" that Whisper was unsure of comes through marked low', async () => {
  const r = await run(wav([[300, 0], [700, 3000], [300, 0]]), [seg(' Pleasure day.', -1.05, 0.2)]);
  assert.strictEqual(r.text, 'Pleasure day.');
  assert.strictEqual(r.confidence, 'low');
});
t('"Do you like digital meat?" said clearly stays as it is (Fred really said it)', async () => {
  const r = await run(wav([[300, 0], [1200, 4000], [300, 0]]), [seg(' Do you like digital meat?', -0.3, 0.02)]);
  assert.strictEqual(r.text, 'Do you like digital meat?');
});

t('Whisper scores: no-speech + low logprob segment dropped, repeat loop dropped, good kept', () => {
  const { kept, dropped } = F.keepSegments(F.segmentsOf({ segments: [
    seg(' Play some music.'),
    seg(' Clark Gold.', -1.3, 0.8),
    seg(' the the the the the the the the the the the the the the the the', -0.3, 0.1),
  ] }));
  assert.deepStrictEqual(kept.map((s) => s.text.trim()), ['Play some music.']);
  assert.deepStrictEqual(dropped.map((d) => d.detail), ['no speech', 'repeat loop']);
});
t('high no_speech_prob alone (Whisper still sure of the words) is kept', () => {
  const { kept } = F.keepSegments([{ text: 'Hannibal, pause.', avg_logprob: -0.3, no_speech_prob: 0.7, compression_ratio: 1 }]);
  assert.strictEqual(kept.length, 1);
});

const list = F.loadBlocklist();
t('the phantom-line list loads from its config file', () => {
  assert.ok(list.length >= 9);
  assert.ok(list.some((e) => e.phrase === 'this is a production of wgbh'));
});
t('phantom lines: whole match dropped, any case, close spellings too', () => {
  for (const line of ['Thanks for watching!', 'THANK YOU FOR WATCHING.', 'Thanks for watchin.', 'Please subscribe.', 'This is a production of W.G.B.H.'])
    assert.strictEqual(F.applyBlocklist(line, list).text, '', line);
});
t('phantom lines: credit lines starting with a listed word are dropped', () => {
  for (const line of ['Subtitles by the Amara.org community', 'Ondertiteling door de NPO.', 'Sous-titres réalisés par la communauté.', 'Copyright 2024.'])
    assert.strictEqual(F.applyBlocklist(line, list).text, '', line);
});
t('phantom lines: only the phantom part is cut from a real line', () => {
  assert.strictEqual(F.applyBlocklist('Set a reminder for nine. Thanks for watching!', list).text, 'Set a reminder for nine.');
  assert.strictEqual(F.applyBlocklist('Open Spotify thanks for watching', list).text, 'Open Spotify');
});
t('lines that are only "you", dots or music notes are dropped', () => {
  for (const line of ['you', 'You.', '...', '♪ ♪', '🎵']) assert.strictEqual(F.applyBlocklist(line, list).text, '', line);
});
t('real lines are left alone', () => {
  for (const line of ['Thank you, Hannibal, that was great.', 'Who owns the copyright on that logo?', 'You are the best.', 'Press play.'])
    assert.strictEqual(F.applyBlocklist(line, list).text, line, line);
});
t('a line that is only the hint words echoed back is dropped', () => {
  const v = F.judge({ segments: [seg(' Hannibal, Fred, Mandy, Gaian, Jay.')] }, { prompt: PROMPT, blocklist: list });
  assert.strictEqual(v.text, '');
  assert.ok(F.judge({ segments: [seg(" Hannibal, play Spotify.")] }, { prompt: PROMPT, blocklist: list }).text);   // a real command made of hint words stays
});
t('confidence: low for unsure or tiny unsure lines, high for clear ones, medium without scores', () => {
  assert.strictEqual(F.rateConfidence([seg('Volume up.', -0.1, 0.01)]), 'high');
  assert.strictEqual(F.rateConfidence([seg('Mm.', -0.6, 0.1)]), 'low');
  assert.strictEqual(F.rateConfidence([seg('What is on my calendar for tomorrow?', -0.55, 0.1)]), 'medium');
  assert.strictEqual(F.rateConfidence([seg('Best up.', -0.9, 0.1)]), 'low');
  assert.strictEqual(F.rateConfidence([{ text: 'Hello there.' }]), 'medium');
});
t('every drop is written to the log with its reason', () => {
  const os = require('os'); const fs = require('fs'); const path = require('path');
  const file = path.join(os.tmpdir(), `stt-drop-test-${process.pid}.log`);
  F.logDrop({ reason: 'silence', detail: 'only 0 ms of voice' }, noLog, file);
  F.logDrop({ reason: 'blocklist', detail: 'thanks for watching', text: 'Thanks for watching!' }, noLog, file);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  fs.unlinkSync(file);
  assert.deepStrictEqual(lines.map((l) => l.reason), ['silence', 'blocklist']);
  assert.ok(lines[0].at);
});

(async () => { for (const p of pending) await p(); console.log(`\n${n} passed`); })();
