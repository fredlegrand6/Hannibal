// ─────────────────────────────────────────────────────────────────────────
// TEST: conversation diary (conversation-journal.js) and its path through the
// brain. Offline, temp files only. Run:  node electron/services/test-conversation-journal.js
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const Module = require('module');

class APIError extends Error {}
const fakeSdk = function Anthropic() {};
Object.assign(fakeSdk, { APIError, AuthenticationError: class extends APIError {}, PermissionDeniedError: class extends APIError {},
  RateLimitError: class extends APIError {}, APIConnectionError: class extends APIError {} });
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === '@anthropic-ai/sdk' ? fakeSdk : origLoad.call(this, req, ...rest); };

const { createJournal, parseSummary } = require('./conversation-journal');
const brain = require('./claude-brain');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hannibal-journal-'));
let seq = 0;
const file = () => path.join(TMP, `j${seq++}.json`);
const T0 = Date.parse('2026-11-21T10:00:00Z');
const MIN = 60 * 1000;

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n`, e); process.exitCode = 1; }
}
const reply = (o) => async () => JSON.stringify(o);

(async () => {
  await test('notes become an episode after a quiet spell, with open threads in the prompt', async () => {
    let t = T0;
    const j = createJournal({ filePath: file(), now: () => t, summarize: reply({
      title: 'Mutuele launch plan', summary: 'Fred and Jay set the Mutuele beta for 1 December.',
      people: ['Jay'], projects: ['Mutuele'], open: ['Send Jay the beta checklist'] }) });
    j.note('desk', 'When do we launch Mutuele?', 'You said 1 December with Jay.');
    assert.strictEqual(j.due(), false);
    t += 25 * MIN;
    assert.strictEqual(j.due(), true);
    const ep = await j.close();
    assert.ok(ep && ep.title === 'Mutuele launch plan');
    assert.strictEqual(j.pendingCount, 0);
    const p = j.renderForPrompt();
    assert.ok(p.includes('Mutuele beta for 1 December'), p);
    assert.ok(p.includes('OPEN THREADS') && p.includes('Send Jay the beta checklist'), p);
  });

  await test('survives a restart: episodes and unsummarized notes are on disk', async () => {
    const f = file(); let t = T0;
    const a = createJournal({ filePath: f, now: () => t, summarize: reply({ title: 'HTS', summary: 'Talked about HTS onboarding.', projects: ['HTS'] }) });
    a.note('phone', 'HTS call went well', 'Good. Next step is the contract.');
    await (t += 30 * MIN, a.close());
    a.note('desk', 'Remind me about the VakSynq demo', 'Will do.');
    const b = createJournal({ filePath: f, now: () => t });
    assert.strictEqual(b.size, 1);
    assert.strictEqual(b.pendingCount, 1);
  });

  await test('a failed summary keeps the notes and tries again', async () => {
    let t = T0; let fail = true;
    const j = createJournal({ filePath: file(), now: () => t, summarize: async () => { if (fail) throw new Error('offline'); return '{"title":"x","summary":"ok"}'; } });
    j.note('desk', 'one', 'two');
    t += 30 * MIN;
    assert.strictEqual(await j.close(), null);
    assert.strictEqual(j.pendingCount, 1);
    fail = false;
    assert.ok(await j.close());
    assert.strictEqual(j.pendingCount, 0);
  });

  await test('search finds by person or project, newest first on ties', async () => {
    let t = T0;
    const outs = [
      { title: 'Revalis Housing pricing', summary: 'Set the Housing price per bed.', projects: ['Revalis Housing'] },
      { title: 'Date Night ideas', summary: 'Brainstormed Date Night with Jay.', people: ['Jay'], projects: ['Date Night'] },
      { title: 'Housing launch', summary: 'Housing goes live in January.', projects: ['Revalis Housing'] },
    ];
    let k = 0;
    const j = createJournal({ filePath: file(), now: () => t, summarize: async () => JSON.stringify(outs[k++]) });
    for (let i = 0; i < 3; i++) { j.note('desk', `q${i}`, `a${i}`); t += 30 * MIN; await j.close(); }
    const r = j.search('revalis housing');
    assert.strictEqual(r.count, 2);
    assert.strictEqual(r.conversations[0].title, 'Housing launch');
    assert.strictEqual(j.search('Jay').conversations[0].title, 'Date Night ideas');
    assert.strictEqual(j.search('zerochat').count, 0);
  });

  await test('merge takes the other side\'s episodes once, by id', async () => {
    const a = createJournal({ filePath: file(), now: () => T0, summarize: reply({ title: 'A', summary: 'from the desk' }) });
    const b = createJournal({ filePath: file(), now: () => T0 });
    a.note('desk', 'x', 'y'); await a.close();
    assert.strictEqual(b.merge(a.all()), 1);
    assert.strictEqual(b.merge(a.all()), 0);
    assert.strictEqual(b.all()[0].summary, 'from the desk');
  });

  await test('parseSummary reads JSON inside a code fence and rejects junk', () => {
    assert.strictEqual(parseSummary('```json\n{"title":"t","summary":"s","open_threads":["o"]}\n```').open[0], 'o');
    assert.strictEqual(parseSummary('sorry, no'), null);
  });

  await test('the brain notes each turn, saves the conversation and shows the diary', async () => {
    process.env.ANTHROPIC_API_KEY = 'test';
    process.env.HANNIBAL_CLAUDE_TOOLS = '0';
    const live = file();
    let seen = null;
    brain._setClient({ beta: { messages: {
      stream: (req) => { seen = req; const h = {}; return {
        on: (ev, fn) => { h[ev] = fn; },
        finalMessage: async () => { h.text && h.text('Sure.'); return { content: [{ type: 'text', text: 'Sure.' }], stop_reason: 'end_turn', usage: {} }; },
        abort() {} }; },
      create: async () => ({ content: [{ type: 'text', text: '{"title":"Call Jay","summary":"Fred wants to call Jay tomorrow.","open":["Call Jay"]}' }] }),
    } } });
    brain.resetHistory();
    const j = createJournal({ filePath: file(), summarize: (t, p) => brain.summarizeForJournal(t, p) });
    brain.setJournal(j, { liveFile: live, whereName: 'desk' });
    const r = await brain.chat({ system: 'persona', user: 'Remind me to call Jay' });
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(j.pendingCount, 1);
    assert.ok(JSON.parse(fs.readFileSync(live, 'utf8')).history.length >= 2);
    await j.close();
    await brain.chat({ system: 'persona', user: 'and?' });
    assert.ok(String(seen.system).includes('Fred wants to call Jay tomorrow.'), seen.system);
    brain.setJournal(null);
  });

  console.log(`${passed} passed`);
})();
