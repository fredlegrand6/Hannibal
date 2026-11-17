// ─────────────────────────────────────────────────────────────────────────
// TEST — Claude uses Hannibal's actions (claude-tools.js + claude-brain.js).
// Deterministic and offline: fake tool invoker, fake confirmer, fake Claude
// client, temp permission store. Run:  node electron/services/test-claude-tools.js
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const Module = require('module');

// Stand-in for @anthropic-ai/sdk so this runs without the package or a key.
class APIError extends Error {}
const fakeSdk = function Anthropic() {};
Object.assign(fakeSdk, { APIError, AuthenticationError: class extends APIError {}, PermissionDeniedError: class extends APIError {},
  RateLimitError: class extends APIError {}, APIConnectionError: class extends APIError {} });
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === '@anthropic-ai/sdk' ? fakeSdk : origLoad.call(this, req, ...rest); };

const catalog = require('./agent/catalog');
const { createPermissionStore } = require('./agent/permission-store');
const claudeTools = require('./claude-tools');
const brain = require('./claude-brain');

const TMP = path.join(os.tmpdir(), 'hannibal-claude-tools-test');
fs.mkdirSync(TMP, { recursive: true });
let seq = 0;
const freshStore = () => createPermissionStore({ filePath: path.join(TMP, `p${seq++}.json`), noLoad: true, entries: [] });
const quiet = () => {};

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.stack || e.message}`); process.exitCode = 1; }
}

// opts for runTool with a recording invoker + confirmer
function harness({ answer = true, invokeImpl } = {}) {
  const calls = { invoke: [], confirm: [] };
  return {
    calls,
    opts: {
      permissions: freshStore(),
      emit: quiet,
      invoke: async (tool, params) => { calls.invoke.push({ tool, params }); return invokeImpl ? invokeImpl(tool, params) : { ok: true, tool }; },
      confirmer: async (step, summary) => { calls.confirm.push({ tool: step.tool, summary }); return answer; },
    },
  };
}

(async () => {
  console.log('Claude tool definitions');
  await test('every name is a valid Claude tool name and maps back to a catalog tool', () => {
    const defs = claudeTools.toolDefinitions();
    assert(defs.length > 80, `expected the bulk of the catalog, got ${defs.length}`);
    for (const d of defs) {
      assert(/^[a-zA-Z0-9_-]{1,64}$/.test(d.name), `bad name ${d.name}`);
      assert(catalog.getTool(claudeTools.fromApiName(d.name)), `no catalog tool for ${d.name}`);
      assert.strictEqual(d.input_schema.type, 'object');
    }
  });
  await test('dangerous / planner-excluded / housekeeping tools are NOT exposed', () => {
    const names = new Set(claudeTools.toolDefinitions().map((d) => claudeTools.fromApiName(d.name)));
    for (const n of ['mac.shell', 'skills.execute', 'whatsapp.send', 'memory.store', 'personality.save', 'preferences.save', 'voice.config']) {
      assert(!names.has(n), `${n} must not be exposed`);
    }
    for (const n of ['mail.inbox', 'calendar.events', 'mail.send', 'web.search', 'file.trash', 'memory.query']) {
      assert(names.has(n), `${n} should be exposed`);
    }
  });
  await test('write tools tell Claude they are confirmed by voice', () => {
    const d = claudeTools.toolDefinitions().find((x) => x.name === 'mail__send');
    assert(/confirm/i.test(d.description));
  });

  console.log('Running tools through the executor + gate');
  await test('a read runs straight away, no confirmation', async () => {
    const h = harness({ invokeImpl: () => ({ ok: true, unread: 3 }) });
    const r = await claudeTools.runTool('mail__inbox', {}, h.opts);
    assert.strictEqual(r.status, 'ok');
    assert(/"unread":3/.test(r.content));
    assert.strictEqual(h.calls.confirm.length, 0);
    assert.strictEqual(h.calls.invoke.length, 1);
  });
  await test('a gated write asks Fred, and runs on YES', async () => {
    const h = harness({ answer: true });
    const r = await claudeTools.runTool('mail__send', { to: 'jay@example.com', subject: 'Hi', body: 'Test' }, h.opts);
    assert.strictEqual(h.calls.confirm.length, 1);
    assert(/jay@example\.com/.test(h.calls.confirm[0].summary));
    assert.strictEqual(h.calls.invoke.length, 1);
    assert.strictEqual(r.status, 'ok');
  });
  await test('a gated write does NOT run on NO, and Claude is told he declined', async () => {
    const h = harness({ answer: false });
    const r = await claudeTools.runTool('file__trash', { path: '/tmp/x' }, h.opts);
    assert.strictEqual(h.calls.confirm.length, 1);
    assert.strictEqual(h.calls.invoke.length, 0, 'must not execute after NO');
    assert.strictEqual(r.status, 'declined');
    assert(/did NOT approve/.test(r.content));
  });
  await test('a failing tool goes back to Claude once — no retries, no replans', async () => {
    const h = harness({ invokeImpl: () => { throw new Error('IMAP down'); } });
    const r = await claudeTools.runTool('mail__inbox', {}, h.opts);
    assert.strictEqual(h.calls.invoke.length, 1);
    assert.strictEqual(r.is_error, true);
    assert(/IMAP down/.test(r.content));
  });
  await test('an excluded tool cannot be called even if Claude asks for it', async () => {
    const h = harness();
    const r = await claudeTools.runTool('mac__shell', { command: 'rm -rf ~' }, h.opts);
    assert.strictEqual(r.is_error, true);
    assert.strictEqual(h.calls.invoke.length, 0);
  });
  await test('missing required params are rejected before anything runs', async () => {
    const h = harness();
    const r = await claudeTools.runTool('mail__send', { subject: 'no recipient' }, h.opts);
    assert.strictEqual(r.status, 'invalid');
    assert.strictEqual(h.calls.invoke.length + h.calls.confirm.length, 0);
  });
  await test('huge results are truncated', () => {
    const s = claudeTools.stringify('x'.repeat(50000));
    assert(s.length < 13000 && /truncated/.test(s));
  });

  console.log('Claude brain tool loop');
  process.env.ANTHROPIC_API_KEY = 'test-key';
  // Fake client: first call asks for mail__inbox, second call answers in text.
  const requests = [];
  const script = [
    { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Let me check your inbox' }, { type: 'tool_use', id: 'tu_1', name: 'mail__inbox', input: {} }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'You have 3 unread mails.' }] },
  ];
  brain._setClient({ beta: { messages: { stream: (req) => {
    requests.push(JSON.parse(JSON.stringify(req)));
    const msg = { model: 'fake', usage: {}, ...script[requests.length - 1] };
    const handlers = {};
    return {
      on: (ev, fn) => { handlers[ev] = fn; },
      finalMessage: async () => { for (const b of msg.content) if (b.type === 'text' && handlers.text) handlers.text(b.text); return msg; },
    };
  } } } });
  const toolRuns = [];
  const fakeIpc = { handle: () => {} };
  brain.registerClaudeBrain(fakeIpc, { runTool: async (name, input) => { toolRuns.push(name); return { tool: claudeTools.fromApiName(name), status: 'ok', is_error: false, content: '{"unread":3}' }; } });

  let spoken = '';
  const res = await brain.chat({ system: 'You are Hannibal.', context: 'Time: 21:00', user: 'any new mail?' }, (t) => { spoken += t; });
  await test('Claude calls the tool, gets the result, then answers', () => {
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(toolRuns, ['mail__inbox']);
    assert.strictEqual(requests.length, 2);
    assert(requests[0].tools && requests[0].tools.length > 80, 'tools sent to Claude');
    assert(/confirmed with Fred by voice/.test(requests[0].system), 'tool guidance in the system prompt');
    const last = requests[1].messages.slice(-2);
    assert.strictEqual(last[0].role, 'assistant');
    assert.strictEqual(last[1].content[0].type, 'tool_result');
    assert.strictEqual(last[1].content[0].tool_use_id, 'tu_1');
    assert(/3 unread/.test(res.text));
  });
  await test('speech gets a sentence break before the tool runs', () => {
    assert(/inbox\. You have 3/.test(spoken), spoken);
  });
  await test('the next turn replays a valid history (tool_use followed by tool_result)', async () => {
    script.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sure.' }] });
    await brain.chat({ system: 'You are Hannibal.', user: 'thanks' }, quiet);
    const msgs = requests[2].messages;
    const iUse = msgs.findIndex((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use'));
    assert(iUse >= 0 && msgs[iUse + 1].content[0].type === 'tool_result');
    assert.strictEqual(msgs[msgs.length - 1].content, 'thanks');
  });
  await test('HANNIBAL_CLAUDE_TOOLS=0 turns tools off', async () => {
    process.env.HANNIBAL_CLAUDE_TOOLS = '0';
    script.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hi.' }] });
    await brain.chat({ system: 'S', user: 'hi' }, quiet);
    assert(!requests[3].tools);
    delete process.env.HANNIBAL_CLAUDE_TOOLS;
  });
  await test('a runaway tool loop stops at the step budget with a valid conversation', async () => {
    process.env.HANNIBAL_CLAUDE_MAX_TOOL_ROUNDS = '2';
    brain.resetHistory();
    const start = requests.length;
    for (let i = 0; i < 5; i++) script.push({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `loop_${i}`, name: 'mac__battery', input: {} }] });
    toolRuns.length = 0;
    await brain.chat({ system: 'S', user: 'loop forever' }, quiet);
    assert(requests.length - start <= 3, `made ${requests.length - start} calls`);
    assert(toolRuns.length <= 2, `ran ${toolRuns.length} tools`);
    delete process.env.HANNIBAL_CLAUDE_MAX_TOOL_ROUNDS;
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
