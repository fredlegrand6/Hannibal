// ─────────────────────────────────────────────────────────────────────────
// TELEGRAM — Hannibal in Fred's pocket.
//
// A private Telegram bot that talks to the SAME brain as the desk: same
// Claude, same tools, same saved facts, same conversation. Fred can:
//   • type a message                → Hannibal answers in text;
//   • send a voice note             → transcribed by the local whisper-server;
//   • send a photo (with a caption) → Claude looks at it.
// A voice note gets a voice note back, in Hannibal's own (ElevenLabs) voice.
// Reminders and the morning brief arrive here too (notify).
//
// Safety:
//   • Only the Telegram accounts in TELEGRAM_ALLOWED_USERS are answered.
//     Anyone else gets "not authorised" plus their numeric id (that's how Fred
//     finds his own id the first time) and nothing else.
//   • Actions that change something (mail, messages, trash…) still go through
//     the confirmation gate — here as Yes / No buttons on the phone. No answer
//     within 2 minutes means NO.
//
// No webhook, no open port: the Mac long-polls Telegram over HTTPS, so it works
// from behind any router. It runs while Hannibal runs on the Mac.
//
// .env:  TELEGRAM_BOT_TOKEN=...        (from @BotFather — never commit it)
//        TELEGRAM_ALLOWED_USERS=12345  (comma-separated numeric ids)
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const MAX_MSG = 4000;
const MAX_SPOKEN = 1500;            // longer replies are spoken only up to here (text has it all)                 // Telegram's limit is 4096
const CONFIRM_TIMEOUT_MS = 120000;

const PHONE_CONTEXT =
  'Fred is messaging you on Telegram from his phone, not speaking at the desk. '
  + 'Your reply is read, not spoken: plain text, short paragraphs, no markdown tables. '
  + 'Actions that change something are confirmed with Yes/No buttons on his phone.';

function parseIds(s) {
  return new Set(String(s || '').split(/[\s,;]+/).map((x) => x.trim()).filter((x) => /^-?\d+$/.test(x)));
}

function splitMessage(text, max = MAX_MSG) {
  const out = [];
  let rest = String(text || '').trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// A typed answer counts only when it is JUST yes or no ("yes but wait" is neither).
const YES = /^(yes|y|ja|jep|yep|oui|ok|okay|go|go ahead|do it|doe maar|sure)[\s.!👍]*$/i;
const NO = /^(no|n|nee|non|nope|stop|cancel|don'?t)[\s.!]*$/i;

// opts:
//   token, allowedIds (Set|string), persona (string),
//   chat(payload, onText, { runTool }) -> { ok, text, error }
//   runTool(apiName, input, { confirmer }) -> result   (claude-tools.runTool)
//   transcribe(oggBuffer) -> string                     (voice notes)
//   memory { recall(text) -> string, store(text, meta) } (Qdrant, optional)
//   speak(text) -> OGG/Opus Buffer  (voice-note replies in Hannibal's voice, optional)
//   voiceAlways  (true → every reply also as a voice note; /voice toggles it)
//   fetchImpl, log, pollTimeoutS
function createTelegramBridge(opts = {}) {
  const token = opts.token;
  const allowed = opts.allowedIds instanceof Set ? opts.allowedIds : parseIds(opts.allowedIds);
  const fetchImpl = opts.fetchImpl || fetch;
  const log = opts.log || ((...a) => console.log('[telegram]', ...a));
  const pollTimeoutS = opts.pollTimeoutS == null ? 50 : opts.pollTimeoutS;
  const api = `https://api.telegram.org/bot${token}`;
  const fileApi = `https://api.telegram.org/file/bot${token}`;

  let running = false;
  let offset = 0;
  let queue = Promise.resolve();
  const pendingConfirms = new Map();   // chatId -> { resolve, timer, messageId }
  const warnedStrangers = new Set();
  let confirmSeq = 0;
  let voiceAlways = /^(1|on|true|yes|always)$/i.test(String(opts.voiceAlways || ''));

  async function call(method, body) {
    const r = await fetchImpl(`${api}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`${method}: ${j.description || r.status}`);
    return j.result;
  }

  async function send(chatId, text, extra = {}) {
    let last = null;
    for (const part of splitMessage(text)) last = await call('sendMessage', { chat_id: chatId, text: part, ...extra });
    return last;
  }

  // Voice note (OGG/Opus) as a multipart upload.
  async function sendVoice(chatId, ogg) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('voice', new Blob([ogg], { type: 'audio/ogg' }), 'hannibal.ogg');
    const r = await fetchImpl(`${api}/sendVoice`, { method: 'POST', body: form });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`sendVoice: ${j.description || r.status}`);
    return j.result;
  }
  // Speak a reply as a voice note too (Hannibal's own voice). Never fails the turn.
  async function sendSpoken(chatId, text) {
    if (!opts.speak || !text) return false;
    try {
      call('sendChatAction', { chat_id: chatId, action: 'record_voice' }).catch(() => {});
      const ogg = await opts.speak(String(text).slice(0, MAX_SPOKEN));
      if (!ogg || !ogg.length) return false;
      await sendVoice(chatId, ogg);
      return true;
    } catch (e) { log('voice reply failed:', e.message); return false; }
  }

  // Hannibal starts the conversation (reminders, morning brief) — to every allowed account.
  async function notify(text, { voice = false } = {}) {
    if (!running || !text) return { ok: false, sent: 0 };
    let sent = 0;
    for (const id of allowed) {
      try {
        await send(id, text);
        if (voice || voiceAlways) await sendSpoken(id, text);
        sent++;
      } catch (e) { log(`notify ${id} failed:`, e.message); }
    }
    return { ok: sent > 0, sent };
  }

  async function download(fileId) {
    const f = await call('getFile', { file_id: fileId });
    const r = await fetchImpl(`${fileApi}/${f.file_path}`);
    if (!r.ok) throw new Error(`download failed: ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }

  // Ask Fred on the phone. Resolves true only on an explicit yes.
  function makeConfirmer(chatId) {
    return (_step, summary) => new Promise((resolve) => {
      const prev = pendingConfirms.get(chatId);
      if (prev) { clearTimeout(prev.timer); prev.resolve(false); }
      // Each prompt's buttons carry their own token, so a late tap on an old
      // prompt can never approve a newer action.
      const entry = { resolve: null, timer: null, messageId: null, token: `c${++confirmSeq}_${Date.now().toString(36)}` };
      const finish = (ok, note) => {
        if (pendingConfirms.get(chatId) !== entry) return;
        pendingConfirms.delete(chatId);
        clearTimeout(entry.timer);
        if (entry.messageId) {
          call('editMessageReplyMarkup', { chat_id: chatId, message_id: entry.messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
        }
        if (note) send(chatId, note).catch(() => {});
        resolve(ok);
      };
      entry.resolve = (ok) => finish(ok, ok ? '✓ Going ahead.' : '✗ Not done.');
      entry.timer = setTimeout(() => finish(false, '✗ No answer in 2 minutes, so I did not do it.'), opts.confirmTimeoutMs || CONFIRM_TIMEOUT_MS);
      pendingConfirms.set(chatId, entry);
      send(chatId, `${summary}\n\nShall I go ahead?`, {
        reply_markup: { inline_keyboard: [[{ text: 'Yes', callback_data: `yes:${entry.token}` }, { text: 'No', callback_data: `no:${entry.token}` }]] },
      }).then((m) => { entry.messageId = m && m.message_id; })
        .catch((e) => { log('confirm send failed:', e.message); finish(false); });
    });
  }

  async function handleMessage(msg) {
    const chatId = msg.chat.id;
    let text = (msg.text || msg.caption || '').trim();
    let images = [];

    if (text === '/start' || text === '/help') {
      await send(chatId, 'Hannibal here. Type, send a voice note, or a photo. I answer from your Mac while Hannibal is running there.');
      return;
    }
    if (text === '/reset') { await send(chatId, 'Fine — fresh start.'); opts.onReset && opts.onReset(); return; }
    if (/^\/voice\b/.test(text)) {
      const arg = text.split(/\s+/)[1] || '';
      voiceAlways = arg ? /^(on|always|1)$/i.test(arg) : !voiceAlways;
      await send(chatId, voiceAlways ? '🔊 I\'ll answer with a voice note every time. (/voice off to stop)'
        : '🔈 Voice notes only when you send me one. (/voice on for always)');
      return;
    }

    call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    const voice = msg.voice || msg.audio;
    const spokenTo = !!voice;
    if (voice) {
      if (!opts.transcribe) { await send(chatId, "I can't listen to voice notes right now — type it instead?"); return; }
      try {
        const heard = String(await opts.transcribe(await download(voice.file_id)) || '').trim();
        if (!heard) { await send(chatId, "I couldn't make out that voice note. Try again or type it?"); return; }
        text = text ? `${heard}\n\n${text}` : heard;
        await send(chatId, `🎙 “${heard}”`);
      } catch (e) {
        log('voice note failed:', e.message);
        await send(chatId, /speaker not recognized/i.test(e.message)
          ? "That voice didn't match yours (the speaker check), so I ignored it. Type it instead?"
          : "Something went wrong reading that voice note. Type it instead?");
        return;
      }
    }
    if (Array.isArray(msg.photo) && msg.photo.length) {
      const biggest = msg.photo.slice().sort((a, b) => (b.file_size || 0) - (a.file_size || 0))[0];
      try { images = [(await download(biggest.file_id)).toString('base64')]; }
      catch (e) { log('photo download failed:', e.message); }
      if (!text) text = 'What do you see in this photo?';
    }
    if (!text) { await send(chatId, 'I can read text, voice notes and photos.'); return; }

    const typing = setInterval(() => call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}), 4500);
    try {
      const confirmer = makeConfirmer(chatId);
      // Long-term memory (Qdrant), same as at the desk: recall before, store after.
      let memories = '';
      if (opts.memory) { try { memories = await opts.memory.recall(text); } catch (_) {} }
      const r = await opts.chat(
        { system: opts.persona || 'You are Hannibal, Fred\'s personal AI assistant.',
          context: [PHONE_CONTEXT, memories].filter(Boolean).join('\n\n'), user: text, images },
        null,
        { runTool: opts.runTool ? (name, input) => opts.runTool(name, input, { confirmer }) : undefined },
      );
      if (r && r.ok && r.text) {
        await send(chatId, r.text);
        if (spokenTo || voiceAlways) await sendSpoken(chatId, r.text);
        if (opts.memory) {
          opts.memory.store(`Fred said (Telegram): ${text}\nHannibal replied: ${r.text.slice(0, 500)}`, { type: 'conversation', channel: 'telegram' }).catch(() => {});
        }
      }
      else if (r && r.toolsUsed && r.toolsUsed.length) await send(chatId, `I ran ${r.toolsUsed.map((t) => t.tool).join(', ')} but then lost the connection to my brain. Check before asking again.`);
      else await send(chatId, `I can't think right now: ${(r && r.error) || 'no answer'}.`);
    } finally { clearInterval(typing); }
  }

  async function handleUpdate(u) {
    if (u.callback_query) {
      const q = u.callback_query;
      if (!allowed.has(String(q.from && q.from.id))) return;
      call('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
      const [answer, tok] = String(q.data || '').split(':');
      const p = pendingConfirms.get(q.message && q.message.chat.id);
      if (p && tok && tok === p.token) p.resolve(answer === 'yes');
      return;
    }
    const msg = u.message;
    if (!msg || !msg.chat) return;
    const from = String(msg.from && msg.from.id);
    if (!allowed.has(from)) {
      log(`ignored message from unknown user ${from}`);
      if (msg.chat.type === 'private' && !warnedStrangers.has(from)) {
        warnedStrangers.add(from);
        await send(msg.chat.id, `Not authorised. Your Telegram id is ${from}.`).catch(() => {});
      }
      return;
    }
    // Private chats only: in a group, replies (mail, calendar, facts) would be
    // seen by people who are not Fred.
    if (msg.chat.type !== 'private') {
      log(`ignored ${msg.chat.type} chat ${msg.chat.id} — Hannibal only answers in a private chat`);
      return;
    }
    // A plain yes/no while a confirmation is waiting answers it (no new turn).
    const p = pendingConfirms.get(msg.chat.id);
    if (p && msg.text) {
      if (YES.test(msg.text.trim())) { p.resolve(true); return; }
      if (NO.test(msg.text.trim())) { p.resolve(false); return; }
    }
    // Turns run one after another; the poll loop keeps going so button taps
    // for a waiting confirmation still arrive.
    queue = queue.then(() => handleMessage(msg)).catch(async (e) => {
      log('message failed:', e.message);
      await send(msg.chat.id, `Sorry — that failed: ${e.message}`).catch(() => {});
    });
  }

  async function pollOnce() {
    const updates = await call('getUpdates', { offset, timeout: pollTimeoutS, allowed_updates: ['message', 'callback_query'] });
    for (const u of updates || []) {
      offset = Math.max(offset, u.update_id + 1);
      try { await handleUpdate(u); } catch (e) { log('update failed:', e.message); }
    }
    return (updates || []).length;
  }

  async function loop() {
    let backoff = 1000;
    while (running) {
      try { await pollOnce(); backoff = 1000; }
      catch (e) {
        if (!running) break;
        log('poll error:', e.message, `— retrying in ${backoff / 1000}s`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60000);
      }
    }
  }

  async function start() {
    if (running) return;
    const me = await call('getMe');
    log(`connected as @${me.username}; answering ${allowed.size} account(s)`);
    if (!allowed.size) log('TELEGRAM_ALLOWED_USERS is empty — message the bot once to get your id, then add it to .env');
    running = true;
    loop();
  }
  function stop() {
    running = false;
    for (const [, p] of pendingConfirms) p.resolve(false);
  }

  return { start, stop, notify, pollOnce, handleUpdate, idle: () => queue, makeConfirmer, _pending: pendingConfirms,
    _setRunning: (v) => { running = v; } };
}

// Voice note → the local whisper-server (it converts any audio with ffmpeg,
// runs its noise filter and Fred's speaker check, then Whisper). 'auto' lets
// Whisper detect English / Dutch / French by itself.
function makeWhisperTranscriber({ whisperUrl, language = 'auto', fetchImpl = fetch }) {
  return async (audio) => {
    const r = await fetchImpl(`${whisperUrl}/transcribe?language=${encodeURIComponent(language)}`, { method: 'POST', body: audio });
    const j = await r.json().catch(() => ({}));
    if (j && j.transcript) return j.transcript;
    if (j && j.error && !/no speech/i.test(j.error)) throw new Error(j.error);
    return '';
  };
}

module.exports = { createTelegramBridge, makeWhisperTranscriber, splitMessage, parseIds, PHONE_CONTEXT };
