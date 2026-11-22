// ─────────────────────────────────────────────────────────────────────────
// TEST — the pieces the always-on server adds. Offline, temp files only.
// Run:  node server/test-server.js
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const S = path.join(__dirname, '..', 'electron', 'services');
const { createReminderTools } = require(path.join(S, 'proactive'));
const { makeElevenLabsTranscriber } = require(path.join(S, 'telegram'));
const claudeTools = require(path.join(S, 'claude-tools'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hannibal-server-'));
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.stack || e.message}`); process.exitCode = 1; }
}

(async () => {
  console.log('server');

  await test('takeDue hands out each due reminder once and leaves future ones', () => {
    let t = Date.parse('2026-11-19T10:00:00');
    const r = createReminderTools({ filePath: path.join(TMP, 'rem.json'), now: () => t });
    r.add('call Jay', '2026-11-19T10:30');
    r.add('fly to Ibiza', '2026-11-20T07:00');
    assert.deepStrictEqual(r.takeDue(), []);
    t = Date.parse('2026-11-19T10:31:00');
    const due = r.takeDue();
    assert.deepStrictEqual(due.map((d) => d.message), ['call Jay']);
    assert.deepStrictEqual(r.takeDue(), []);                     // not twice
    assert.deepStrictEqual(r.upcoming().reminders.map((x) => x.message), ['fly to Ibiza']);
  });

  await test('only tools whose handlers exist are offered to Claude', () => {
    claudeTools.setAvailableChannels(['mail:inbox', 'calendar:events', 'facts:remember']);
    const names = claudeTools.toolDefinitions().map((d) => claudeTools.fromApiName(d.name));
    assert.ok(names.includes('mail.inbox') && names.includes('calendar.events') && names.includes('memory.remember'));
    assert.ok(!names.includes('app.open') && !names.includes('camera.look') && !names.includes('mail.send'));
    claudeTools.setAvailableChannels(null);
    assert.ok(claudeTools.toolDefinitions().map((d) => claudeTools.fromApiName(d.name)).includes('app.open'));
  });

  await test('voice notes go to ElevenLabs speech-to-text with the key', async () => {
    let seen;
    const tr = makeElevenLabsTranscriber({ apiKey: 'k', fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ text: ' Remind me to call Jay ' }) }; } });
    assert.strictEqual(await tr(Buffer.from('ogg')), 'Remind me to call Jay');
    assert.strictEqual(seen.url, 'https://api.elevenlabs.io/v1/speech-to-text');
    assert.strictEqual(seen.init.headers['xi-api-key'], 'k');
    assert.strictEqual(seen.init.body.get('model_id'), 'scribe_v1');
  });

  await test('speech-to-text errors are reported, a missing key too', async () => {
    const bad = makeElevenLabsTranscriber({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ detail: { message: 'invalid key' } }) }) });
    await assert.rejects(bad(Buffer.from('x')), /invalid key/);
    await assert.rejects(makeElevenLabsTranscriber({ apiKey: '' })(Buffer.from('x')), /ELEVENLABS_API_KEY/);
  });

  await test('the server starts with the Mac-free tool set and stops cleanly', async () => {
    const data = fs.mkdtempSync(path.join(TMP, 'data-'));
    const out = await new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(__dirname, 'hannibal-server.js')], {
        env: { ...process.env, HANNIBAL_ENV: '/dev/null', HANNIBAL_DATA: data, TELEGRAM_BOT_TOKEN: '1:test',
          ANTHROPIC_API_KEY: 'x', HANNIBAL_BRIEF: '0' },
      });
      let s = '';
      p.stdout.on('data', (d) => { s += d; if (/server up/.test(s)) p.kill('SIGTERM'); });
      p.stderr.on('data', (d) => { s += d; });
      p.on('close', () => resolve(s));
      setTimeout(() => p.kill('SIGKILL'), 10000);
    });
    const m = /Hannibal server up: (\d+) tools/.exec(out);
    assert.ok(m, out);
    assert.strictEqual(Number(m[1]), 28, out);   // incl. mail.*, memory.conversations, memory.threads/thread, calendar.add/delete/move, reminders.recent, voice.dropouts
    assert.ok(/SIGTERM, stopping/.test(out), out);
  });

  // ── the Mac link ──
  const { WebSocketServer } = require('ws');
  const { createBodyHub } = require('./body-hub');
  const { BrainClient } = require(path.join(S, 'brain', 'client'));
  const TOKEN = 'test-token-0123456789abcdef';
  const port = 18790 + Math.floor(Math.random() * 500);
  let linkedWith = null; let unlinked = 0;
  const serverFacts = [{ id: 'f1', text: 'Jay is Fred\'s son', category: 'person' }];
  const hub = createBodyHub({
    host: '127.0.0.1', port, token: TOKEN, WebSocketServer, log: () => {},
    onLink: (b) => { linkedWith = b; }, onUnlink: () => { unlinked += 1; },
    methods: { 'facts.sync': ({ facts }) => ({ facts: [...serverFacts, ...facts] }) },
  });
  await new Promise((r) => hub._wss.once('listening', r));
  const quietClient = (token) => { const c = new BrainClient({ url: `ws://127.0.0.1:${port}`, token, bodyId: 'mac', reconnect: false }); c.on('error', () => {}); return c; };

  await test('a Mac with the wrong key is refused', async () => {
    const c = quietClient('wrong-token-xxxxxxxxxxxxxxxx');
    c.connect();
    await assert.rejects(c.waitReady(3000));
    assert.strictEqual(hub.linked(), false);
  });

  let mac;
  await test('the Mac links, registers its tools and syncs facts', async () => {
    mac = quietClient(TOKEN);
    mac.setHandler('body.invoke', async ({ tool, params }) => ({ ok: true, ran: tool, params }));
    mac.connect();
    await mac.waitReady(3000);
    await mac.request('body.register', { channels: ['mac-control', 'voice:capture'] });
    assert.ok(hub.linked());
    assert.deepStrictEqual(hub.channels().sort(), ['mac-control', 'voice:capture']);
    assert.ok(linkedWith);
    const r = await mac.request('facts.sync', { facts: [{ id: 'f9', text: 'Gaian is 12', category: 'person' }] });
    assert.strictEqual(r.facts.length, 2);
  });

  await test('the server runs a tool on the Mac and gets the result back', async () => {
    const out = await hub.invoke('app.open', { name: 'Spotify' });
    assert.deepStrictEqual(out, { ok: true, ran: 'app.open', params: { name: 'Spotify' } });
  });

  await test('events reach the Mac (the new facts list)', async () => {
    const got = new Promise((resolve) => mac.on('event', (name, data) => resolve({ name, data })));
    hub.notify('facts', { facts: serverFacts });
    const ev = await got;
    assert.strictEqual(ev.name, 'facts');
    assert.strictEqual(ev.data.facts[0].text, 'Jay is Fred\'s son');
  });

  await test('when the Mac goes offline, Mac tools fail cleanly', async () => {
    mac.close();
    for (let i = 0; i < 50 && hub.linked(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(hub.linked(), false);
    assert.strictEqual(unlinked, 1);
    await assert.rejects(hub.invoke('app.open', { name: 'x' }), /offline/);
  });
  hub.close();

  await test('a short or missing link key is rejected at start', () => {
    assert.throws(() => createBodyHub({ host: '127.0.0.1', port: port + 1, token: 'short', WebSocketServer }), /BODY_LINK_TOKEN/);
  });

  // ── review fixes: reminders across both lists, facts reconcile ──
  const { cancelAcross } = require(path.join(S, 'proactive'));
  await test('cancel asks again when several reminders match across server and desk', async () => {
    const t = Date.parse('2026-11-19T10:00:00');
    const local = createReminderTools({ filePath: path.join(TMP, 'rem2.json'), now: () => t });
    local.add('call Jay', '2026-11-19T12:00'); local.add('call Joe', '2026-11-19T13:00');
    let remoteCancelled = null;
    const remote = [{ id: 'r-desk-1', message: 'call dentist', when: 'Friday' }];
    const r = await cancelAcross({ local, remote, query: 'call', cancelRemote: async (id) => { remoteCancelled = id; return { ok: true }; } });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.matches.length, 3);
    assert.strictEqual(remoteCancelled, null);
    assert.strictEqual(local.upcoming().reminders.length, 2);          // nothing touched
  });
  await test('one clear match is cancelled where it lives', async () => {
    const t = Date.parse('2026-11-19T10:00:00');
    const local = createReminderTools({ filePath: path.join(TMP, 'rem3.json'), now: () => t });
    local.add('call Jay', '2026-11-19T12:00');
    let remoteCancelled = null;
    const remote = [{ id: 'r-desk-1', message: 'call dentist', when: 'Friday' }];
    const r1 = await cancelAcross({ local, remote, query: 'dentist', cancelRemote: async (id) => { remoteCancelled = id; return { ok: true }; } });
    assert.ok(r1.ok); assert.strictEqual(remoteCancelled, 'r-desk-1');
    assert.strictEqual(local.upcoming().reminders.length, 1);
    const r2 = await cancelAcross({ local, remote: [], query: 'jay', cancelRemote: async () => { throw new Error('no'); } });
    assert.ok(r2.ok); assert.strictEqual(local.upcoming().reminders.length, 0);
  });

  await test('facts reconcile on relink: desk adds and deletes count, phone deletes are not undone', async () => {
    const data = fs.mkdtempSync(path.join(TMP, 'sync-'));
    fs.writeFileSync(path.join(data, 'memory-facts.json'), JSON.stringify({ version: 1, facts: [
      { id: 'f1', text: 'Jay is Fred\'s son', category: 'person' },
      { id: 'f4', text: 'Fred flies to Ibiza every 4 weeks', category: 'routine' },
    ] }));
    const p2 = 19300 + Math.floor(Math.random() * 500);
    const srv = spawn(process.execPath, [path.join(__dirname, 'hannibal-server.js')], {
      env: { ...process.env, HANNIBAL_ENV: '/dev/null', HANNIBAL_DATA: data, TELEGRAM_BOT_TOKEN: '1:test', ANTHROPIC_API_KEY: 'x',
        HANNIBAL_BRIEF: '0', BODY_LINK_TOKEN: TOKEN, BODY_LINK_HOST: '127.0.0.1', BODY_LINK_PORT: String(p2) },
    });
    try {
      await new Promise((resolve) => { let o = ''; srv.stdout.on('data', (d) => { o += d; if (/waiting for the Mac/.test(o)) resolve(); }); setTimeout(resolve, 4000); });
      const c = new BrainClient({ url: `ws://127.0.0.1:${p2}`, token: TOKEN, bodyId: 'mac', reconnect: false }); c.on('error', () => {});
      c.connect(); await c.waitReady(3000);
      // Last agreed: Jay, "Gaian is 12" (since deleted on the phone), Ibiza (since deleted at the desk).
      const lastSynced = [{ id: 'f1', text: 'Jay is Fred\'s son' }, { id: 'f2', text: 'Gaian is 12' }, { id: 'f4', text: 'Fred flies to Ibiza every 4 weeks' }];
      const desk = [{ id: 'f1', text: 'Jay is Fred\'s son', category: 'person' }, { id: 'f2', text: 'Gaian is 12', category: 'person' },
        { id: 'f9', text: 'Fred likes espresso', category: 'preference' }];
      const r = await c.request('facts.sync', { facts: desk, lastSynced });
      const texts = r.facts.map((f) => f.text).sort();
      assert.deepStrictEqual(texts, ['Fred likes espresso', 'Jay is Fred\'s son']);
      c.close();
    } finally { srv.kill('SIGTERM'); }
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
