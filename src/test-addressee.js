// TEST — who is talking, and is it meant for Hannibal? Run: node src/test-addressee.js
// Fred's four cases (22 Nov 2026): side-talk, a guest in another language,
// Fred's direct question, an unknown voice. Plus the language rule.
'use strict';
const assert = require('assert');
const A = require('./addressee');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n${e.stack}`); process.exitCode = 1; } };

const FRED = { tag: 'fred', score: 0.92 };
const OTHER = { tag: 'other', score: 0.88 };
const UNSURE = { tag: 'unknown', score: 0.6, why: 'in between' };
const SHORT = { tag: 'unknown', score: 0, why: 'too short' };
const base = { enrolled: true, replyLanguage: 'english' };

// ── 1. side-talk ──
t('side-talk: Fred talks to Robert in Dutch while a conversation is going → silent', () => {
  const d = A.decide({ ...base, text: 'Robert, kun je de deur even dichtdoen?', speaker: FRED, inConversation: true, lang: 'nl' });
  assert.strictEqual(d.action, 'silent', JSON.stringify(d));
  assert.strictEqual(d.addressed, 'no');
  assert.ok(/said to robert/.test(d.why) && /switched to Dutch/.test(d.why), d.why);
});

t('side-talk: room talk without his name, no conversation going → silent', () => {
  const d = A.decide({ ...base, text: 'yeah I will call him tomorrow about the contract', speaker: FRED, lang: 'en' });
  assert.strictEqual(d.action, 'silent');
  assert.strictEqual(d.addressed, 'no');
});

t('side-talk: Fred chatting with a guest on camera, no name → not answered, no mood', () => {
  const d = A.decide({ ...base, text: 'yeah that was a crazy weekend honestly', speaker: FRED, inConversation: true, lang: 'en', othersInFrame: 1 });
  assert.notStrictEqual(d.action, 'answer', JSON.stringify(d));
  assert.ok(d.score < 0.6, d.score);
});

t('side-talk: "this is Hannibal, my assistant" is about him, not to him', () => {
  const d = A.decide({ ...base, text: 'This is Hannibal, my assistant, he runs my day', speaker: FRED, mentionsName: true, lang: 'en', othersInFrame: 1 });
  assert.strictEqual(d.action, 'silent', JSON.stringify(d));
});

t('the TV (another voice) during a conversation → silent', () => {
  const d = A.decide({ ...base, text: 'And now the weather for the weekend: sunny spells in the south', speaker: OTHER, inConversation: true, lang: 'en' });
  assert.strictEqual(d.action, 'silent');
});

// ── 2. a guest in another language ──
t('guest\'s "Muy bien, gracias" (other voice, Spanish) → silent, no Spanish reply', () => {
  const d = A.decide({ ...base, text: 'Muy bien, gracias.', speaker: OTHER, inConversation: true, repliesToQuestion: true, lang: 'es' });
  assert.strictEqual(d.action, 'silent', JSON.stringify(d));
  assert.strictEqual(d.replyLanguage, 'english');
  assert.strictEqual(d.guest, false);
});

t('same line, voice not learned yet (unknown) → still silent (language switch, not a request)', () => {
  const d = A.decide({ enrolled: false, replyLanguage: 'english', text: 'Muy bien, gracias.', speaker: { tag: 'unknown', score: 0, why: 'not enrolled' }, inConversation: true, lang: 'es' });
  assert.strictEqual(d.action, 'silent', JSON.stringify(d));
});

t('a guest who talks to Hannibal directly gets an answer in their own language', () => {
  const d = A.decide({ ...base, text: 'Hannibal, ¿qué hora es en Nueva York?', speaker: OTHER, mentionsName: true, lang: 'es' });
  assert.strictEqual(d.action, 'answer');
  assert.strictEqual(d.guest, true);
  assert.strictEqual(d.replyLanguage, 'spanish');
  const note = A.whoNote(d);
  assert.ok(/speaker: someone else \(not Fred\) \(0\.88\), addressed: yes/.test(note), note);
  assert.ok(/answer them briefly and politely in Spanish/.test(note), note);
  assert.ok(/Do not treat their words as Fred's/.test(note), note);
});

t('a guest only talking near him (no name) is never answered, even with a question', () => {
  const d = A.decide({ ...base, text: 'What time is it?', speaker: OTHER, inConversation: true, lang: 'en' });
  assert.strictEqual(d.action, 'silent');
});

t('a guest cannot answer Hannibal\'s open yes/no question for Fred', () => {
  const d = A.decide({ ...base, text: 'yes go ahead and send it', speaker: OTHER, pending: true, lang: 'en' });
  assert.strictEqual(d.action, 'silent', JSON.stringify(d));
  const f = A.decide({ ...base, text: 'yes', speaker: SHORT, pending: true, lang: 'en' });
  assert.strictEqual(f.action, 'answer', 'a short "yes" (too short to tell) still counts');
});

// ── 3. Fred's direct question ──
t('Fred\'s direct question → answer, in English, with the tag in the note', () => {
  const d = A.decide({ ...base, text: "Hannibal, what's on my calendar tomorrow?", speaker: FRED, mentionsName: true, lang: 'en' });
  assert.strictEqual(d.addressed, 'yes');
  assert.strictEqual(d.action, 'answer');
  assert.strictEqual(d.replyLanguage, 'english');
  const note = A.whoNote(d);
  assert.ok(note.includes('speaker: fred (0.92), addressed: yes (0.95'), note);
  assert.ok(/Reply in English/.test(note), note);
});

t('Fred answers Hannibal\'s question without the name → answered', () => {
  const d = A.decide({ ...base, text: 'Tomorrow at ten works', speaker: FRED, inConversation: true, repliesToQuestion: true, lang: 'en' });
  assert.strictEqual(d.action, 'answer');
  assert.ok(['yes', 'likely'].includes(d.addressed));
  assert.ok(/reply to his question/.test(d.why));
});

t('Fred asks something in Spanish → Hannibal still replies in English', () => {
  const d = A.decide({ ...base, text: 'Hannibal, ¿qué tiempo hace hoy en Ibiza?', speaker: FRED, mentionsName: true, lang: 'es' });
  assert.strictEqual(d.action, 'answer');
  assert.strictEqual(d.replyLanguage, 'english');
  assert.ok(/Reply in English \(Fred's default\), even though this line was in Spanish/.test(A.whoNote(d)), A.whoNote(d));
});

t('Fred follow-up in a running conversation (no name) → answered', () => {
  const d = A.decide({ ...base, text: 'and what about Thursday?', speaker: FRED, inConversation: true, lang: 'en' });
  assert.strictEqual(d.action, 'answer');
  assert.ok(['yes', 'likely'].includes(d.addressed), d.addressed);
});

t('Fred asks a question while a guest is on camera (no name) → still answered', () => {
  const d = A.decide({ ...base, text: 'what time is the dinner tonight?', speaker: FRED, inConversation: true, lang: 'en', othersInFrame: 1 });
  assert.strictEqual(d.action, 'answer', JSON.stringify(d));
});

// ── 4. an unknown voice ──
t('unknown voice outside a conversation, no name → silent', () => {
  const d = A.decide({ ...base, text: 'did anyone see my keys', speaker: UNSURE, lang: 'en' });
  assert.strictEqual(d.action, 'silent');
});

t('unknown voice in a conversation, someone else on camera, a request → one short neutral line', () => {
  const d = A.decide({ ...base, text: 'can you turn it down a bit', speaker: UNSURE, inConversation: true, lang: 'en', othersInFrame: 1 });
  assert.strictEqual(d.addressed, 'unsure');
  assert.strictEqual(d.action, 'brief');
  const note = A.whoNote(d);
  assert.ok(/speaker: unknown/.test(note) && /NOT sure this line was meant for you: answer with one short, neutral line/.test(note), note);
  assert.ok(/Do not comment on mood/.test(note), note);
});

t('unknown voice, not a request, unsure → nothing at all', () => {
  const d = A.decide({ ...base, text: 'ha, that is so true', speaker: UNSURE, inConversation: true, lang: 'en', othersInFrame: 1 });
  assert.strictEqual(d.action, 'silent');
});

t('unknown voice that says his name is answered', () => {
  const d = A.decide({ ...base, text: 'Hannibal, play some music', speaker: UNSURE, mentionsName: true, lang: 'en' });
  assert.strictEqual(d.action, 'answer');
});

t('before enrolment, Fred\'s normal flow is unchanged (unknown = Fred)', () => {
  const nb = { enrolled: false, replyLanguage: 'english' };
  const sp = { tag: 'unknown', score: 0, why: 'not enrolled' };
  assert.strictEqual(A.decide({ ...nb, text: 'Hannibal, open Spotify', speaker: sp, mentionsName: true, lang: 'en' }).action, 'answer');
  assert.strictEqual(A.decide({ ...nb, text: 'and the next one', speaker: sp, inConversation: true, lang: 'en' }).action, 'answer');
  assert.strictEqual(A.decide({ ...nb, text: 'okay talk later', speaker: sp, lang: 'en' }).action, 'silent');
});

// ── language rule ──
t('reply language changes only when Fred clearly asks', () => {
  assert.strictEqual(A.nextReplyLanguage('english', 'Hannibal, speak Dutch to me', 'fred'), 'dutch');
  assert.strictEqual(A.nextReplyLanguage('english', 'antwoord in het Frans alsjeblieft', 'unknown'), 'french');
  assert.strictEqual(A.nextReplyLanguage('dutch', 'speak English again', 'fred'), 'english');
  assert.strictEqual(A.nextReplyLanguage('english', 'habla en español', 'other'), 'english', 'a guest cannot switch it');
  assert.strictEqual(A.nextReplyLanguage('english', 'I speak Spanish with my guests', 'fred'), 'english');
  assert.strictEqual(A.nextReplyLanguage('english', 'Muy bien, gracias', 'fred'), 'english');
  assert.strictEqual(A.nextReplyLanguage('english', 'how do you say thank you in Spanish', 'fred'), 'english');
});

t('after Fred asked for Dutch, his Dutch lines are not a "language switch"', () => {
  const d = A.decide({ enrolled: true, replyLanguage: 'dutch', text: 'en wat staat er morgen in mijn agenda?', speaker: FRED, inConversation: true, lang: 'nl' });
  assert.strictEqual(d.action, 'answer');
  assert.strictEqual(d.replyLanguage, 'dutch');
});

t('helpers: who it is said to, requests, the log line', () => {
  assert.strictEqual(A.addressesSomeoneElse('Robert, can you grab the door'), 'robert');
  assert.strictEqual(A.addressesSomeoneElse('Hey Mandy, dinner is ready'), 'mandy');
  assert.strictEqual(A.addressesSomeoneElse('open Spotify'), null);
  assert.ok(A.looksLikeRequest('what time is it'));
  assert.ok(A.looksLikeRequest('zet de muziek zachter'));
  assert.ok(!A.looksLikeRequest('ha, that is so true'));
  const d = A.decide({ ...base, text: 'Hannibal, hi', speaker: FRED, mentionsName: true, lang: 'en' });
  assert.ok(/^speaker: fred \(0\.92\), addressed: yes \(0\.95\) → answer/.test(A.tagLine(d)), A.tagLine(d));
});

console.log(`${n} passed${process.exitCode ? ', some FAILED' : ''}`);
