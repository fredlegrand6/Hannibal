// TEST — the phone app: private access, chat, voice, Yes/No confirmations.
// Offline (fake brain). Run: node server/test-phone-app.js
'use strict';
const assert = require('assert');
const { createPhoneApp } = require('./phone-app');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.stack || e.message}`); process.exitCode = 1; }
}
const TOKEN = 'k'.repeat(32);
const PORT = 18791;
const base = `http://127.0.0.1:${PORT}`;
const C = { cookie: `hannibal_k=${TOKEN}` };

let toolCalls = [];
const app = createPhoneApp({
  token: TOKEN, hosts: ['127.0.0.1'], port: PORT, persona: 'P', log: () => {},
  chat: async (payload, _on, { runTool }) => {
    if (/trash/.test(payload.user)) { const ok = await runTool('mail_trash', { id: 1 }); return { ok: true, text: ok ? 'Trashed.' : 'Left it.' }; }
    return { ok: true, text: `You said: ${payload.user}` };
  },
  runTool: async (name, input, { confirmer }) => { toolCalls.push(name); return confirmer({}, 'Trash the mail from Bob'); },
  transcribe: async (buf, mime) => `heard ${buf.length} bytes of ${mime}`,
  speak: async (t) => Buffer.from(`mp3:${t}`),
  status: () => ({ mac: true }),
});

(async () => {
  console.log('phone app');
  app.start();
  await new Promise((r) => setTimeout(r, 150));

  await test('without the key nothing is served', async () => {
    assert.strictEqual((await fetch(`${base}/`)).status, 401);
    assert.strictEqual((await fetch(`${base}/api/say`, { method: 'POST', body: '{"text":"hi"}' })).status, 401);
    assert.strictEqual((await fetch(`${base}/?k=wrong`, { redirect: 'manual' })).status, 403);
  });

  await test('the setup link sets the cookie and redirects', async () => {
    const r = await fetch(`${base}/?k=${TOKEN}`, { redirect: 'manual' });
    assert.strictEqual(r.status, 302);
    assert.match(r.headers.get('set-cookie'), /hannibal_k=k+; Path=\/; Max-Age=31536000; HttpOnly; SameSite=Strict/);
    const page = await fetch(`${base}/`, { headers: C });
    assert.strictEqual(page.status, 200);
    assert.match(await page.text(), /HANNIBAL/);
  });

  await test('typed message gets an answer', async () => {
    const j = await (await fetch(`${base}/api/say`, { method: 'POST', headers: C, body: JSON.stringify({ text: 'hello' }) })).json();
    assert.deepStrictEqual([j.ok, j.reply], [true, 'You said: hello']);
  });

  await test('voice is transcribed with its type, then answered', async () => {
    const j = await (await fetch(`${base}/api/voice`, { method: 'POST', headers: { ...C, 'Content-Type': 'audio/mp4' }, body: Buffer.alloc(10) })).json();
    assert.strictEqual(j.heard, 'heard 10 bytes of audio/mp4');
    assert.ok(j.ok && j.spoken);
  });

  await test('speak returns Hannibal\'s voice as mp3', async () => {
    const r = await fetch(`${base}/api/speak`, { method: 'POST', headers: C, body: JSON.stringify({ text: 'hi' }) });
    assert.strictEqual(r.headers.get('content-type'), 'audio/mpeg');
    assert.strictEqual(Buffer.from(await r.arrayBuffer()).toString(), 'mp3:hi');
  });

  await test('a write asks Yes/No in the app and waits for the answer', async () => {
    const ctrl = new AbortController();
    const es = await fetch(`${base}/api/events`, { headers: C, signal: ctrl.signal });
    const reader = es.body.getReader();
    const events = [];
    (async () => { let buf = ''; for (;;) { const { value, done } = await reader.read().catch(() => ({ done: true })); if (done) break; buf += Buffer.from(value).toString(); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); if (chunk.startsWith('data: ')) events.push(JSON.parse(chunk.slice(6))); } } })();
    const said = fetch(`${base}/api/say`, { method: 'POST', headers: C, body: JSON.stringify({ text: 'trash it' }) }).then((r) => r.json());
    for (let i = 0; i < 40 && !events.find((e) => e.type === 'confirm'); i++) await new Promise((r) => setTimeout(r, 25));
    assert.deepStrictEqual(events[0], { type: 'hello', status: { mac: true } });
    const ask = events.find((e) => e.type === 'confirm');
    assert.ok(ask && /Trash the mail from Bob/.test(ask.summary));
    await fetch(`${base}/api/confirm`, { method: 'POST', headers: C, body: JSON.stringify({ id: ask.id, yes: true }) });
    assert.strictEqual((await said).reply, 'Trashed.');
    const again = await fetch(`${base}/api/confirm`, { method: 'POST', headers: C, body: JSON.stringify({ id: ask.id, yes: true }) });
    assert.strictEqual(again.status, 410, 'an answered question cannot be answered twice');
    ctrl.abort();
  });

  await test('with the app closed a write is declined, never done unasked', async () => {
    await new Promise((r) => setTimeout(r, 50));
    const j = await (await fetch(`${base}/api/say`, { method: 'POST', headers: C, body: JSON.stringify({ text: 'trash it' }) })).json();
    assert.strictEqual(j.reply, 'Left it.');
  });

  app.stop();
  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
  process.exit(process.exitCode || 0);
})();
