// ─────────────────────────────────────────────────────────────────────────
// TEST — LoopGuard + context compression, and their wiring into the executor.
// Deterministic and fully offline: no Ollama, no Qdrant, no Electron. The 3B
// summarizer is replaced with a fake. Run:  node electron/services/agent/test-loop-guard.js
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const assert = require('assert');
const { createLoopGuard, callHash } = require('./loop-guard');
const { summarizeObservation, compressMessages } = require('./context-compress');
const { execute } = require('./executor');

let passed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { passed += 1; console.log(`  ✓ ${name}`); },
    (e) => { console.error(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; },
  );
}
const readStep = (n, tool, params, extra = {}) =>
  ({ step: n, tool, params, side_effect: 'read', depends_on: [], valid: true, ...extra });

(async () => {
  console.log('LoopGuard — unit');

  await test('identical-call: allows maxIdentical, then warns, then halts', () => {
    const g = createLoopGuard({ maxIdentical: 3 });
    for (let k = 0; k < 3; k++) assert.equal(g.check('search', { q: 'x' }).action, 'allow');
    assert.equal(g.check('search', { q: 'x' }).action, 'warn');   // 4th
    assert.equal(g.check('search', { q: 'x' }).action, 'halt');   // repeat
  });

  await test('identical-call: warnBeforeBlock:false halts on first trip', () => {
    const g = createLoopGuard({ maxIdentical: 2, warnBeforeBlock: false });
    g.check('s', { q: 1 }); g.check('s', { q: 1 });
    assert.equal(g.check('s', { q: 1 }).action, 'halt');          // 3rd > 2
  });

  await test('arg order does not change call identity', () => {
    assert.equal(callHash('t', { a: 1, b: 2 }), callHash('t', { b: 2, a: 1 }));
  });

  await test('poll budget: trips on distinct-arg repeats past pollBudget', () => {
    const g = createLoopGuard({ pollBudget: 5, maxIdentical: 99, warnBeforeBlock: false });
    for (let k = 0; k < 5; k++) assert.equal(g.check('metrics', { i: k }).action, 'allow');
    assert.equal(g.check('metrics', { i: 99 }).action, 'halt');   // 6th call to same tool
  });

  await test('polling tools are exempt from identical + poll, not from ping-pong', () => {
    const g = createLoopGuard({ maxIdentical: 2, pollBudget: 2, warnBeforeBlock: false });
    for (let k = 0; k < 10; k++) {
      assert.equal(g.check('status', { same: 1 }, { isPolling: true }).action, 'allow');
    }
  });

  await test('ping-pong A-B-A-B trips (period 2)', () => {
    const g = createLoopGuard({ maxIdentical: 99, pollBudget: 99, warnBeforeBlock: false });
    assert.equal(g.check('A', { i: 1 }).action, 'allow');
    assert.equal(g.check('B', { i: 1 }).action, 'allow');
    assert.equal(g.check('A', { i: 2 }).action, 'allow');
    assert.equal(g.check('B', { i: 2 }).action, 'halt');          // completes A-B-A-B
  });

  await test('ping-pong A-B-C-A-B-C trips (period 3)', () => {
    const g = createLoopGuard({ maxIdentical: 99, pollBudget: 99, warnBeforeBlock: false });
    for (const t of ['A', 'B', 'C', 'A', 'B']) assert.equal(g.check(t, { n: Math.random() }).action, 'allow');
    assert.equal(g.check('C', { n: 1 }).action, 'halt');          // completes A-B-C-A-B-C
  });

  console.log('Context compression — unit');

  await test('summarizeObservation: small text passes through untouched', async () => {
    const r = await summarizeObservation('short', { threshold: 2000 });
    assert.equal(r.summarized, false); assert.equal(r.text, 'short');
  });

  await test('summarizeObservation: large text is summarized via the model', async () => {
    const r = await summarizeObservation('X'.repeat(5000), { threshold: 2000, summarizer: () => 'SUM' });
    assert.equal(r.summarized, true); assert.equal(r.text, 'SUM');
  });

  await test('summarizeObservation: large {text} blob is summarized', async () => {
    const r = await summarizeObservation({ text: 'Y'.repeat(5000) }, { threshold: 2000, summarizer: () => 'SUM' });
    assert.equal(r.summarized, true); assert.equal(r.text, 'SUM');
  });

  await test('summarizeObservation: structured object (no text field) is left alone', async () => {
    const out = { messages: [{ uid: 1 }, { uid: 2 }] };
    const r = await summarizeObservation(out, { threshold: 10, summarizer: () => 'SUM' });
    assert.equal(r.summarized, false); assert.deepEqual(r.text, out);
  });

  await test('summarizeObservation: summarizer failure falls back to truncation', async () => {
    const r = await summarizeObservation('Z'.repeat(5000), { threshold: 100, summarizer: () => { throw new Error('down'); } });
    assert.equal(r.summarized, true); assert.equal(r.truncated, true); assert.ok(r.text.length < 5000);
  });

  await test('compressMessages: under budget is unchanged', () => {
    const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
    assert.equal(compressMessages(msgs, { maxMessages: 40 }).length, 2);
  });

  await test('compressMessages: over budget shrinks and keeps the system message', () => {
    const msgs = [{ role: 'system', content: 's' }];
    for (let k = 0; k < 99; k++) msgs.push({ role: k % 2 ? 'tool' : 'user', content: 'm' + k });
    const out = compressMessages(msgs, { maxMessages: 10 });
    assert.ok(out.length <= 10, `expected <=10, got ${out.length}`);
    assert.equal(out[0].role, 'system');
  });

  console.log('Executor integration');

  await test('looping run: warns once, forces a replan, then halts with a loop reason', async () => {
    const events = [];
    const plan = { goal: 'keep searching', steps: [1, 2, 3, 4, 5].map((n) => readStep(n, 'read.search', { q: 'x' })) };
    const res = await execute(plan, {
      loopGuard: { maxIdentical: 3 },
      invoke: async () => ({ ok: true, results: ['r'] }),
      // the model "changes approach" but the canned replan loops again → second trip halts
      replan: async () => ({ ok: true, steps: [readStep(1, 'read.search', { q: 'x' })] }),
      emit: (e) => events.push(e),
    });
    const types = events.map((e) => e.type);
    assert.equal(types.filter((t) => t === 'loop_guard:warned').length, 1, 'expected exactly one warn');
    assert.equal(types.filter((t) => t === 'loop_guard:tripped').length, 1, 'expected exactly one trip');
    assert.ok(types.includes('policy:replan'), 'warn should drive a replan (self-correction)');
    assert.equal(res.aborted, true);
    assert.ok(/loop guard/.test(res.haltReason || ''), `haltReason should name the loop guard, got: ${res.haltReason}`);
  });

  await test('20-step varied plan completes without a trip or overflow', async () => {
    const steps = [];
    for (let n = 1; n <= 20; n++) steps.push(readStep(n, 'read.t' + (n % 4), { q: n }));
    const events = [];
    const res = await execute({ goal: '20 steps', steps }, {
      invoke: async (tool, p) => ({ ok: true, n: p.q }),
      emit: (e) => events.push(e),
    });
    assert.equal(res.ok, true);
    assert.equal(Object.keys(res.results).length, 20);
    assert.equal(events.filter((e) => String(e.type).startsWith('loop_guard')).length, 0);
  });

  await test('honesty: a write NEVER receives a summary — it gets the full exact value', async () => {
    const big = { text: 'B'.repeat(5000) };
    let writeGot = null;
    const plan = {
      goal: 'read then write',
      steps: [
        readStep(1, 'read.big', {}),
        { step: 2, tool: 'write.thing', params: { payload: '{{1}}' }, side_effect: 'write', confirm: false, depends_on: [1], valid: true },
      ],
    };
    await execute(plan, {
      compress: { observations: true, injections: true, threshold: 2000, summarizer: () => 'SUM' },
      invoke: async (tool, p) => { if (tool === 'read.big') return big; writeGot = p.payload; return { ok: true }; },
      emit: () => {},
    });
    assert.deepEqual(writeGot, big, 'write must receive the full object, not a summary');
  });

  await test('injection: a whole {{N}} into a NON-write tool uses the summary when enabled', async () => {
    let consumeGot = null;
    const plan = {
      goal: 'read then consume',
      steps: [
        readStep(1, 'read.big', {}),
        readStep(2, 'read.consume', { ctx: '{{1}}' }, { depends_on: [1] }),
      ],
    };
    const events = [];
    await execute(plan, {
      compress: { observations: true, injections: true, threshold: 2000, summarizer: () => 'SUM' },
      invoke: async (tool, p) => { if (tool === 'read.big') return { text: 'C'.repeat(5000) }; consumeGot = p.ctx; return { ok: true }; },
      emit: (e) => events.push(e),
    });
    assert.equal(consumeGot, 'SUM', 'non-write consumer should receive the summary');
    assert.ok(events.some((e) => e.type === 'context:summary-injected'));
  });

  console.log(`\n${passed} checks passed.`);
})();
