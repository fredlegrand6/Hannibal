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
let lastPayload = null;
const voiceDrops = [];
const app = createPhoneApp({
  token: TOKEN, hosts: ['127.0.0.1'], port: PORT, persona: 'P', log: () => {},
  chat: async (payload, _on, { runTool }) => {
    lastPayload = payload;
    if (/trash/.test(payload.user)) { const ok = await runTool('mail_trash', { id: 1 }); return { ok: true, text: ok ? 'Trashed.' : 'Left it.' }; }
    return { ok: true, text: `You said: ${payload.user}` };
  },
  runTool: async (name, input, { confirmer }) => { toolCalls.push(name); return confirmer({}, 'Trash the mail from Bob'); },
  transcribe: async (buf, mime) => `heard ${buf.length} bytes of ${mime}`,
  speak: async (t) => Buffer.from(`mp3:${t}`),
  status: () => ({ mac: true }),
  onVoiceDrop: (d) => voiceDrops.push(d),
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

  await test('a photo is passed to his vision with the question', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64');
    const j = await (await fetch(`${base}/api/look`, { method: 'POST', headers: C, body: JSON.stringify({ image: 'data:image/jpeg;base64,' + jpeg, text: 'what is this?' }) })).json();
    assert.ok(j.ok);
    assert.deepStrictEqual(lastPayload.images, [jpeg]);
    assert.strictEqual(lastPayload.user, 'what is this?');
    await (await fetch(`${base}/api/look`, { method: 'POST', headers: C, body: JSON.stringify({ image: jpeg }) })).json();
    assert.strictEqual(lastPayload.user, 'What do you see in this photo?');
    const bad = await fetch(`${base}/api/look`, { method: 'POST', headers: C, body: JSON.stringify({ image: '' }) });
    assert.strictEqual(bad.status, 400);
    await (await fetch(`${base}/api/say`, { method: 'POST', headers: C, body: JSON.stringify({ text: 'plain' }) })).json();
    assert.strictEqual(lastPayload.images, undefined);
  });

  await test('live talk with the camera: speech + frame in one turn', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]).toString('base64');
    const audio = Buffer.alloc(12).toString('base64');
    const j = await (await fetch(`${base}/api/voice-look`, { method: 'POST', headers: C, body: JSON.stringify({ audio, mime: 'audio/wav', image: jpeg }) })).json();
    assert.strictEqual(j.heard, 'heard 12 bytes of audio/wav');
    assert.ok(j.ok && j.spoken);
    assert.deepStrictEqual(lastPayload.images, [jpeg]);
    assert.strictEqual(lastPayload.user, 'heard 12 bytes of audio/wav');
    assert.strictEqual((await fetch(`${base}/api/voice-look`, { method: 'POST', headers: C, body: JSON.stringify({ audio }) })).status, 400);
    assert.strictEqual((await fetch(`${base}/api/voice-look`, { method: 'POST', body: JSON.stringify({ audio, image: jpeg }) })).status, 401);
  });

  await test('a photo needs the key', async () => {
    assert.strictEqual((await fetch(`${base}/api/look`, { method: 'POST', body: '{"image":"abc"}' })).status, 401);
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

  await test('the phone reports a voice dropout and it reaches the dropout log', async () => {
    assert.strictEqual((await fetch(`${base}/api/voice-drop`, { method: 'POST', body: '{"stage":"play"}' })).status, 401);
    const r = await fetch(`${base}/api/voice-drop`, { method: 'POST', headers: C, body: JSON.stringify({ stage: 'play', error: 'no sound started within 5 s', device: 'iPhone', where: 'desk' }) });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(voiceDrops, [{ stage: 'play', error: 'no sound started within 5 s', device: 'iPhone', where: 'phone' }]);
  });

  // ── push: the native iPhone app closed ──
  const pushed = [];
  const fakePush = { configured: true, tokens: [], register(t, env) { if (!/^[0-9a-f]{64}$/.test(String(t))) return false; this.tokens.push({ t, env }); return true; },
    count() { return this.tokens.length; }, async notify(p) { pushed.push(p); return 1; } };
  const PORT2 = PORT + 1;
  const base2 = `http://127.0.0.1:${PORT2}`;
  const app2 = createPhoneApp({
    token: TOKEN, hosts: ['127.0.0.1'], port: PORT2, persona: 'P', log: () => {}, push: fakePush,
    chat: async (payload, _on, { runTool }) => { const ok = await runTool('mail_trash', {}); return { ok: true, text: ok ? 'Trashed.' : 'Left it.' }; },
    runTool: async (name, input, { confirmer }) => confirmer({}, 'Trash the mail from Bob'),
  });
  app2.start();
  await new Promise((r) => setTimeout(r, 100));

  await test('the iPhone app registers its push token (needs the key, checks the format)', async () => {
    assert.strictEqual((await fetch(`${base2}/api/push-token`, { method: 'POST', body: '{}' })).status, 401);
    const bad = await fetch(`${base2}/api/push-token`, { method: 'POST', headers: C, body: JSON.stringify({ token: 'nope' }) });
    assert.strictEqual(bad.status, 400);
    const ok = await fetch(`${base2}/api/push-token`, { method: 'POST', headers: C, body: JSON.stringify({ token: 'a'.repeat(64), env: 'sandbox' }) });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(fakePush.count(), 1);
  });

  await test('with the app closed a reminder goes out as a push', async () => {
    pushed.length = 0;
    app2.notify('Call Jay at 19:00');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(pushed, [{ body: 'Call Jay at 19:00' }]);
  });

  await test('with the app open no push is sent (the app shows it)', async () => {
    pushed.length = 0;
    const ctrl = new AbortController();
    await fetch(`${base2}/api/events`, { headers: C, signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 30));
    app2.notify('Brief');
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(pushed.length, 0);
    ctrl.abort();
    await new Promise((r) => setTimeout(r, 50));
  });

  await test('with the app closed a Yes/No goes to the lock screen and waits for the answer', async () => {
    pushed.length = 0;
    const said = fetch(`${base2}/api/say`, { method: 'POST', headers: C, body: JSON.stringify({ text: 'trash it' }) }).then((r) => r.json());
    for (let i = 0; i < 40 && !pushed.length; i++) await new Promise((r) => setTimeout(r, 25));
    assert.strictEqual(pushed[0].category, 'CONFIRM');
    assert.match(pushed[0].body, /Trash the mail from Bob/);
    const id = pushed[0].data.confirmId;
    await fetch(`${base2}/api/confirm`, { method: 'POST', headers: C, body: JSON.stringify({ id, yes: true }) });
    assert.strictEqual((await said).reply, 'Trashed.');
  });

  await test('if the Yes/No push cannot be delivered, the answer is no', async () => {
    fakePush.notify = async (p) => { pushed.push(p); return 0; };
    const j = await (await fetch(`${base2}/api/say`, { method: 'POST', headers: C, body: JSON.stringify({ text: 'trash it' }) })).json();
    assert.strictEqual(j.reply, 'Left it.');
  });
  app2.stop();

  app.stop();
  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
  process.exit(process.exitCode || 0);
})();
