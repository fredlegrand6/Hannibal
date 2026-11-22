'use strict';
// Threads (threads.js): Fred's five acceptance tests, offline, with a fake
// "by meaning" embedding (words mapped to a few concepts).
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createThreadStore, registerThreads, parseUpdates } = require('./threads');
const { createNudger } = require('./nudges');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-'));
let seq = 0;
const file = () => path.join(TMP, `t${seq++}.json`);
const CONCEPTS = {
  brief: /brief|briefing|morning|08:00|8 o.?clock|eight/,
  remind: /remind|fire[sd]?|alarm/,
  password: /password|bedsynq|zoho|credential/,
  stt: /speech|stt|whisper|language|icelandic/,
  nudge: /nudge|interrupt|gap|between topics/,
  test: /test|tested/,
};
const embed = async (text) => {
  const t = String(text).toLowerCase();
  // plus a little of the words themselves, so unrelated texts differ
  const words = new Array(16).fill(0);
  for (const w of t.split(/\W+/).filter((x) => x.length > 3)) words[[...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 16, 7)] += 0.2;
  return [...Object.values(CONCEPTS).map((re) => (re.test(t) ? 1 : 0)), ...words];
};
let passed = 0;
async function t(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.stack || e.message}`); process.exitCode = 1; }
}
const quiet = () => {};
const handlers = (store) => { const h = {}; registerThreads({ handle: (ch, fn) => { h[ch] = fn; } }, store); return h; };

(async () => {
  console.log('Threads');
  const f = file();
  let clock = Date.parse('2026-11-22T09:00:00');
  const mk = () => createThreadStore({ filePath: f, embed, now: () => clock, log: quiet });
  let s = mk();
  await s.upsert({ title: 'Reminders must actually fire', status: 'in_progress', note: 'Claude Code PR #44' });
  await s.upsert({ title: 'Change the bedsynq Zoho passwords', status: 'open' });
  await s.upsert({ title: 'Morning brief runs once a day at 08:00', status: 'in_progress', note: 'it ran three times today' });
  await s.upsert({ title: 'Lock speech-to-text to his languages', status: 'open' });

  await t('1. "the reminders are fixed and tested" -> done; never suggested again', async () => {
    const h = handlers(s);
    // Claude sees the id in THREADS and passes it (as the tool asks).
    const id = /\[(t-\w+)\] Reminders must actually fire/.exec(s.renderForPrompt())[1];
    const r = await h['threads:update']({}, id, 'done', 'Fred: fixed and tested this morning');
    assert.ok(r.ok && !r.created && r.status === 'done', JSON.stringify(r));
    const p = s.renderForPrompt();
    const open = p.split('RECENTLY CLOSED')[0];
    assert.ok(!/Reminders must actually fire/.test(open), 'not in OPEN');
    assert.ok(/RECENTLY CLOSED \(finished or dropped: don't bring these up, don't suggest testing/.test(p) && /Reminders must actually fire — done/.test(p), p);
    // A later guess from Hannibal's own pass can't reopen what Fred closed.
    await s.upsert({ id: r.id || s.all().find((x) => /Reminders/.test(x.title)).id, status: 'open', note: 'maybe test again', source: 'hannibal' });
    assert.strictEqual(s.all().find((x) => /Reminders/.test(x.title)).status, 'done');
  });

  await t('2. "forget about the passwords" -> dropped, gone from OPEN, never nudged', async () => {
    const h = handlers(s);
    const r = await h['threads:update']({}, 'the passwords', 'dropped', 'Fred: forget about it');
    assert.ok(r.ok && r.status === 'dropped', JSON.stringify(r));
    assert.ok(!/bedsynq/.test(s.renderForPrompt().split('RECENTLY CLOSED')[0]));
    assert.ok(await s.isClosedTopic('Zoho sent the bedsynq passwords in plain text'));
    const said = [];
    const nudger = createNudger({ statePath: file(), env: {}, now: () => new Date('2026-11-22T10:00:00'),
      getEvents: async () => ({ events: [] }), isKnown: () => true,
      getMail: async () => ({ messages: [{ from: 'Zoho', from_email: 'admin@zoho-team.com', subject: 'Your bedsynq passwords', age_hours: 60, uid: 1 }] }),
      deliver: async (x) => { said.push(x); return true; }, skip: (n) => s.isClosedTopic(n.text) });
    const was = console.log; console.log = quiet;
    try { assert.strictEqual(await nudger.tick(), 'nothing'); } finally { console.log = was; }
    assert.strictEqual(said.length, 0);
  });

  await t('3. "what did we say about the morning brief?" -> current status + key steps', async () => {
    clock += 3600000;
    await s.upsert({ title: 'Morning brief runs once a day at 08:00', status: 'done', note: 'PR #45 merged, saved on disk when he starts speaking', source: 'event' });
    const r = await handlers(s)['threads:find']({}, 'what did we say about the morning briefing?', 3, true);
    assert.ok(r.ok && r.threads.length >= 1, JSON.stringify(r));
    const b = r.threads[0];
    assert.strictEqual(b.title, 'Morning brief runs once a day at 08:00');
    assert.strictEqual(b.status, 'done');
    assert.ok(b.steps.length >= 2 && /three times/.test(b.steps.join(' ')) && /PR #45/.test(b.steps.join(' ')), b.steps.join(' | '));
  });

  await t('4. restart -> statuses persist', async () => {
    s = mk();
    const st = Object.fromEntries(s.all().map((x) => [x.title, x.status]));
    assert.deepStrictEqual(st['Reminders must actually fire'], 'done');
    assert.deepStrictEqual(st['Change the bedsynq Zoho passwords'], 'dropped');
    assert.deepStrictEqual(st['Morning brief runs once a day at 08:00'], 'done');
  });

  await t('5. the same topic in other words a day later -> the same thread, no duplicate', async () => {
    clock += 86400000;
    const before = s.size;
    const summarize = async () => JSON.stringify({ updates: [{ title: 'Whisper keeps hearing Icelandic, limit the languages', status: 'done', note: 'PR #27 locked EN/NL/FR/ES', source: 'fred' }] });
    const r = await s.reconcile({ transcript: 'Fred: the Icelandic thing is solved, speech-to-text only does my four languages now.', summarize });
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(s.size, before, 'no new thread');
    assert.strictEqual(s.all().find((x) => /speech-to-text/.test(x.title)).status, 'done');
  });

  await t('the pass: events close threads, merges, and only real new threads', async () => {
    const st = createThreadStore({ filePath: file(), embed, now: () => clock, log: quiet });
    await st.upsert({ title: 'Nudges wait for a gap between topics', status: 'open' });
    await st.upsert({ title: 'Proactive nudges should not interrupt', status: 'open' });
    st.observe('Claude Code merged PR #45: nudges wait for a gap between topics', 'event');
    const ids = st.all().map((x) => x.id);
    let seen = '';
    const summarize = async (input) => { seen = input; return JSON.stringify({ updates: [
      { id: ids[1], merge_into: ids[0] },
      { id: ids[0], status: 'done', note: 'PR #45 merged', source: 'event' },
      { title: 'Plan the Ibiza trip', status: 'open', people: ['Fred'] },
    ] }); };
    const r = await st.reconcile({ transcript: 'Fred: and plan Ibiza for December.', summarize });
    assert.ok(r.ok && /PR #45/.test(seen), seen);
    const all = st.all();
    assert.strictEqual(all.length, 2, all.map((x) => x.title).join(' | '));
    assert.strictEqual(all.find((x) => x.id === ids[0]).status, 'done');
    assert.ok(all.some((x) => x.title === 'Plan the Ibiza trip'));
  });

  await t('snoozed comes back when its date passes; waiting shows who', async () => {
    const st = createThreadStore({ filePath: file(), embed, now: () => clock, log: quiet });
    await st.upsert({ title: 'Call the notary', status: 'snoozed', until: '2026-11-30' });
    await st.upsert({ title: 'HTS contract', status: 'waiting_on', waiting_on: 'Jean-Marc' });
    assert.ok(!/notary/.test(st.renderForPrompt()));
    assert.ok(/HTS contract — waiting on Jean-Marc/.test(st.renderForPrompt()));
    clock = Date.parse('2026-12-01T09:00:00');
    assert.ok(/notary/.test(st.renderForPrompt()));
  });

  await t('desk and server: merged by id, the newer update wins; closed ones leave the prompt after 7 days', async () => {
    const a = createThreadStore({ filePath: file(), embed, now: () => clock, log: quiet });
    const b = createThreadStore({ filePath: file(), embed, now: () => clock, log: quiet });
    await a.upsert({ title: 'Book the Ibiza flight', status: 'open' });
    b.merge(a.all());
    clock += 1000;
    await b.upsert({ title: 'Book the Ibiza flight', status: 'done', note: 'booked', source: 'fred' });
    a.merge(b.all());
    assert.strictEqual(a.all()[0].status, 'done');
    clock += 8 * 86400000;
    assert.ok(!/Ibiza/.test(a.renderForPrompt()));
    assert.strictEqual((await a.find('ibiza flight')).threads[0].status, 'done', 'still searchable');
  });

  await t('works by words when embeddings are down', async () => {
    const st = createThreadStore({ filePath: file(), embed: async () => null, now: () => clock, log: quiet });
    await st.upsert({ title: 'Morning brief once a day', status: 'open' });
    const r = await st.upsert({ title: 'morning brief once a day at 8', status: 'done', source: 'fred' }, { minMatch: 0.72 });
    assert.ok(!r.created && st.size === 1, JSON.stringify(r));
    assert.ok(parseUpdates('here: {"updates":[{"title":"x"}]}').length === 1 && parseUpdates('nope') === null);
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
