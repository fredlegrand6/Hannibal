// TEST — who is talking (speaker-id.js) + the speech server passing it on.
// Run: node electron/services/test-speaker-id.js   (no Python, no model: a fake voice embedder)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSpeakerId, classify, cosine, speechSeconds, ENROL_SENTENCES } = require('./speaker-id');
const stt = require('./stt-server');

let n = 0;
const pending = [];
const t = (name, fn) => pending.push([name, fn]);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-who-'));
// A fake "voice": byte 44 of the wav says whose voice it is; the clip length is real.
const voice = (who) => { const v = new Array(192).fill(0); v[who] = 1; v[(who + 7) % 192] = 0.3; return v; };
const wav = (who, seconds) => { const b = Buffer.alloc(44 + Math.round((seconds + 0.7) * 32000)); b[44] = who; return b; };
const fakeEmbed = async (w) => {
  const who = w[44];
  if (who === 0) return voice(0);                                         // Fred
  if (who === 1) { const v = voice(0); v[0] = 0.9; v[50] = 0.35; return v; } // Fred, another day
  return voice(who);                                                      // someone else
};
const make = (over = {}) => createSpeakerId({ embed: fakeEmbed, printFile: path.join(tmp, `print-${Math.random()}.json`), logFile: path.join(tmp, `who-${Math.random()}.log`), log: () => {}, ...over });

t('similarity → fred / other / unknown with a score', () => {
  assert.deepStrictEqual(classify(0.56).tag, 'fred');
  assert.ok(classify(0.56).score >= 0.9, classify(0.56));
  assert.strictEqual(classify(0.05).tag, 'other');
  assert.strictEqual(classify(0.21).tag, 'other');
  assert.strictEqual(classify(0.35).tag, 'unknown');
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9);
  assert.strictEqual(cosine([1, 0], [0, 1]), 0);
  assert.ok(Math.abs(speechSeconds(wav(0, 2)) - 2) < 0.01);
});

t('before enrolment every line is "unknown" (Hannibal behaves as before)', async () => {
  const s = make();
  assert.strictEqual(s.status().enrolled, false);
  assert.deepStrictEqual(await s.tag(wav(0, 3)), { tag: 'unknown', score: 0, why: 'not enrolled' });
});

t('guided enrolment: five sentences, too-short ones refused, voiceprint saved locally', async () => {
  const s = make();
  assert.strictEqual(ENROL_SENTENCES.length, 5);
  s.enrolStart();
  const short = await s.enrolAdd(wav(0, 0.8));
  assert.strictEqual(short.ok, false); assert.strictEqual(short.why, 'too short');
  assert.strictEqual(s.enrolFinish().ok, false, 'needs at least 3 good sentences');
  for (let i = 0; i < 4; i++) assert.ok((await s.enrolAdd(wav(i % 2, 2.5))).ok);
  assert.strictEqual(s.status().enrolling.count, 4);
  const f = s.enrolFinish();
  assert.ok(f.ok, JSON.stringify(f)); assert.strictEqual(f.samples, 4);
  assert.ok(fs.existsSync(s.printFile));
  const saved = JSON.parse(fs.readFileSync(s.printFile, 'utf8'));
  assert.strictEqual(saved.centroid.length, 192);
  assert.ok(!s.printFile.includes(`${path.sep}data${path.sep}`), 'never in data/ (that folder goes to GitHub)');
  // A restart reads it back.
  const again = make({ printFile: s.printFile });
  assert.strictEqual(again.status().enrolled, true);
});

t('after enrolment: Fred → fred, another voice → other, a short "yes" → unknown', async () => {
  const s = make();
  s.enrolStart();
  for (let i = 0; i < 3; i++) await s.enrolAdd(wav(0, 2));
  s.enrolFinish();
  const fred = await s.tag(wav(1, 2.5));
  assert.strictEqual(fred.tag, 'fred', JSON.stringify(fred));
  assert.ok(fred.score >= 0.75);
  const guest = await s.tag(wav(9, 2.5));
  assert.strictEqual(guest.tag, 'other', JSON.stringify(guest));
  assert.ok(guest.score >= 0.75);
  assert.deepStrictEqual(await s.tag(wav(9, 0.6)), { tag: 'unknown', score: 0, why: 'too short' });
});

t('no voice model on the Mac → unknown, never an error', async () => {
  const s = make({ embed: async () => null });
  s.enrolStart();
  const r = await s.enrolAdd(wav(0, 2));
  assert.strictEqual(r.ok, false); assert.strictEqual(r.why, 'voice model not available');
  const s2 = make();
  s2.enrolStart(); for (let i = 0; i < 3; i++) await s2.enrolAdd(wav(0, 2)); s2.enrolFinish();
  const broken = make({ printFile: s2.printFile, embed: async () => { throw new Error('boom'); } });
  assert.strictEqual((await broken.tag(wav(0, 2))).tag, 'unknown');
});

t('re-enrol replaces the old voice; forget deletes it', async () => {
  const s = make();
  s.enrolStart(); for (let i = 0; i < 3; i++) await s.enrolAdd(wav(0, 2)); s.enrolFinish();
  s.enrolStart(); for (let i = 0; i < 3; i++) await s.enrolAdd(wav(9, 2)); s.enrolFinish();
  assert.strictEqual((await s.tag(wav(9, 2))).tag, 'fred');
  s.forget();
  assert.strictEqual(s.status().enrolled, false);
  assert.ok(!fs.existsSync(s.printFile));
});

t('recent tags for debugging: what was heard, who, for me?, what he did', () => {
  const s = make();
  s.record({ text: 'Hannibal, what is on my calendar?', speaker: 'fred', speakerScore: 0.92, addressed: 'yes', addressedScore: 0.95, action: 'answer', why: 'his name' });
  s.record({ text: 'Muy bien, gracias.', speaker: 'other', speakerScore: 0.88, addressed: 'no', addressedScore: 0.2, action: 'silent', why: 'other voice, switched to Spanish', lang: 'es' });
  s.record({ text: 'can you turn it down', speaker: 'unknown', speakerScore: 0.6, addressed: 'unsure', addressedScore: 0.45, action: 'brief', why: 'others on camera' });
  const r = s.recent(10);
  assert.strictEqual(r.tags.length, 3);
  assert.strictEqual(r.tags[1].speaker, 'other');
  assert.strictEqual(r.tags[1].action, 'silent');
  assert.strictEqual(r.summary, 'Last 3 lines: 1 Fred, 1 someone else, 1 not sure; answered 2, stayed quiet on 1.');
});

t('speech server: every transcript carries the speaker tag', async () => {
  const fakeSpeaker = { tag: async () => ({ tag: 'other', score: 0.88, sim: 0.1 }) };
  const loud = Buffer.alloc(44 + 32000 * 3);
  for (let i = 44; i < loud.length - 1; i += 2) loud.writeInt16LE(Math.round(Math.sin(i / 9) * 9000), i);
  const r = await stt.transcribe(Buffer.from('x'), 'es', 'en', {
    toWav: async () => loud,
    inference: async () => ({ text: 'Muy bien, gracias.', segments: [{ text: 'Muy bien, gracias.', avg_logprob: -0.2, no_speech_prob: 0.01 }] }),
    speaker: fakeSpeaker, logDrop: () => {},
  });
  assert.strictEqual(r.text, 'Muy bien, gracias.');
  assert.deepStrictEqual(r.speaker, { tag: 'other', score: 0.88, sim: 0.1 });
  assert.strictEqual(r.language, 'es');
});

t('speech server: /speaker routes (status, log, recent)', async () => {
  const s = make();
  const call = (method, p, body) => new Promise((resolve) => {
    const { EventEmitter } = require('events');
    const req = new EventEmitter(); req.method = method;
    const res = {};
    const send = (code, obj) => resolve({ code, obj });
    stt.speakerRoute(req, res, new URL(`http://x${p}`), send, { speaker: s, toWav: async (b) => b });
    setImmediate(() => { if (body) req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
  });
  assert.strictEqual((await call('GET', '/speaker/status')).obj.enrolled, false);
  assert.strictEqual((await call('POST', '/speaker/log', { text: 'hi', speaker: 'fred', action: 'answer', addressed: 'yes' })).obj.ok, true);
  const rec = await call('GET', '/speaker/recent?n=5');
  assert.strictEqual(rec.obj.tags.length, 1);
  assert.strictEqual(rec.obj.tags[0].text, 'hi');
  assert.strictEqual((await call('GET', '/speaker/nope')).code, 404);
});

(async () => {
  for (const [name, fn] of pending) {
    try { await fn(); n++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n${e.stack}`); process.exitCode = 1; }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${n} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
