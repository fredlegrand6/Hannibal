// ─────────────────────────────────────────────────────────────────────────
// CONTEXT COMPRESSION — keep long runs from blowing up context. (Phase 3.)
//
// Two independent tools. Both are deterministic in structure and degrade
// safely (they never throw into the executor; on any failure they fall back to
// plain truncation).
//
//   summarizeObservation(output, opts) — any single TEXTUAL tool output over
//     ~`threshold` chars is summarized by the fast 3B model on GEX131 before it
//     would enter a downstream model's context. STRUCTURED outputs (objects used
//     for {{N.path}} dependency refs) are left untouched — we only summarize
//     plain text / {text,content,body,message} blobs, so the Stage-2 dependency
//     contract is never altered.
//
//   compressMessages(messages, opts) — 4-stage progressive compression of a
//     conversational message array once it crosses `maxMessages`:
//       Stage 1: replace old tool/observation results with a short placeholder
//       Stage 2: sliding window — keep the system message + the most recent N
//       Stage 3: drop middle call/result pairs
//       Stage 4: last resort — system message + the last `keepRecent` exchanges
//     Each stage runs only if the previous one didn't get under budget. The
//     leading system message is always preserved.
//
// NOTE ON THE EXECUTOR: Hannibal's executor is a PLAN-WALK, not a single
// message-accumulating model loop, so compressMessages has no always-on hook in
// execute() today — it is wired into replan-context building (the one place a
// transcript is handed to a model) and is otherwise a ready, tested utility for
// any component that does keep a running message array (e.g. the brain). The
// piece that bites in the plan-walk is summarizeObservation, on the one real
// overflow vector: a large output injected whole into a downstream model tool.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

// Pull a summarizable STRING out of a tool output, or null if it isn't text we
// should touch. Structured objects (with no obvious text field) return null so
// they pass through unchanged and stay valid for {{N.path}} resolution.
function asText(output) {
  if (output == null) return null;
  if (typeof output === 'string') return output;
  if (typeof output === 'object') {
    for (const k of ['text', 'content', 'body', 'message', 'output']) {
      if (typeof output[k] === 'string') return output[k];
    }
  }
  return null;
}

function defaultSummarizer({ ollamaUrl, model, maxWords = 150, timeoutMs = 30000 } = {}) {
  const url = ollamaUrl || process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
  const m = model || process.env.OLLAMA_MODEL_FAST || 'llama3.2:3b';
  return async (text) => {
    const sys = `You compress tool output for an AI agent's working context. Summarize the INPUT in `
      + `at most ${maxWords} words. Preserve every concrete fact, name, number, id, date, URL and error `
      + `message verbatim — drop only filler and repetition. Output ONLY the summary, no preamble.`;
    const res = await fetch(`${url}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: m, stream: false, options: { temperature: 0 }, keep_alive: '30m',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: text }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`summarizer HTTP ${res.status}`);
    return (await res.json()).message?.content || '';
  };
}

// Returns { summarized, text, originalLength?, truncated? }. Never throws.
async function summarizeObservation(output, opts = {}) {
  const threshold = opts.threshold || 2000;
  const text = asText(output);
  if (text == null) return { summarized: false, text: output };       // structured — leave alone
  if (text.length <= threshold) return { summarized: false, text };    // small — leave alone

  const summarize = opts.summarizer || defaultSummarizer(opts);
  try {
    const s = await summarize(text);
    if (s && s.trim()) return { summarized: true, text: s.trim(), originalLength: text.length };
  } catch (_) { /* fall through to truncation */ }
  // Safe fallback: head truncation. Compression must never break a run.
  return { summarized: true, truncated: true, originalLength: text.length, text: text.slice(0, threshold) + ' …[truncated]' };
}

// ── 4-stage progressive message compression ─────────────────────────────────
const isSystem = (msg) => msg && msg.role === 'system';
const isResult = (msg) => msg && (msg.role === 'tool' || msg.role === 'observation' || msg._kind === 'result');

function compressMessages(messages, opts = {}) {
  const maxMessages = opts.maxMessages || opts.max_context_messages || 40;
  const keepRecent = opts.keepRecent || 2;
  const placeholder = opts.placeholder || '[tool result elided to save context]';
  if (!Array.isArray(messages) || messages.length <= maxMessages) {
    return Array.isArray(messages) ? messages.slice() : [];
  }
  const sys = messages.filter(isSystem).slice(0, 1);          // preserve leading system msg
  let body = messages.filter((m) => !isSystem(m));

  // Stage 1 — replace OLD tool/observation results with a placeholder (keep the
  // most recent `maxMessages` results intact).
  let resultIdx = body.map((m, i) => (isResult(m) ? i : -1)).filter((i) => i >= 0);
  const keepResultsFrom = resultIdx.length - maxMessages;
  if (keepResultsFrom > 0) {
    const elide = new Set(resultIdx.slice(0, keepResultsFrom));
    body = body.map((m, i) => (elide.has(i) ? { ...m, content: placeholder, _elided: true } : m));
  }
  if (sys.length + body.length <= maxMessages) return [...sys, ...body];

  // Stage 2 — sliding window: keep the most recent (maxMessages - sys.length).
  const room = Math.max(keepRecent, maxMessages - sys.length);
  if (body.length > room) body = body.slice(body.length - room);
  if (sys.length + body.length <= maxMessages) return [...sys, ...body];

  // Stage 3 — drop middle call/result PAIRS, working inward from the middle.
  while (sys.length + body.length > maxMessages && body.length > keepRecent * 2) {
    const mid = Math.floor(body.length / 2);
    body.splice(Math.max(1, mid - 1), 2); // remove a 2-message slice near the middle
  }
  if (sys.length + body.length <= maxMessages) return [...sys, ...body];

  // Stage 4 — last resort: system message + the last `keepRecent` exchanges.
  return [...sys, ...body.slice(Math.max(0, body.length - keepRecent * 2))];
}

module.exports = { summarizeObservation, compressMessages, asText, defaultSummarizer };
