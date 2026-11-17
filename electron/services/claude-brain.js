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

// One chat turn. onText(delta) fires as text streams in.
async function chat({ system, context, user }, onText) {
  if (!enabled()) return { ok: false, error: 'Claude disabled or ANTHROPIC_API_KEY missing' };
  const turn = [{ role: 'user', content: String(user || '') }];
  // Situational context rides as a mid-conversation system message so the
  // persona above and the earlier conversation stay cacheable.
  if (context && String(context).trim()) turn.push({ role: 'system', content: String(context).trim() });

  let streamed = '';
  try {
    const stream = getClient().beta.messages.stream({
      model: model(),
      max_tokens: maxTokens(),
      output_config: { effort: effort() },
      // If a safety classifier declines, Anthropic re-runs the turn on its
      // recommended fallback model inside the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      cache_control: { type: 'ephemeral' },
      system: String(system || ''),
      messages: [...history, ...turn],
    });
    stream.on('text', (delta) => { streamed += delta; try { onText && onText(delta); } catch (_) {} });
    const msg = await stream.finalMessage();

    if (msg.stop_reason === 'refusal') {
      return { ok: false, error: 'Claude declined this request', partial: streamed };
    }
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (!text.trim()) return { ok: false, error: 'Claude returned no text', partial: streamed };

    history.push(...turn, { role: 'assistant', content: text });
    if (history.length > HISTORY_MAX) {
      history = history.slice(-HISTORY_KEEP);
      while (history.length && history[0].role !== 'user') history.shift(); // must start on a user turn
    }
    const u = msg.usage || {};
    console.log(`[claude] ${msg.model} in=${u.input_tokens} cache_read=${u.cache_read_input_tokens || 0} `
      + `cache_write=${u.cache_creation_input_tokens || 0} out=${u.output_tokens}`);
    return { ok: true, text, model: msg.model, usage: {
      input: u.input_tokens, output: u.output_tokens,
      cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0,
    } };
  } catch (e) {
    const error = describeError(e);
    console.warn('[claude] failed:', error);
    return { ok: false, error, partial: streamed };
  }
}

function registerClaudeBrain(ipcMain) {
  ipcMain.handle('llm:chat', async (event, payload) => {
    const id = payload && payload.id;
    return chat(payload || {}, (text) => {
      try { event.sender.send('llm:token', { id, text }); } catch (_) {}
    });
  });
  ipcMain.handle('llm:reset', () => { history = []; return { ok: true }; });
}

module.exports = { registerClaudeBrain, chat, enabled, model, resetHistory: () => { history = []; } };
