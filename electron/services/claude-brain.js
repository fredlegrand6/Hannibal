// ─────────────────────────────────────────────────────────────────────────
// Claude chat brain (main process).
//
// The renderer asks for a chat turn over IPC ('llm:chat'); we stream Claude's
// reply back token by token ('llm:token') so speech can start on the first
// sentence. The API key stays in this process — it never reaches the renderer.
//
// Prompt caching: the request is laid out so everything already sent stays
// byte-identical from turn to turn —
//   system   = the fixed persona (never changes)
//   messages = an append-only conversation; each turn adds the user's words,
//              a system note with that moment's context (time, mood, memories),
//              and Claude's reply.
// The top-level cache_control marker then lets each new turn re-read the whole
// earlier conversation from cache instead of paying for it again. (Claude only
// caches once the prefix is ~512 tokens, so the first few short turns show 0.)
//
// If anything fails (no key, no internet, API error, refusal) we return
// { ok:false } and the renderer falls back to Ollama on GEX131.
// ─────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const claudeTools = require('./claude-tools');
const { getDefaultFactStore } = require('./memory-facts');

// Read lazily: main.js loads .env after this module is required.
const model = () => process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const effort = () => process.env.CLAUDE_EFFORT || 'low';   // spoken chat: answer fast
const maxTokens = () => parseInt(process.env.CLAUDE_MAX_TOKENS || '16000', 10);
const HISTORY_MAX = 60;    // turns kept (user+note+reply = 3 entries per turn)
const HISTORY_KEEP = 30;   // trim down to this in one go, so the cache prefix only resets occasionally

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ maxRetries: 1, timeout: 60_000 }); // reads ANTHROPIC_API_KEY
  return client;
}
const enabled = () => !!process.env.ANTHROPIC_API_KEY && !/^(0|false|off|no)$/i.test(process.env.HANNIBAL_CLAUDE || '');

// Append-only conversation. Assistant turns are stored as plain text (thinking
// blocks are not replayed), which the API allows and keeps trimming safe.
let history = [];

function describeError(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'Claude API key rejected';
  if (e instanceof Anthropic.PermissionDeniedError) return 'Claude API key lacks permission';
  if (e instanceof Anthropic.RateLimitError) return 'Claude rate limit reached';
  if (e instanceof Anthropic.APIConnectionError) return 'cannot reach the Claude API';
  if (e instanceof Anthropic.APIError) return `Claude API error ${e.status || ''}: ${e.message}`.trim();
  return (e && e.message) || String(e);
}

// Spoken guidance for using the tools. Static text, so it stays in the cache.
const TOOL_GUIDE = `

You can act, not just talk: the tools let you read Fred's mail and calendar, search the web, work with files, apps, the browser, music, the camera and his Mac. When Fred asks for something done, or for information a tool can get, use the tools instead of guessing — never invent results.
Reads run immediately. Anything that sends, deletes or changes something is confirmed with Fred by voice automatically before it runs, so do NOT ask him for permission yourself first — just call the tool and the confirmation step asks him. If he declines, accept it and don't retry.
Check your own work: never tell Fred something is done unless the tool result says ok. Changes come back with "verified": true when the result was read back and confirmed. If it says verified false, or the result is unclear, say plainly that it may not have worked and look again with a read tool (calendar.events, reminders.upcoming) before saying anything more. When Fred asks whether a reminder went off, check reminders.recent instead of guessing.
Believe Fred about what happened: when he says something already went out or already happened, take his word, say "OK, then it went through" or check with a read tool, and never tell him he is wrong because a lookup came up empty. Some things run outside this chat (they are listed as "Done outside this chat"), so "I have no record of it" is not proof it didn't happen. An empty contacts.find means you could not find the person, not that the person doesn't exist.
Your speech-to-text is already locked to English, Dutch, French and Spanish (done 21 Nov 2026), so that item is finished: don't list it as a wish any more. When a yes/no tool result says Fred's answer wasn't heard, don't call it declined: say you didn't catch it and ask again. Fred talks to you through speech-to-text, which sometimes mishears (a name as a weekday, the TV as words). When a short answer only makes sense as the reply to the question you just asked, take it that way (after "how is Mandy saved?", "Monday" means "Mandy") and carry on, saying briefly what you understood. Ignore lines that are clearly background noise.
Eyes: you can see. If Fred asks about anything you'd have to look at — himself, what he's holding or wearing, the room, something he shows you, his screen — call vision__capture (kind "camera", or "screen") and look before answering. Never guess what you can't see; if the image is unclear, say what you can make out and ask him to hold it closer.
Memory: the saved facts below are things you know for sure. When Fred tells you something lasting — about a person, a project or client, how he likes things done, a decision, a place, a routine — save it with memory__remember as one short self-contained fact (do it quietly, no need to announce it unless he asked you to remember). If a saved fact is wrong or outdated, forget it and save the correct one. When he says "forget that", use memory__forget. Don't save small talk, passing moods or things that only matter right now.
Conversations: your diary of recent conversations with Fred (desk and phone) is below. Use it to follow the thread: pick up where you left off, remember what you promised, and don't make him repeat himself. It is history: what is still open or already closed is in THREADS. For older conversations search with memory__conversations (it finds them by meaning, not only by exact words).
Threads: the THREADS list below has the CURRENT status of each thing you and Fred are working on. Reason from it, not from older diary lines or memories: never suggest redoing, testing or chasing something listed as done or dropped. The moment Fred says something is done, fixed, tested, cancelled, to forget, for later, or waiting on someone, call memory__thread with that thread and the new status (his word wins, no proof needed). Asked what was said or decided about something, call memory__threads and answer with its current status and the key steps, not raw quotes.
You are spoken aloud: before a slow or multi-step task say one short sentence about what you're doing, and when done give the result in one or two plain sentences (no lists, no markdown).`;

function nowStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${d.toLocaleDateString('en-GB', { weekday: 'long' })} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())} (${tz})`;
}
let factStore = getDefaultFactStore;

// ── Conversation memory (conversation-journal.js). Off until setJournal() is
// called (main.js on the Mac, hannibal-server.js on the server), so tests never
// touch real files.
//   • every exchange is noted in the journal; after a quiet spell it becomes a
//     summarized episode that rides in the system prompt (and syncs to the
//     other side);
//   • the running conversation is saved too, so a restart resumes mid-thread;
//     after a long break (RESUME_MS) a fresh conversation starts and the
//     diary carries what came before.
let journal = null;
let threads = null;      // threads.js: each thing being worked on, with its current status
let livePath = null;
let where = () => process.env.HANNIBAL_WHERE || 'desk';
const RESUME_MS = () => parseInt(process.env.HANNIBAL_RESUME_HOURS || '6', 10) * 3600 * 1000;
let lastTurnAt = 0;
let journalTimer = null;

function saveLive() {
  if (!livePath) return;
  try {
    const tmp = `${livePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: lastTurnAt, history }));
    fs.renameSync(tmp, livePath);
  } catch (e) { console.warn('[claude] could not save the conversation:', e.message); }
}
function loadLive() {
  if (!livePath) return;
  try {
    const j = JSON.parse(fs.readFileSync(livePath, 'utf8'));
    if (Array.isArray(j.history) && j.savedAt && Date.now() - j.savedAt < RESUME_MS()) {
      history = j.history; lastTurnAt = j.savedAt;
      console.log(`[claude] picked up the conversation where it stopped (${Math.round(history.length / 3)} turns)`);
    }
  } catch (_) {}
}
function closeEpisode() {
  if (!journal) return Promise.resolve(null);
  return journal.close().then((ep) => {
    // Then map that stretch onto the threads (by meaning; statuses move on).
    if (ep && threads && journal.lastTranscript) {
      threads.reconcile({ transcript: journal.lastTranscript, summarize: summarizeForJournal })
        .then((r) => { if (r && r.ok && r.updated.length) console.log(`[threads] after the conversation: ${r.updated.join('; ')}`); })
        .catch(() => {});
    }
    return ep;
  }).catch((e) => { console.warn('[journal] close failed:', e && e.message); return null; });
}
function setThreads(store) { threads = store || null; }
// Write the diary for a finished stretch: one plain Claude call, JSON back.
async function summarizeForJournal(transcriptText, instructions) {
  const msg = await getClient().beta.messages.create({
    model: process.env.HANNIBAL_JOURNAL_MODEL || model(),
    max_tokens: 2000,
    output_config: { effort: 'low' },
    system: instructions,
    messages: [{ role: 'user', content: transcriptText }],
  });
  return (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}
function setJournal(j, { liveFile, whereName } = {}) {
  journal = j || null;
  livePath = liveFile || null;
  if (whereName) where = () => whereName;
  loadLive();
  if (journalTimer) clearInterval(journalTimer);
  journalTimer = null;
  if (journal) {
    journalTimer = setInterval(() => { if (journal.due()) closeEpisode(); }, 60 * 1000);
    if (journalTimer.unref) journalTimer.unref();
    if (journal.due()) closeEpisode();     // a stretch left over from before a restart
  }
}
const MAX_IMAGES = 5;
// Swap image blocks for a short note (also inside tool results) before a turn
// goes into the running history, so old frames aren't re-sent every turn.
function lightenImages(m) {
  if (!Array.isArray(m.content)) return m;
  const strip = (blocks) => blocks.map((b) => (b && b.type === 'image' ? { type: 'text', text: '[image shown earlier]' } : b));
  return { ...m, content: m.content.map((b) => (b && b.type === 'tool_result' && Array.isArray(b.content)
    ? { ...b, content: strip(b.content) } : b)).map((b) => (b && b.type === 'image' ? { type: 'text', text: '[image shown earlier]' } : b)) };
}   // swappable in tests
let runToolImpl = null;           // set by registerClaudeBrain — runs one tool through the executor + gate
let onToolEvent = null;           // optional UI hook: ({ phase, tool, status }) for the panel/logs
const MAX_TOOL_ROUNDS = () => parseInt(process.env.HANNIBAL_CLAUDE_MAX_TOOL_ROUNDS || '10', 10);

// One chat turn. onText(delta) fires as text streams in. When tools are on,
// Claude may call Hannibal's actions; the turn loops until Claude is done.
// `images`: optional base64 frames (camera / screenshots) shown with this turn.
// One turn at a time: the desk (voice) and the phone (Telegram) share one
// conversation, so a second turn waits for the first instead of interleaving.
let _queue = Promise.resolve();
function chat(payload, onText, opts) {
  const run = _queue.then(() => chatOnce(payload || {}, onText, opts || {}));
  _queue = run.catch(() => {});
  return run;
}

// opts.runTool overrides the default tool runner for this turn (Telegram uses
// its own, so confirmations are asked on the phone instead of by voice).
// Barge-in: Fred talked over Hannibal → stop the running reply right away.
// The half-said answer is kept in the history (marked as cut off), so the next
// turn knows where the conversation stopped.
let running = null;     // { cut, stream } of the turn in flight

// Things that happened outside this conversation (an older voice command path
// that sent a WhatsApp, an app opened by a shortcut…). They ride along with the
// next turn, so Hannibal never denies something he actually did.
let pendingNotes = [];
function noteEvent(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!t) return false;
  const d = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  pendingNotes.push(`${hm} ${t}`);
  try { threads && threads.observe(t, 'event'); } catch (_) {}
  if (pendingNotes.length > 8) pendingNotes = pendingNotes.slice(-8);
  return true;
}
// The last few things Fred said, so a follow-up ("and when is his flight?")
// is looked up with its thread, not on its own words.
function threadText(user) {
  const said = history.filter((m) => m.role === 'user' && typeof m.content === 'string').slice(-2).map((m) => m.content);
  return [...said, String(user || '')].join('\n').slice(-1200);
}
async function recallForThread(user) {
  if (!threads && !(journal && journal.recall)) return '';
  const text = threadText(user);
  const work = (async () => {
    const [ts, eps] = await Promise.all([
      threads ? threads.relevant(text).catch(() => []) : [],
      journal && journal.recall ? journal.recall(text).catch(() => []) : [],
    ]);
    return [threads && ts.length ? threads.renderRelevant(ts) : '', journal && eps.length ? journal.renderRecall(eps) : ''].filter(Boolean).join('\n');
  })();
  return Promise.race([work, new Promise((r) => setTimeout(() => r(''), 1200))]).catch(() => '');
}
function isWriteTool(name) {
  try { const t = require('./agent/catalog').getTool(name); return !!t && t.side_effect === require('./agent/catalog').SIDE_EFFECT.WRITE; } catch (_) { return false; }
}

function interrupt() {
  if (!running) return false;
  running.cut = true;
  try { running.stream && running.stream.abort(); } catch (_) {}
  return true;
}

async function chatOnce(payload, onText, opts = {}) {
  const me = { cut: false, stream: null };
  running = me;
  try { return await chatTurn(payload, onText, opts, me); }
  finally { if (running === me) running = null; }
}

async function chatTurn({ system, context, user, images }, onText, opts, me) {
  const runTool = opts.runTool || runToolImpl;
  if (!enabled()) return { ok: false, error: 'Claude disabled or ANTHROPIC_API_KEY missing' };
  // Back after a long break: start a fresh conversation. The diary (written
  // first, if that stretch is not in it yet) tells him what came before.
  if (journal && lastTurnAt && Date.now() - lastTurnAt > RESUME_MS() && history.length) {
    await Promise.race([closeEpisode(), new Promise((r) => setTimeout(r, 20000))]);
    if (journal.pendingCount === 0) {
      history = [];
      console.log('[claude] new conversation after a long break (the diary carries the last one)');
    } else console.log('[claude] diary not written yet, so the last conversation stays in context');
  }
  const frames = (Array.isArray(images) ? images : [])
    .filter((b) => typeof b === 'string' && claudeTools.mediaType(b)).slice(0, MAX_IMAGES);
  const turn = [{ role: 'user', content: frames.length
    ? [...frames.map((data) => ({ type: 'image', source: { type: 'base64', media_type: claudeTools.mediaType(data), data } })),
      { type: 'text', text: String(user || '') }]
    : String(user || '') }];
  // Situational context rides as a mid-conversation system message so the
  // persona above and the earlier conversation stay cacheable. The exact local
  // date/time always leads it, so dates ("Thursday", "in 2 hours") resolve right.
  const nowLine = `Now: ${nowStamp()}.`;
  const happened = pendingNotes.length
    ? `Done outside this chat since your last reply (this really happened, count it as your own work):\n${pendingNotes.map((n) => `- ${n}`).join('\n')}`
    : '';
  // Kept pending until this turn is in the history (a failed, refused or cut-off
  // turn must not lose the only record of what was done).
  const carried = pendingNotes.slice();
  const dropCarried = () => { pendingNotes = pendingNotes.filter((n) => !carried.includes(n)); };
  // Follow the thread: the threads (with their current status) and older
  // diary conversations that the last few lines are about, by meaning.
  const recalled = await recallForThread(user);
  turn.push({ role: 'system', content: [nowLine, happened, String(context || '').trim(), recalled].filter(Boolean).join('\n') });

  const useTools = !!runTool && claudeTools.enabled();
  const tools = useTools ? claudeTools.toolDefinitions() : undefined;
  let facts = '';
  try { facts = factStore().renderForPrompt(); } catch (_) {}
  let diary = '';
  try { diary = journal ? journal.renderForPrompt({ openThreads: !threads }) : ''; } catch (_) {}
  let threadList = '';
  try { threadList = threads ? threads.renderForPrompt() : ''; } catch (_) {}
  const sys = String(system || '') + (useTools ? TOOL_GUIDE : '') + facts + diary + threadList;

  let streamed = '';
  const working = [...turn];      // this turn's messages: user, note, then assistant/tool rounds
  const toolsUsed = [];
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let lastModel = model();
  try {
    for (let round = 0; ; round++) {
      if (me.cut) throw new Error('interrupted');
      const stream = me.stream = getClient().beta.messages.stream({
        model: model(),
        max_tokens: maxTokens(),
        output_config: { effort: effort() },
        // If a safety classifier declines, Anthropic re-runs the turn on its
        // recommended fallback model inside the same call.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        cache_control: { type: 'ephemeral' },
        system: sys,
        ...(tools ? { tools } : {}),
        messages: [...history, ...working],
      });
      stream.on('text', (delta) => { if (me.cut) return; streamed += delta; try { onText && onText(delta); } catch (_) {} });
      const msg = await stream.finalMessage();
      lastModel = msg.model || lastModel;
      const u = msg.usage || {};
      total.input += u.input_tokens || 0; total.output += u.output_tokens || 0;
      total.cacheRead += u.cache_read_input_tokens || 0; total.cacheWrite += u.cache_creation_input_tokens || 0;

      if (msg.stop_reason === 'refusal') {
        return { ok: false, error: 'Claude declined this request', partial: streamed, toolsUsed };
      }
      // Keep the assistant content exactly as returned (thinking + tool_use blocks
      // must be sent back unchanged while the tool loop continues).
      working.push({ role: 'assistant', content: msg.content });

      const calls = msg.content.filter((b) => b.type === 'tool_use');
      if (msg.stop_reason !== 'tool_use' || !calls.length) break;
      // Every tool_use must get a tool_result, so always answer the calls; once
      // the step budget is spent, answer them with "stopped" instead of running them.
      const stopping = round + 1 >= MAX_TOOL_ROUNDS();
      // Finish the spoken sentence before a tool runs (so speech isn't left hanging).
      if (streamed && !/[.!?…]\s*$/.test(streamed)) { try { onText && onText('. '); } catch (_) {} streamed += '. '; }

      const results = [];
      for (const c of calls) {                     // one at a time: the gate asks per action
        if (stopping) {
          results.push({ type: 'tool_result', tool_use_id: c.id, is_error: true,
            content: 'Not run: too many steps in one turn. Tell Fred what you got done and what is left.' });
          continue;
        }
        try { onToolEvent && onToolEvent({ phase: 'start', tool: claudeTools.fromApiName(c.name) }); } catch (_) {}
        const r = await runTool(c.name, c.input);
        toolsUsed.push({ tool: r.tool, status: r.status });
        // A change that went through is an event the threads can close on.
        if (threads && r.status === 'ok' && isWriteTool(r.tool) && !/^memory\./.test(r.tool)) {
          try { threads.observe(`${r.tool} done: ${JSON.stringify(c.input || {}).slice(0, 200)}`, 'event'); } catch (_) {}
        }
        console.log(`[claude] tool ${r.tool} → ${r.status}`);
        try { onToolEvent && onToolEvent({ phase: 'finish', tool: r.tool, status: r.status }); } catch (_) {}
        results.push({ type: 'tool_result', tool_use_id: c.id, content: r.content, ...(r.is_error ? { is_error: true } : {}) });
      }
      working.push({ role: 'user', content: results });
      if (round >= MAX_TOOL_ROUNDS()) break;       // hard stop: the "stopped" round already had its chance
    }

    const text = working.filter((m) => m.role === 'assistant')
      .flatMap((m) => m.content).filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    if (!text && !toolsUsed.length) return { ok: false, error: 'Claude returned no text', partial: streamed };

    // Images are only needed for the turn they were shown in; keep history light.
    history.push(...working.map(lightenImages));
    dropCarried();
    if (history.length > HISTORY_MAX) {
      history = history.slice(-HISTORY_KEEP);
      // must start on a plain user turn (never on a tool result or assistant turn)
      const plainUser = (m) => m.role === 'user' && (typeof m.content === 'string'
        || (Array.isArray(m.content) && !m.content.some((b) => b && b.type === 'tool_result')));
      while (history.length && !plainUser(history[0])) history.shift();
    }
    remember(opts, user, text);
    console.log(`[claude] ${lastModel} in=${total.input} cache_read=${total.cacheRead} `
      + `cache_write=${total.cacheWrite} out=${total.output}${toolsUsed.length ? ` tools=${toolsUsed.map((t) => t.tool).join(',')}` : ''}`);
    return { ok: true, text, model: lastModel, toolsUsed, usage: total };
  } catch (e) {
    if (me.cut) {
      // Keep the conversation coherent: Fred's question + what Hannibal got out.
      history.push(lightenImages(turn[0]), { role: 'assistant', content: `${streamed.trim() || '…'} [Fred cut me off here]` });
      remember(opts, user, `${streamed.trim()} [cut off]`);
      console.log('[claude] reply cut off by Fred (barge-in)');
      return { ok: true, text: streamed.trim(), interrupted: true, toolsUsed, model: lastModel };
    }
    const error = describeError(e);
    console.warn('[claude] failed:', error);
    // If an action already ran, say so — the caller must not re-run the request elsewhere.
    return { ok: false, error, partial: streamed, toolsUsed };
  }
}

// After a finished turn: note it in the diary and save the running conversation.
function remember(opts, user, text) {
  lastTurnAt = Date.now();
  if (!journal) return;
  try { journal.note(opts.where || where(), String(user || ''), String(text || '')); } catch (_) {}
  saveLive();
}

// opts.runTool(apiName, input) -> { content, is_error, tool, status } enables tool use.
function registerClaudeBrain(ipcMain, opts = {}) {
  runToolImpl = opts.runTool || null;
  onToolEvent = opts.onToolEvent || null;
  ipcMain.handle('llm:chat', async (event, payload) => {
    const id = payload && payload.id;
    return chat(payload || {}, (text) => {
      try { event.sender.send('llm:token', { id, text }); } catch (_) {}
    });
  });
  ipcMain.handle('llm:interrupt', () => ({ ok: interrupt() }));
  ipcMain.handle('llm:note', (_e, text) => ({ ok: noteEvent(text) }));
  ipcMain.handle('llm:reset', () => { history = []; saveLive(); return { ok: true }; });
}

module.exports = { registerClaudeBrain, chat, interrupt, noteEvent, enabled, model, toolsEnabled: () => !!runToolImpl && claudeTools.enabled(),
  resetHistory: () => { history = []; saveLive(); }, setJournal, setThreads, summarizeForJournal, closeEpisode, _setClient: (c) => { client = c; }, _setFactStore: (f) => { factStore = () => f; } };
