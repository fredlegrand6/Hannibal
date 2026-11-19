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
    assert.strictEqual(Number(m[1]), 16, out);
    assert.ok(/SIGTERM, stopping/.test(out), out);
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
