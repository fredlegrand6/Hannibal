// ─────────────────────────────────────────────────────────────────────────
// TEST — saved facts (memory-facts.js) + their path through Claude's tools.
// Offline, temp files only. Run:  node electron/services/test-memory-facts.js
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const fakeSdk = function Anthropic() {};
fakeSdk.APIError = class extends Error {};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === '@anthropic-ai/sdk' ? fakeSdk : origLoad.call(this, req, ...rest); };

const { createFactStore, registerFacts } = require('./memory-facts');
const { createPermissionStore } = require('./agent/permission-store');
const { installToolTap } = require('./agent/executor');
const claudeTools = require('./claude-tools');
const brain = require('./claude-brain');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hannibal-facts-'));
let seq = 0;
const fresh = () => createFactStore({ filePath: path.join(TMP, `facts${seq++}.json`), now: () => '2026-11-17T21:00:00Z' });

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.stack || e.message}`); process.exitCode = 1; }
}

(async () => {
  console.log('Fact store');
  await test('remember saves, survives a reload, and keeps the category', () => {
    const s = fresh();
    const r = s.remember('Jay is Fred\'s son, 26, building Mutuele with him', 'person');
    assert(r.ok && r.id === 'f1');
    const again = createFactStore({ filePath: s.file });
    assert.strictEqual(again.size, 1);
    assert.strictEqual(again.list().facts[0].category, 'person');
  });
  await test('a near-identical fact is updated, not duplicated', () => {
    const s = fresh();
    s.remember('HTS is the first Revalis Hospitality client.', 'project');
    const r = s.remember('hts is the first revalis hospitality client', 'project');
    assert(r.duplicate);
    assert.strictEqual(s.size, 1);
  });
  await test('unknown categories become "other"; empty facts are refused', () => {
    const s = fresh();
    s.remember('Likes espresso', 'drinks');
    assert.strictEqual(s.list().facts[0].category, 'other');
    assert.strictEqual(s.remember('   ').ok, false);
  });
  await test('forget by id and by words', () => {
    const s = fresh();
    s.remember('Gaian is 12', 'person');
    s.remember('Briefings in English, short', 'preference');
    assert.strictEqual(s.forget('f1').removed[0].text, 'Gaian is 12');
    assert.strictEqual(s.forget('briefings english').removed.length, 1);
    assert.strictEqual(s.size, 0);
    assert.strictEqual(s.forget('nothing like this').ok, false);
  });
  await test('forget refuses a vague match that would wipe many facts', () => {
    const s = fresh();
    for (let i = 0; i < 7; i++) s.remember(`Revalis note ${i}`, 'project');
    const r = s.forget('revalis');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(s.size, 7);
  });
  await test('the prompt block is grouped by category and includes ids', () => {
    const s = fresh();
    s.remember('Jay is Fred\'s son', 'person');
    s.remember('Prefers short answers', 'preference');
    const p = s.renderForPrompt();
    assert(/Persons:\n- \[f1\] Jay/.test(p));
    assert(/Preferences:\n- \[f2\] Prefers short/.test(p));
    assert.strictEqual(fresh().renderForPrompt(), '');
  });
  await test('a corrupt file does not crash; it starts empty', () => {
    const file = path.join(TMP, 'corrupt.json');
    fs.writeFileSync(file, '{not json');
    assert.strictEqual(createFactStore({ filePath: file }).size, 0);
  });

  console.log('Through Claude\'s tools (real executor, IPC handlers)');
  const store = fresh();
  const handlers = {};
  const fakeIpc = { handle: (ch, fn) => { handlers[ch] = fn; } };
  installToolTap(fakeIpc);
  registerFacts(fakeIpc, store);
  const opts = {
    permissions: createPermissionStore({ filePath: path.join(TMP, 'perm.json'), noLoad: true, entries: [] }),
    emit: () => {},
    confirmer: async () => { throw new Error('remember/forget must not ask for confirmation'); },
  };
  await test('memory__remember runs without a confirmation prompt and saves', async () => {
    const r = await claudeTools.runTool('memory__remember', { fact: 'Fred flies to Ibiza every 4 weeks', category: 'routine' }, opts);
    assert.strictEqual(r.status, 'ok', r.content);
    assert.strictEqual(store.list().facts[0].text, 'Fred flies to Ibiza every 4 weeks');
  });
  await test('memory__facts lists, memory__forget removes', async () => {
    const l = await claudeTools.runTool('memory__facts', {}, opts);
    assert(/Ibiza/.test(l.content));
    const f = await claudeTools.runTool('memory__forget', { query: 'ibiza' }, opts);
    assert.strictEqual(f.status, 'ok');
    assert.strictEqual(store.size, 0);
  });

  console.log('In Claude\'s prompt');
  await test('saved facts and the memory guidance are in the system prompt', async () => {
    store.remember('Kim is the Revalis reception voice agent', 'project');
    brain._setFactStore(store);
    process.env.ANTHROPIC_API_KEY = 'test-key';
    let req = null;
    brain._setClient({ beta: { messages: { stream: (r) => { req = r; return {
      on: () => {}, finalMessage: async () => ({ model: 'fake', usage: {}, stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ok.' }] }),
    }; } } } });
    brain.registerClaudeBrain({ handle: () => {} }, { runTool: async () => ({ tool: 'x', status: 'ok', content: '' }) });
    await brain.chat({ system: 'You are Hannibal.', user: 'who is Kim?' }, () => {});
    assert(/Kim is the Revalis reception voice agent/.test(req.system));
    assert(/memory__remember/.test(req.system));
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
