// ─────────────────────────────────────────────────────────────────────────
// TEST — long-term memory rules (qdrant-memory.js): what is kept, dedupe,
// picky recall. Offline (fake fetch). Run:  node electron/services/test-qdrant-memory.js
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const assert = require('assert');
const { createQdrantMemory, worthRemembering } = require('./qdrant-memory');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.stack || e.message}`); process.exitCode = 1; }
}

const conv = (said) => `Fred said: ${said}\nHannibal replied: ok`;

// Fake Ollama + Qdrant. `hits` is what a search returns (before the threshold,
// which the fake applies like Qdrant does).
function fakeBackend(hits = []) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, body, headers: init.headers });
    if (url.endsWith('/api/embeddings')) return { json: async () => ({ embedding: [0.1, 0.2] }) };
    if (url.endsWith('/points/search')) {
      return { json: async () => ({ result: hits.filter((h) => h.score >= (body.score_threshold || 0)).slice(0, body.limit)
        .map((h) => ({ score: h.score, payload: { text: h.text, timestamp: h.ts, type: h.type } })) }) };
    }
    return { json: async () => ({ status: 'ok' }) };
  };
  return { calls, mem: createQdrantMemory({ qdrantUrl: 'http://q:6333/', ollamaUrl: 'http://o:11434', apiKey: 'k', fetchImpl, log: () => {} }) };
}

(async () => {
  console.log('qdrant-memory');

  await test('small talk, wake-word-only and short commands are not kept', () => {
    for (const s of ['Thank you.', 'Thank you very much.', 'Hey, Hannibal.', 'Hey Hannibal, you listening?', 'Okay, thank you.',
      'Please do.', 'Hey Hannibal, open Chrome.', 'yes', 'How are you today?', 'Oh, lovely.']) {
      assert.strictEqual(worthRemembering(conv(s), { type: 'conversation' }), false, s);
    }
  });

  await test('overheard music, foreign speech and long rambles are not kept', () => {
    assert.strictEqual(worthRemembering(conv('*Song* *Song* *Song*'), { type: 'conversation' }), false);
    assert.strictEqual(worthRemembering(conv('Crips [speaking in foreign language] post up'), { type: 'conversation' }), false);
    assert.strictEqual(worthRemembering(conv('(breathing heavily)'), { type: 'conversation' }), false);
    assert.strictEqual(worthRemembering(conv('word '.repeat(200)), { type: 'conversation' }), false);
  });

  await test('real conversations are kept, on the desk and on Telegram', () => {
    assert.strictEqual(worthRemembering(conv('How is my server doing?'), { type: 'conversation' }), true);
    assert.strictEqual(worthRemembering('Fred said (Telegram): Jay starts on the Mutuele launch next week\nHannibal replied: Noted.',
      { type: 'conversation', channel: 'telegram' }), true);
  });

  await test('old noisy record types are never kept; notes always are', () => {
    for (const type of ['world-read', 'agent_run', 'agent-action']) assert.strictEqual(worthRemembering('anything at all here', { type }), false);
    assert.strictEqual(worthRemembering('Buy milk', { type: 'note' }), true);
  });

  await test('store skips small talk without calling the network', async () => {
    const { calls, mem } = fakeBackend();
    assert.strictEqual(await mem.store(conv('Thanks.'), { type: 'conversation' }), false);
    assert.strictEqual(calls.length, 0);
  });

  await test('store skips a near-identical memory that is already there', async () => {
    const { calls, mem } = fakeBackend([{ text: 'same', score: 0.99 }]);
    assert.strictEqual(await mem.store(conv('How is my server doing?'), { type: 'conversation' }), false);
    assert.ok(!calls.some((c) => c.method === 'PUT'));
  });

  await test('store writes a new memory with the api key', async () => {
    const { calls, mem } = fakeBackend([{ text: 'different', score: 0.8 }]);
    assert.strictEqual(await mem.store(conv('How is my server doing?'), { type: 'conversation' }), true);
    const put = calls.find((c) => c.method === 'PUT');
    assert.ok(put && put.url === 'http://q:6333/collections/hannibal_memory/points');
    assert.strictEqual(put.headers['api-key'], 'k');
    assert.strictEqual(put.body.points[0].payload.type, 'conversation');
  });

  await test('recall drops weak hits and hits far below the best one, and dates each line', async () => {
    const { calls, mem } = fakeBackend([
      { text: 'GEX131 is healthy', score: 0.80, ts: '2026-11-19T11:12:00Z', type: 'conversation' },
      { text: 'close one', score: 0.75, ts: '2026-11-18T07:00:00Z', type: 'conversation' },
      { text: 'far below best', score: 0.70, ts: '2026-11-18T07:00:00Z', type: 'conversation' },
      { text: 'unrelated noise', score: 0.62, ts: '2026-05-22T04:00:00Z', type: 'conversation' },
    ]);
    const block = await mem.recall('How is my server?');
    assert.ok(/^RELEVANT MEMORIES/.test(block));
    assert.ok(block.includes('- (19 Nov 2026) GEX131 is healthy'));
    assert.ok(block.includes('close one'));
    assert.ok(!block.includes('far below best'));
    assert.ok(!block.includes('unrelated noise'));
    const search = calls.find((c) => c.url.endsWith('/points/search'));
    assert.deepStrictEqual(search.body.filter.must_not[0].match.any, ['world-read', 'agent_run', 'agent-action']);
  });

  await test('recall is empty when nothing clears the bar', async () => {
    const { mem } = fakeBackend([{ text: 'noise', score: 0.6 }]);
    assert.strictEqual(await mem.recall('capital of Peru'), '');
  });

  await test('fails soft when the server is down', async () => {
    const mem = createQdrantMemory({ qdrantUrl: 'http://q', ollamaUrl: 'http://o', fetchImpl: async () => { throw new Error('down'); }, log: () => {} });
    assert.strictEqual(await mem.recall('x y z w'), '');
    assert.strictEqual(await mem.store(conv('How is my server doing?'), { type: 'conversation' }), false);
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
