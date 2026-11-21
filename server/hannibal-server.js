// ─────────────────────────────────────────────────────────────────────────
// HANNIBAL SERVER — Hannibal without the Mac, always on (GEX131, Docker).
//
// The same pieces the desk app uses, minus everything that needs a Mac:
//   • Telegram: Fred's phone channel (one listener per bot, so the Mac's own
//     Telegram is switched off with HANNIBAL_SERVER_TELEGRAM=1 in its .env);
//   • Claude brain with saved facts (data/memory-facts.json) and the Qdrant
//     memory (same picky rules as the desk);
//   • tools that work from here: calendar, mail (read), web search/fetch,
//     world/news, server health, reminders, facts, memory. Mac-only tools (apps,
//     camera, screen, WhatsApp, sending mail through Mail.app) are not offered;
//   • the morning brief (HANNIBAL_BRIEF_TIME, default 08:00) and reminders,
//     pushed to the phone as text + a voice note;
//   • voice notes in: ElevenLabs speech-to-text. Voice out: ElevenLabs, as on the desk.
//
// Run:  node server/hannibal-server.js   (reads ../.env; see server/README.md)
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVICES = path.join(ROOT, 'electron', 'services');

// ── .env (same KEY=VALUE format as the desk) ──
(function loadEnv() {
  try {
    for (const line of fs.readFileSync(process.env.HANNIBAL_ENV || path.join(ROOT, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
  } catch (_) { /* env from Docker only */ }
})();

const CFG = {
  python: process.env.HANNIBAL_PY || 'python3',
  ffmpeg: process.env.HANNIBAL_FFMPEG || 'ffmpeg',
  ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  qdrantUrl: (process.env.QDRANT_URL || 'http://127.0.0.1:6333').replace(/\/+$/, ''),
  searxngUrl: process.env.SEARXNG_URL || 'http://127.0.0.1:8888',
  dataDir: process.env.HANNIBAL_DATA || path.join(ROOT, 'data'),
};
fs.mkdirSync(CFG.dataDir, { recursive: true });

// ── a stand-in for Electron's ipcMain: handlers register here, the executor
//    finds them through the tool tap exactly as it does in the desk app ──
const { installToolTap, setShim, makeIpcInvoker } = require(path.join(SERVICES, 'agent', 'executor'));
const catalog = require(path.join(SERVICES, 'agent', 'catalog'));
const { createBodyHub } = require('./body-hub');
const ipc = { handle() {} };
const registry = installToolTap(ipc);

const { registerInfo } = require(path.join(SERVICES, 'info-handlers'));
const { createFactStore, registerFacts } = require(path.join(SERVICES, 'memory-facts'));
const { createReminderTools, createBriefScheduler, cancelAcross } = require(path.join(SERVICES, 'proactive'));
const { createQdrantMemory } = require(path.join(SERVICES, 'qdrant-memory'));
const { createTelegramBridge, makeElevenLabsTranscriber, PHONE_CONTEXT } = require(path.join(SERVICES, 'telegram'));
const { registerWorld } = require(path.join(SERVICES, 'world'));
const claudeBrain = require(path.join(SERVICES, 'claude-brain'));
const claudeTools = require(path.join(SERVICES, 'claude-tools'));

const info = registerInfo(ipc, { python: CFG.python, searxngUrl: CFG.searxngUrl, metricsLocal: true });
registerWorld(ipc);   // views can't open here (no screen); the narrated read still works

const facts = createFactStore({ filePath: path.join(CFG.dataDir, 'memory-facts.json') });
claudeBrain._setFactStore(facts);
// The server's facts are the master copy: every change goes down to the Mac.
let hub = null;
const factsChanged = (r) => { if (r && r.ok && hub) hub.notify('facts', { facts: facts.all() }); return r; };
ipc.handle('facts:remember', (_e, text, category) => factsChanged(facts.remember(text, category)));
ipc.handle('facts:forget', (_e, query) => factsChanged(facts.forget(query)));
ipc.handle('facts:list', (_e, category) => facts.list(category));

// Conversation diary (phone + Telegram here). The server's copy is the master:
// the desk's episodes are merged in, and every new one goes down to the Mac.
const { createJournal, registerJournal } = require(path.join(SERVICES, 'conversation-journal'));
const journal = createJournal({
  filePath: path.join(CFG.dataDir, 'conversations.json'),
  summarize: (t, p) => claudeBrain.summarizeForJournal(t, p),
  onEpisode: (ep) => { if (hub) hub.notify('journal', { episodes: [ep] }); },
});
registerJournal(ipc, journal);
claudeBrain.setJournal(journal, { liveFile: path.join(CFG.dataDir, 'conversation-live.json'), whereName: process.env.HANNIBAL_WHERE || 'phone' });

const reminders = createReminderTools({ filePath: path.join(CFG.dataDir, 'reminders.json') });
ipc.handle('reminders:add', (_e, message, at) => reminders.add(message, at));
// Reminders set at the desk live on the Mac: when it is linked, both lists count.
async function macUpcoming() {
  if (!hub || !hub.linked()) return [];
  try { const mac = await hub.invoke('reminders.upcoming', {}, 15000); return (mac && Array.isArray(mac.reminders)) ? mac.reminders : []; }
  catch (_) { return []; }
}
ipc.handle('reminders:cancel', async (_e, query) => cancelAcross({
  local: reminders, query, remote: await macUpcoming(),
  cancelRemote: (id) => hub.invoke('reminders.cancel', { query: id }, 15000),
}));
ipc.handle('reminders:upcoming', async () => {
  const here = reminders.upcoming();
  const mac = await macUpcoming();
  return mac.length ? { ok: true, reminders: [...here.reminders, ...mac.map((r) => ({ ...r, set: 'at the desk' }))] } : here;
});

ipc.handle('reminders:recent', async (_e, hours) => {
  const here = reminders.recent(hours);
  if (!hub || !hub.linked()) return here;
  try {
    const mac = await hub.invoke('reminders.recent', { hours }, 15000);
    if (mac && mac.ok) {
      const tag = (x) => ({ ...x, set: 'at the desk' });
      return { ok: true, wentOff: [...here.wentOff, ...(mac.wentOff || []).map(tag)], missed: [...here.missed, ...(mac.missed || []).map(tag)] };
    }
  } catch (_) {}
  return here;
});

const memory = createQdrantMemory({ qdrantUrl: CFG.qdrantUrl, ollamaUrl: CFG.ollamaUrl });
setShim('memory.query', async ({ text, limit = 3 } = {}) =>
  ({ ok: true, results: await memory.search(String(text || ''), Math.min(Number(limit) || 3, 10)) }));
// Old memories saved cut off mid-sentence: trim them once, shortly after start.
setTimeout(() => { memory.repairCutReplies().catch(() => {}); }, 60 * 1000).unref();

// Only offer Claude the tools whose handlers exist: the server's own, plus the
// Mac's while it is linked.
const LOCAL_CHANNELS = Object.keys(registry);
const refreshTools = () => claudeTools.setAvailableChannels([...LOCAL_CHANNELS, ...(hub ? hub.channels() : [])]);
refreshTools();

const serverContext = () => (hub && hub.linked()
  ? 'You are running on Fred\'s always-on server. His Mac is awake and linked right now, so you can also use its tools '
    + '(apps, files, camera, screen, WhatsApp, music). Anything that changes something is confirmed on his phone first.'
  : 'You are running on Fred\'s always-on server. His Mac is asleep or off right now, so you can use his calendar, mail (read), '
    + 'the web, news, reminders and your memory, but not Mac apps, the camera, the screen or WhatsApp. If he asks for one '
    + 'of those, say it needs the Mac awake.');
const PERSONA = "You are Hannibal, Fred's personal AI assistant. Be concise, direct, and natural, "
  + 'with dry wit. Notes about the current situation arrive as system messages during the conversation.';

// ── voice out: ElevenLabs MP3 → OGG/Opus for a Telegram voice note ──
function run(cmd, args, stdinText) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: process.env });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `${path.basename(cmd)} exit ${code}`))));
    if (stdinText != null) { p.stdin.write(stdinText); p.stdin.end(); }
  });
}
async function voiceNote(text) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const mp3 = path.join(os.tmpdir(), `hannibal-vn-${stamp}.mp3`);
  const ogg = path.join(os.tmpdir(), `hannibal-vn-${stamp}.ogg`);
  try {
    await run(CFG.python, [path.join(SERVICES, 'nova-tts.py'), mp3], String(text || ''));
    await run(CFG.ffmpeg, ['-nostdin', '-y', '-loglevel', 'error', '-i', mp3, '-c:a', 'libopus', '-b:a', '48k', '-ac', '1', ogg], null);
    return fs.readFileSync(ogg);
  } finally { fs.unlink(mp3, () => {}); fs.unlink(ogg, () => {}); }
}

// Hannibal's voice as MP3 (the phone app plays it straight in the browser).
async function voiceMp3(text) {
  const mp3 = path.join(os.tmpdir(), `hannibal-app-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`);
  try { await run(CFG.python, [path.join(SERVICES, 'nova-tts.py'), mp3], String(text || '')); return fs.readFileSync(mp3); }
  finally { fs.unlink(mp3, () => {}); }
}

// A tool runs here if the server has it, otherwise on the linked Mac. The
// confirmation gate has already asked Fred (on his phone) before invoke runs.
const localInvoke = makeIpcInvoker(registry);
function invoke(toolName, params) {
  const tool = catalog.getTool(toolName);
  const via = (tool && tool.via) || {};
  if (via.module || registry[via.channel] || !hub || !hub.linked()) return localInvoke(toolName, params);
  return hub.invoke(toolName, params || {});
}
const runTool = (name, input, { confirmer } = {}) => claudeTools.runTool(name, input, {
  confirmer, invoke,
  emit: (ev) => { if (/^step:(start|finish|error|skipped|confirm)/.test(ev.type)) console.log('[tool]', ev.type, ev.tool || ''); },
});

const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
if (!token) { console.error('[server] TELEGRAM_BOT_TOKEN missing in .env, nothing to do'); process.exit(1); }

const telegram = createTelegramBridge({
  token,
  allowedIds: process.env.TELEGRAM_ALLOWED_USERS,
  persona: PERSONA,
  chat: (payload, onText, opts) => claudeBrain.chat(
    { ...payload, context: [serverContext(), payload.context].filter(Boolean).join('\n\n') }, onText, opts),
  runTool,
  transcribe: makeElevenLabsTranscriber({ apiKey: process.env.ELEVENLABS_API_KEY, model: process.env.ELEVENLABS_STT_MODEL || 'scribe_v1' }),
  memory,
  speak: voiceNote,
  voiceAlways: process.env.TELEGRAM_VOICE_ALWAYS,
  onReset: () => claudeBrain.resetHistory(),
});

// ── the phone app (private web app over Tailscale) ──
let phoneApp = null;
if (process.env.PHONE_APP_TOKEN) {
  try {
    const { createPhoneApp } = require('./phone-app');
    phoneApp = createPhoneApp({
      token: process.env.PHONE_APP_TOKEN,
      // Tailscale only (+ localhost for `tailscale serve` https). Never the public address.
      hosts: ['127.0.0.1', process.env.BODY_LINK_HOST || '100.99.70.113'],
      port: Number(process.env.PHONE_APP_PORT || 8791),
      persona: PERSONA,
      chat: (payload, onText, opts) => claudeBrain.chat(
        { ...payload, context: [serverContext(), payload.context].filter(Boolean).join('\n\n') }, onText, opts),
      runTool,
      transcribe: makeElevenLabsTranscriber({ apiKey: process.env.ELEVENLABS_API_KEY, model: process.env.ELEVENLABS_STT_MODEL || 'scribe_v1' }),
      speak: voiceMp3,
      memory,
      status: () => ({ mac: !!(hub && hub.linked()) }),
      onReset: () => claudeBrain.resetHistory(),
    });
    phoneApp.start();
  } catch (e) { console.warn('[phone] app disabled:', e.message); phoneApp = null; }
} else console.log('[phone] PHONE_APP_TOKEN not set: no phone app');
// Things Hannibal tells Fred go to Telegram and, if it is open, the app.
const tellFred = async (text, { voice = false } = {}) => {
  if (phoneApp) phoneApp.notify(text);
  return telegram.notify(text, { voice });
};

// ── morning brief: Claude reads calendar/mail/reminders, Fred gets it on the phone ──
const brief = createBriefScheduler({
  statePath: path.join(CFG.dataDir, 'proactive.json'),
  send: async (job) => {
    console.log('[brief] composing the morning brief');
    let ok = false;
    try {
      const r = await claudeBrain.chat({
        system: PERSONA,
        context: [serverContext(), PHONE_CONTEXT, 'This brief is sent to his phone as text and a voice note.'].join('\n\n'),
        user: job.prompt,
      }, null, { runTool: (name, input) => runTool(name, input, { confirmer: async () => false }) });  // read-only: any write is declined
      if (r && r.ok && r.text) {
        await tellFred(`☀️ Morning brief\n\n${r.text}`, { voice: true });
        ok = true;
      } else console.warn('[brief] no brief:', (r && r.error) || 'empty');
    } catch (e) { console.warn('[brief] failed:', e.message); }
    brief.done({ kind: job.kind, day: job.day, ok });
  },
});

// ── the Mac's link (when it is awake) ──
if (process.env.BODY_LINK_TOKEN) {
  try {
    hub = createBodyHub({
      host: process.env.BODY_LINK_HOST || '100.99.70.113',
      port: Number(process.env.BODY_LINK_PORT || 8790),
      token: process.env.BODY_LINK_TOKEN,
      WebSocketServer: require('ws').WebSocketServer,
      onLink: (b) => { refreshTools(); console.log(`[body] Mac tools available: ${b.channels.size} channels, ${claudeTools.toolDefinitions().length} tools in total`); },
      onUnlink: () => refreshTools(),
      methods: {
        // The Mac's facts on (re)link: anything new is added here, then both use this list.
        // Reconcile the desk's facts after a time apart, against the list both
        // last agreed on (lastSynced): what the desk added since is added here,
        // what the desk deleted since is deleted here, and what was deleted here
        // (on the phone) is not brought back. No lastSynced (first link): add all.
        'facts.sync': ({ facts: deskList, lastSynced } = {}) => {
          const key = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
          const desk = Array.isArray(deskList) ? deskList : [];
          const base = Array.isArray(lastSynced) ? new Set(lastSynced.map((f) => key(f.text))) : null;
          const deskKeys = new Set(desk.map((f) => key(f.text)));
          let added = 0; let removed = 0;
          for (const f of desk) {
            if (base && base.has(key(f.text))) continue;          // known before: not new
            const r = facts.remember(f.text, f.category);
            if (r.ok && !r.duplicate) added += 1;
          }
          if (base) {
            for (const k of base) {
              if (deskKeys.has(k)) continue;                       // still on the desk
              const gone = facts.all().find((f) => key(f.text) === k);
              if (gone && facts.forget(gone.id).ok) removed += 1;
            }
          }
          if (added || removed) console.log(`[body] facts from the desk: ${added} added, ${removed} removed`);
          return { facts: facts.all() };
        },
        'facts.remember': ({ text, category } = {}) => ({ result: factsChanged(facts.remember(text, category)), facts: facts.all() }),
        'facts.forget': ({ query } = {}) => ({ result: factsChanged(facts.forget(query)), facts: facts.all() }),
        // Diary: the desk's episodes are merged in; the desk gets them all back.
        'journal.sync': ({ episodes } = {}) => {
          const got = journal.merge(episodes);
          if (got) console.log(`[body] diary: ${got} conversations from the desk`);
          return { episodes: journal.all() };
        },
        'journal.add': ({ episodes } = {}) => { journal.merge(episodes); return { ok: true }; },
        // Nudges: which ones were already said, on either side.
        'nudge.said': ({ keys } = {}) => ({ added: nudger.markSaid(keys) }),
        'nudge.sync': ({ keys } = {}) => { nudger.markSaid(keys); return { keys: nudger.said() }; },
        // The desk sends something to Fred's phone (a reminder that fired there).
        'phone.notify': async ({ text, voice } = {}) => { await tellFred(String(text || ''), { voice: !!voice }); return { ok: true }; },
      },
    });
  } catch (e) { console.warn('[body] link disabled:', e.message); hub = null; }
} else console.log('[body] BODY_LINK_TOKEN not set: the Mac cannot link (server-only tools)');

// ── reminders → phone ──
async function fireReminders() {
  let due = [];
  try { due = reminders.takeDue(); } catch (e) { console.warn('[reminders] check failed:', e.message); }
  for (const r of due) {
    console.log('[reminders] due:', r.message);
    try {
      await tellFred(`⏰ Reminder: ${r.message}`, { voice: true });
      reminders.markDelivered(r.id, true);
    } catch (e) {
      console.warn('[reminders] send failed:', e.message);
      reminders.markDelivered(r.id, false, e.message);   // so "did it go off?" gets an honest no
    }
  }
}

// ── start, retrying while the network or Telegram is not reachable ──
let delay = 5000;
function startTelegram() {
  telegram.start().then(() => console.log('[server] Telegram connected')).catch((e) => {
    console.warn(`[telegram] could not start: ${e.message}, retrying in ${delay / 1000}s`);
    setTimeout(startTelegram, delay);
    delay = Math.min(delay * 2, 300000);
  });
}
startTelegram();

// Send the phone app link to Telegram once per address (deploy writes data/phone-url.txt).
function sendPhoneLinkOnce() {
  if (!phoneApp) return;
  const urlFile = path.join(CFG.dataDir, 'phone-url.txt');
  const sentFile = path.join(CFG.dataDir, 'phone-url.sent');
  let url = '';
  try { url = fs.readFileSync(urlFile, 'utf8').trim(); } catch (_) { return; }
  let sent = '';
  try { sent = fs.readFileSync(sentFile, 'utf8').trim(); } catch (_) {}
  if (!url || url === sent) return;
  const link = `${url}/?k=${process.env.PHONE_APP_TOKEN}`;
  const https = url.startsWith('https://');
  telegram.notify(`📱 Your Hannibal app: ${link}\n\nOpen it on your phone (Tailscale on), then Share → Add to Home Screen.`
    + (https ? '' : '\n\nTalking needs the https address; for now you can type.'))
    .then((r) => { if (r && r.ok) fs.writeFileSync(sentFile, url); })
    .catch(() => {});
}
// NUDGES while the Mac is away: the same checks as the desk, sent to the phone
// as a short text. While the Mac is linked the desk speaks them instead; the
// two share which ones were already said (nudge.said / nudge.sync).
const { createNudger, knownPeople } = require(path.join(SERVICES, 'nudges'));
const nudger = createNudger({
  statePath: path.join(CFG.dataDir, 'nudges.json'),
  getEvents: () => info.calendar(8),
  getMail: () => info.waitingMail(48, 7),
  isKnown: (m) => knownPeople(facts.all().map((f) => f.text).join('\n'))(m),
  deliver: async (n) => {
    if (hub && hub.linked()) return false;          // the desk has it
    try { await tellFred(`👋 ${n.text}`); return true; } catch (_) { return false; }
  },
});

const timers = [
  setInterval(() => { if (!(hub && hub.linked())) nudger.tick().catch((e) => console.warn('[nudge] tick failed:', e.message)); }, 60000),
  // Checked a few times: the deploy may switch the link to https a little
  // after start-up; a changed link is sent again, an unchanged one is not.
  ...[20, 60, 180].map((s) => setTimeout(sendPhoneLinkOnce, s * 1000)),
  setTimeout(() => brief.tick(), 30000),
  setInterval(() => brief.tick(), 60000),
  setInterval(fireReminders, 30000),
];
console.log(`[server] Hannibal server up: ${claudeTools.toolDefinitions().length} tools, ${facts.size} facts, TZ ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);

function shutdown(sig) {
  console.log(`[server] ${sig}, stopping`);
  for (const t of timers) { clearTimeout(t); clearInterval(t); }
  try { telegram.stop(); } catch (_) {}
  try { hub && hub.close(); } catch (_) {}
  try { phoneApp && phoneApp.stop(); } catch (_) {}
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => console.warn('[server] unhandled:', e && e.message ? e.message : e));
