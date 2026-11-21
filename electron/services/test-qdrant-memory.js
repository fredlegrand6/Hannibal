// ─────────────────────────────────────────────────────────────────────────
// TEST — long-term memory rules (qdrant-memory.js): what is kept, dedupe,
// picky recall. Offline (fake fetch). Run:  node electron/services/test-qdrant-memory.js
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const assert = require('assert');
const { createQdrantMemory, worthRemembering, tidyReply, tidyExchange } = require('./qdrant-memory');

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
    const { mem } = fakeBackend([{ text: 'noise', score: 0.52 }]);
    assert.strictEqual(await mem.recall('capital of Peru'), '');
  });

  const crowd = (n, score) => Array.from({ length: n }, (_, i) => ({ text: `filler ${i}`, score: score - i * 0.001 }));
  await test('recall finds a related memory worded differently (0.6, well above the crowd)', async () => {
    const { mem } = fakeBackend([{ text: "Fred said: I'd like you to meet a friend of mine, Max", score: 0.652 }, ...crowd(25, 0.54)]);
    const block = await mem.recall('did you meet any of my friends');
    assert.ok(block.includes('Max'), block);
    assert.ok(!block.includes('filler'));
  });

  await test('recall stays quiet when the best hit does not stand out from the crowd', async () => {
    const { mem } = fakeBackend([{ text: 'meh', score: 0.60 }, ...crowd(25, 0.575)]);
    assert.strictEqual(await mem.recall('open Spotify'), '');
  });

  await test('replies are never stored cut off mid-sentence', async () => {
    assert.strictEqual(tidyReply("Alright Fred, see you around half three. I'll keep an eye on thi"), 'Alright Fred, see you around half three. … (interrupted)');
    assert.strictEqual(tidyReply("It's 1:38, Thursday afternoon."), "It's 1:38, Thursday afternoon.");
    assert.strictEqual(tidyReply('I'), 'I … (interrupted)');
    const long = 'This is one full sentence. '.repeat(80);
    const t = tidyReply(long);
    assert.ok(t.length <= 1205 && /sentence\. …$/.test(t), t.slice(-40));
    assert.strictEqual(tidyExchange("Fred said: hi there you\nHannibal replied: Hello. I'll be"), "Fred said: hi there you\nHannibal replied: Hello. … (interrupted)");
    const { calls, mem } = fakeBackend([]);
    await mem.store(`Fred said: how are you feeling today then\nHannibal replied: ${long}`, { type: 'conversation' });
    const put = calls.find((c) => c.method === 'PUT');
    assert.ok(/sentence\. …$/.test(put.body.points[0].payload.text));
  });

  await test('old memories cut at 500 characters are trimmed back to a full sentence', async () => {
    const calls = [];
    const cut = `Fred said: what can I do for you\nHannibal replied: ${'Thanks, that means a lot. '.repeat(19)}Honestly, you already do the big thing: you k`.slice(0, 1000);
    const fine = "Fred said: what time is it now\nHannibal replied: It's 1:38, Thursday afternoon.";
    const fetchImpl = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (url.endsWith('/points/scroll')) return { json: async () => ({ result: { points: [{ id: 'a', payload: { text: cut } }, { id: 'b', payload: { text: fine } }], next_page_offset: null } }) };
      return { json: async () => ({ status: 'ok' }) };
    };
    const mem = createQdrantMemory({ qdrantUrl: 'http://q', ollamaUrl: 'http://o', fetchImpl, log: () => {} });
    assert.strictEqual(await mem.repairCutReplies(), 1);
    const upd = calls.find((c) => c.url.endsWith('/points/payload'));
    assert.deepStrictEqual(upd.body.points, ['a']);
    assert.ok(/a lot\. …$/.test(upd.body.payload.text), upd.body.payload.text.slice(-30));
    assert.strictEqual(upd.body.payload.text_was, cut);
    assert.strictEqual(tidyExchange(upd.body.payload.text), upd.body.payload.text, 'running it again changes nothing');
  });

  await test('fails soft when the server is down', async () => {
    const mem = createQdrantMemory({ qdrantUrl: 'http://q', ollamaUrl: 'http://o', fetchImpl: async () => { throw new Error('down'); }, log: () => {} });
    assert.strictEqual(await mem.recall('x y z w'), '');
    assert.strictEqual(await mem.store(conv('How is my server doing?'), { type: 'conversation' }), false);
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
