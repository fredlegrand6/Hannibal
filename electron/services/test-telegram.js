// ─────────────────────────────────────────────────────────────────────────
// TEST — Telegram bridge (telegram.js). Offline: a fake Telegram API.
// Run:  node electron/services/test-telegram.js
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const assert = require('assert');
const Module = require('module');

const fakeSdk = function Anthropic() {};
fakeSdk.APIError = class extends Error {};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === '@anthropic-ai/sdk' ? fakeSdk : origLoad.call(this, req, ...rest); };

const { createTelegramBridge, splitMessage, parseIds, makeWhisperTranscriber, PHONE_CONTEXT } = require('./telegram');
const brain = require('./claude-brain');

const FRED = 4242;
function fakeTelegram() {
  const calls = [];
  let nextId = 100;
  const fetchImpl = async (url, init) => {
    if (url.includes('/file/bot')) return { ok: true, arrayBuffer: async () => Buffer.from('AUDIO') };
    const method = url.split('/').pop();
    const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : (init && init.body ? { form: init.body } : {});
    calls.push({ method, body });
    let result = true;
    if (method === 'sendMessage') result = { message_id: nextId++ };
    if (method === 'getFile') result = { file_path: 'voice/x.oga' };
    if (method === 'getMe') result = { username: 'hannibal_test_bot' };
    if (method === 'getUpdates') result = [];
    return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
  };
  return { calls, fetchImpl, sent: () => calls.filter((c) => c.method === 'sendMessage').map((c) => c.body) };
}
const msg = (text, from = FRED, extra = {}) => ({ message: { chat: { id: from, type: 'private' }, from: { id: from }, text, ...extra } });
const tick = () => new Promise((r) => setImmediate(r));

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.stack || e.message}`); process.exitCode = 1; }
}

(async () => {
  console.log('Helpers');
  await test('long replies are split under the Telegram limit', () => {
    const parts = splitMessage('word '.repeat(2000), 4000);
    assert(parts.length >= 3 && parts.every((p) => p.length <= 4000));
  });
  await test('allowed ids parse from a comma list', () => {
    assert.deepStrictEqual([...parseIds(' 123, 456 ;x ')], ['123', '456']);
  });

  console.log('Who gets answered');
  await test('a stranger gets "not authorised" + their id once, and never reaches the brain', async () => {
    const tg = fakeTelegram();
    let chats = 0;
    const b = createTelegramBridge({ token: 't', allowedIds: String(FRED), fetchImpl: tg.fetchImpl, log: () => {}, chat: async () => { chats++; return { ok: true, text: 'x' }; } });
    await b.handleUpdate(msg('hi', 999));
    await b.handleUpdate(msg('hi again', 999));
    await b.idle();
    assert.strictEqual(chats, 0);
    assert.strictEqual(tg.sent().length, 1);
    assert(/Not authorised.*999/.test(tg.sent()[0].text));
  });
  await test('Fred\'s text goes to the brain with the phone context; the reply comes back', async () => {
    const tg = fakeTelegram();
    let got = null;
    const b = createTelegramBridge({ token: 't', allowedIds: String(FRED), fetchImpl: tg.fetchImpl, log: () => {},
      chat: async (p) => { got = p; return { ok: true, text: 'You have two meetings tomorrow.' }; } });
    await b.handleUpdate(msg('what is on tomorrow?'));
    await b.idle();
    assert.strictEqual(got.user, 'what is on tomorrow?');
    assert.strictEqual(got.context, PHONE_CONTEXT);
    assert.strictEqual(tg.sent().pop().text, 'You have two meetings tomorrow.');
  });

  console.log('Long-term memory');
  await test('Qdrant memories ride in the context, and the exchange is stored', async () => {
    const tg = fakeTelegram();
    let got = null; const stored = [];
    const b = createTelegramBridge({ token: 't', allowedIds: String(FRED), fetchImpl: tg.fetchImpl, log: () => {},
      memory: { recall: async (q) => { assert.strictEqual(q, 'who is Alex?'); return 'RELEVANT MEMORIES:\n- Alex is a friend of Fred\'s'; },
        store: async (txt, meta) => { stored.push({ txt, meta }); } },
      chat: async (p) => { got = p; return { ok: true, text: 'Alex is your friend.' }; } });
    await b.handleUpdate(msg('who is Alex?'));
    await b.idle();
    assert(got.context.startsWith(PHONE_CONTEXT) && /Alex is a friend/.test(got.context));
    assert.strictEqual(stored.length, 1);
    assert(/Telegram\): who is Alex\?/.test(stored[0].txt) && stored[0].meta.channel === 'telegram');
  });
  await test('memory being down never blocks the answer', async () => {
    const { createQdrantMemory } = require('./qdrant-memory');
    const mem = createQdrantMemory({ qdrantUrl: 'http://q', ollamaUrl: 'http://o', log: () => {}, fetchImpl: async () => { throw new Error('offline'); } });
    assert.strictEqual(await mem.recall('x'), '');
    assert.strictEqual(await mem.store('x'), false);
  });

  console.log('Voice notes and photos');
  await test('a voice note is transcribed, echoed, and answered', async () => {
    const tg = fakeTelegram();
    let got = null;
    const b = createTelegramBridge({ token: 't', allowedIds: String(FRED), fetchImpl: tg.fetchImpl, log: () => {},
      transcribe: async (buf) => { assert.strictEqual(buf.toString(), 'AUDIO'); return 'remind me to call Jay'; },
      chat: async (p) => { got = p; return { ok: true, text: 'Done.' }; } });
    await b.handleUpdate(msg(undefined, FRED, { voice: { file_id: 'v1' } }));
    await b.idle();
    assert.strictEqual(got.user, 'remind me to call Jay');
    assert(tg.sent().some((m) => /remind me to call Jay/.test(m.text)));
  });
  await test('a photo goes to Claude as an image, caption as the question', async () => {
    const tg = fakeTelegram();
    let got = null;
    const b = createTelegramBridge({ token: 't', allowedIds: String(FRED), fetchImpl: tg.fetchImpl, log: () => {},
      chat: async (p) => { got = p; return { ok: true, text: 'A contract.' }; } });
    await b.handleUpdate(msg(undefined, FRED, { caption: 'what is this?', photo: [{ file_id: 's', file_size: 10 }, { file_id: 'b', file_size: 99 }] }));
    await b.idle();
    assert.strictEqual(got.user, 'what is this?');
    assert.deepStrictEqual(got.images, [Buffer.from('AUDIO').toString('base64')]);
  });
  await test('the whisper transcriber reports a speaker-check rejection', async () => {
    const t = makeWhisperTranscriber({ whisperUrl: 'http://w', fetchImpl: async (url) => {
      assert(/language=auto/.test(url));
      return { json: async () => ({ success: false, error: 'Speaker not recognized' }) };
    } });
    await assert.rejects(t(Buffer.from('x')), /Speaker not recognized/);
  });

  console.log('Confirmations on the phone');
  const withConfirm = (tg, answer) => {
    let decided = null;
    const b = createTelegramBridge({ token: 't', allowedIds: String(FRED), fetchImpl: tg.fetchImpl, log: () => {}, confirmTimeoutMs: 50,
      runTool: async (_n, _i, { confirmer }) => { decided = await confirmer({ step: 1 }, 'Send mail to Jay: "on my way"'); return { status: decided ? 'ok' : 'declined' }; },
      chat: async (_p, _o, { runTool }) => { await runTool('mail__send', {}); return { ok: true, text: decided ? 'Sent.' : 'Left it.' }; } });
    return { b, result: () => decided, answer };
  };
  await test('a Yes button tap approves the action', async () => {
    const tg = fakeTelegram();
    const { b, result } = withConfirm(tg);
    await b.handleUpdate(msg('mail Jay'));
    for (let i = 0; i < 5 && !b._pending.size; i++) await tick();
    const ask = tg.sent().find((m) => /Shall I go ahead/.test(m.text));
    assert(ask && ask.reply_markup.inline_keyboard[0].length === 2);
    await b.handleUpdate({ callback_query: { id: 'q', from: { id: FRED }, data: ask.reply_markup.inline_keyboard[0][0].callback_data, message: { chat: { id: FRED }, message_id: 100 } } });
    await b.idle();
    assert.strictEqual(result(), true);
    assert.strictEqual(tg.sent().pop().text, 'Sent.');
  });
  await test('typing "no" declines it', async () => {
    const tg = fakeTelegram();
    const { b, result } = withConfirm(tg);
    await b.handleUpdate(msg('mail Jay'));
    for (let i = 0; i < 5 && !b._pending.size; i++) await tick();
    await b.handleUpdate(msg('nee'));
    await b.idle();
    assert.strictEqual(result(), false);
  });
  await test('"yes but wait" is not a yes; an old button token cannot approve', async () => {
    const tg = fakeTelegram();
    const { b, result } = withConfirm(tg);
    await b.handleUpdate(msg('mail Jay'));
    for (let i = 0; i < 5 && !b._pending.size; i++) await tick();
    await b.handleUpdate(msg('yes but do not send it yet'));
    await b.handleUpdate({ callback_query: { id: 'q', from: { id: FRED }, data: 'yes:old_token', message: { chat: { id: FRED }, message_id: 100 } } });
    assert.strictEqual(b._pending.size, 1, 'still waiting');
    await b.idle();
    assert.strictEqual(result(), false);
  });
  await test('Fred in a group chat gets no answer (private chats only)', async () => {
    const tg = fakeTelegram();
    let chats = 0;
    const b = createTelegramBridge({ token: 't', allowedIds: String(FRED), fetchImpl: tg.fetchImpl, log: () => {}, chat: async () => { chats++; return { ok: true, text: 'secret' }; } });
    await b.handleUpdate({ message: { chat: { id: -77, type: 'group' }, from: { id: FRED }, text: 'what is in my inbox?' } });
    await b.idle();
    assert.strictEqual(chats, 0);
    assert.strictEqual(tg.sent().length, 0);
  });
  await test('no answer means no', async () => {
    const tg = fakeTelegram();
    const { b, result } = withConfirm(tg);
    await b.handleUpdate(msg('mail Jay'));
    await b.idle();
    assert.strictEqual(result(), false);
    assert(tg.sent().some((m) => /No answer in 2 minutes/.test(m.text)));
  });
  await test('a stranger cannot press Yes', async () => {
    const tg = fakeTelegram();
    const { b, result } = withConfirm(tg);
    await b.handleUpdate(msg('mail Jay'));
    for (let i = 0; i < 5 && !b._pending.size; i++) await tick();
    await b.handleUpdate({ callback_query: { id: 'q', from: { id: 999 }, data: tg.sent().find((m) => m.reply_markup).reply_markup.inline_keyboard[0][0].callback_data, message: { chat: { id: FRED }, message_id: 100 } } });
    await b.idle();
    assert.strictEqual(result(), false);
  });

  console.log('Voice replies and Hannibal starting the conversation');
  await test('a voice note gets a text AND a voice-note reply; typed text gets text only', async () => {
    const tg = fakeTelegram();
    const spoken = [];
    const b = createTelegramBridge({ token: 't', allowedIds: String(FRED), fetchImpl: tg.fetchImpl, log: () => {},
      transcribe: async () => 'how is my day',
      speak: async (txt) => { spoken.push(txt); return Buffer.from('OGG'); },
      chat: async () => ({ ok: true, text: 'Two meetings.' }) });
    await b.handleUpdate(msg(undefined, FRED, { voice: { file_id: 'v1' } }));
    await b.idle();
    assert.deepStrictEqual(spoken, ['Two meetings.']);
    const v = tg.calls.find((c) => c.method === 'sendVoice');
    assert(v && v.body.form instanceof FormData && v.body.form.get('chat_id') === String(FRED));
    await b.handleUpdate(msg('and tomorrow?'));
    await b.idle();
    assert.strictEqual(spoken.length, 1, 'typed message → no voice note');
  });
  await test('/voice on makes every reply a voice note; /voice off stops it', async () => {
    const tg = fakeTelegram();
    let n = 0;
    const b = createTelegramBridge({ token: 't', allowedIds: String(FRED), fetchImpl: tg.fetchImpl, log: () => {},
      speak: async () => { n++; return Buffer.from('OGG'); }, chat: async () => ({ ok: true, text: 'ok' }) });
    await b.handleUpdate(msg('/voice on')); await b.idle();
    await b.handleUpdate(msg('hi')); await b.idle();
    assert.strictEqual(n, 1);
    await b.handleUpdate(msg('/voice off')); await b.idle();
    await b.handleUpdate(msg('hi')); await b.idle();
    assert.strictEqual(n, 1);
  });
  await test('a failing voice never breaks the text reply', async () => {
    const tg = fakeTelegram();
    const b = createTelegramBridge({ token: 't', allowedIds: String(FRED), fetchImpl: tg.fetchImpl, log: () => {},
      transcribe: async () => 'x', speak: async () => { throw new Error('ElevenLabs quota'); }, chat: async () => ({ ok: true, text: 'Still here.' }) });
    await b.handleUpdate(msg(undefined, FRED, { voice: { file_id: 'v1' } }));
    await b.idle();
    assert(tg.sent().some((m) => m.text === 'Still here.'));
  });
  await test('notify sends a reminder / brief to every allowed account (with voice when asked)', async () => {
    const tg = fakeTelegram();
    let n = 0;
    const b = createTelegramBridge({ token: 't', allowedIds: `${FRED},77`, fetchImpl: tg.fetchImpl, log: () => {},
      speak: async () => { n++; return Buffer.from('OGG'); }, chat: async () => ({ ok: true, text: '' }) });
    assert.strictEqual((await b.notify('x')).sent, 0, 'not running yet → nothing sent');
    b._setRunning(true);
    const r = await b.notify('⏰ Reminder: call Jay');
    assert.strictEqual(r.sent, 2);
    assert.deepStrictEqual(tg.sent().map((m) => String(m.chat_id)).sort(), ['4242', '77']);
    assert.strictEqual(n, 0);
    await b.notify('☀️ Morning brief', { voice: true });
    assert.strictEqual(n, 2);
  });

  await test('the desk hands its spoken brief and fired reminders to the phone', async () => {
    const { registerProactive } = require('./proactive');
    const handlers = {}; const out = [];
    const ipc = { handle: (ch, fn) => { handlers[ch] = fn; } };
    const tmp = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'hannibal-tg-'));
    const p = registerProactive(ipc, { statePath: require('path').join(tmp, 'p.json'), remindersPath: require('path').join(tmp, 'r.json'), getWindow: () => null, onBrief: (t) => out.push(['brief', t]), onReminder: (m) => out.push(['rem', m]) });
    p.stop();
    await handlers['proactive:done'](null, { kind: 'morning-brief', day: '2026-11-19', ok: true, text: 'Two meetings today.' });
    await handlers['proactive:done'](null, { kind: 'morning-brief', day: '2026-11-19', ok: false, text: 'x' });
    await handlers['reminders:fired'](null, 'call Jay');
    assert.deepStrictEqual(out, [['brief', 'Two meetings today.'], ['rem', 'call Jay']]);
  });

  console.log('Shared brain');
  await test('desk and phone turns run one at a time, each with its own tool runner', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    brain._setFactStore({ renderForPrompt: () => '' });
    const order = [];
    let n = 0;
    brain._setClient({ beta: { messages: { stream: () => {
      const me = ++n;
      order.push(`start${me}`);
      return { on: () => {}, finalMessage: async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push(`end${me}`);
        return { model: 'fake', usage: {}, stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
      } };
    } } } });
    brain.registerClaudeBrain({ handle: () => {} }, { runTool: async () => ({ tool: 'x', status: 'ok', content: '' }) });
    await Promise.all([brain.chat({ user: 'a' }, () => {}), brain.chat({ user: 'b' }, null, { runTool: async () => ({}) })]);
    assert.deepStrictEqual(order, ['start1', 'end1', 'start2', 'end2']);
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
