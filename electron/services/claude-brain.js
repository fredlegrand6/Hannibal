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
Eyes: you can see. If Fred asks about anything you'd have to look at — himself, what he's holding or wearing, the room, something he shows you, his screen — call vision__capture (kind "camera", or "screen") and look before answering. Never guess what you can't see; if the image is unclear, say what you can make out and ask him to hold it closer.
Memory: the saved facts below are things you know for sure. When Fred tells you something lasting — about a person, a project or client, how he likes things done, a decision, a place, a routine — save it with memory__remember as one short self-contained fact (do it quietly, no need to announce it unless he asked you to remember). If a saved fact is wrong or outdated, forget it and save the correct one. When he says "forget that", use memory__forget. Don't save small talk, passing moods or things that only matter right now.
You are spoken aloud: before a slow or multi-step task say one short sentence about what you're doing, and when done give the result in one or two plain sentences (no lists, no markdown).`;

function nowStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${d.toLocaleDateString('en-GB', { weekday: 'long' })} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())} (${tz})`;
}
let factStore = getDefaultFactStore;
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
async function chatOnce({ system, context, user, images }, onText, opts = {}) {
  const runTool = opts.runTool || runToolImpl;
  if (!enabled()) return { ok: false, error: 'Claude disabled or ANTHROPIC_API_KEY missing' };
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
  turn.push({ role: 'system', content: [nowLine, String(context || '').trim()].filter(Boolean).join('\n') });

  const useTools = !!runTool && claudeTools.enabled();
  const tools = useTools ? claudeTools.toolDefinitions() : undefined;
  let facts = '';
  try { facts = factStore().renderForPrompt(); } catch (_) {}
  const sys = String(system || '') + (useTools ? TOOL_GUIDE : '') + facts;

  let streamed = '';
  const working = [...turn];      // this turn's messages: user, note, then assistant/tool rounds
  const toolsUsed = [];
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let lastModel = model();
  try {
    for (let round = 0; ; round++) {
      const stream = getClient().beta.messages.stream({
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
      stream.on('text', (delta) => { streamed += delta; try { onText && onText(delta); } catch (_) {} });
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
    if (history.length > HISTORY_MAX) {
      history = history.slice(-HISTORY_KEEP);
      // must start on a plain user turn (never on a tool result or assistant turn)
      const plainUser = (m) => m.role === 'user' && (typeof m.content === 'string'
        || (Array.isArray(m.content) && !m.content.some((b) => b && b.type === 'tool_result')));
      while (history.length && !plainUser(history[0])) history.shift();
    }
    console.log(`[claude] ${lastModel} in=${total.input} cache_read=${total.cacheRead} `
      + `cache_write=${total.cacheWrite} out=${total.output}${toolsUsed.length ? ` tools=${toolsUsed.map((t) => t.tool).join(',')}` : ''}`);
    return { ok: true, text, model: lastModel, toolsUsed, usage: total };
  } catch (e) {
    const error = describeError(e);
    console.warn('[claude] failed:', error);
    // If an action already ran, say so — the caller must not re-run the request elsewhere.
    return { ok: false, error, partial: streamed, toolsUsed };
  }
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
  ipcMain.handle('llm:reset', () => { history = []; return { ok: true }; });
}

module.exports = { registerClaudeBrain, chat, enabled, model, toolsEnabled: () => !!runToolImpl && claudeTools.enabled(),
  resetHistory: () => { history = []; }, _setClient: (c) => { client = c; }, _setFactStore: (f) => { factStore = () => f; } };
