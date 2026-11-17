// ─────────────────────────────────────────────────────────────────────────
// WORLD AWARENESS · NARRATOR (brief §3.5) — turns ANY WorldRead into ONE
// natural spoken line. Topic-agnostic: it speaks `headline` + the pre-formatted
// `signals[]` the normalizer judged worth saying. Leads with what's moving; the
// rest drops back. Narration logic stays separate from data logic so a future
// product can swap voice/persona without touching the feeds.
//
// HONESTY CONTRACT ("REAL numbers only. Never invent a figure."):
//   • The factual line is built DETERMINISTICALLY from the WorldRead, so every
//     number is a real endpoint figure (the normalizer pre-formats them).
//   • A 70b polish pass (reuses the heavy Ollama model) may rephrase for natural
//     flow, but is NUMBER-VALIDATED: any numeric token it introduces that wasn't
//     in the deterministic line is rejected → we speak the deterministic line.
//   • Unreachable feeds are stated plainly, never fabricated.
//
// Emits text only. Speaking it (ElevenLabs "Daniel") is the renderer's existing
// speakLine() pipeline — unchanged.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const HEAVY = {
  ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  model: process.env.OLLAMA_MODEL_HEAVY || process.env.OLLAMA_MODEL || 'llama3.3:70b',
  polish: process.env.WORLD_NARRATOR_POLISH !== '0',
  timeoutMs: Number(process.env.WORLD_NARRATOR_TIMEOUT_MS || 30000),
};

// ── shared number formatting (normalizers use these so figures are consistent) ──
function fmtPrice(p) {
  if (typeof p !== 'number' || !isFinite(p)) return '—';
  if (p >= 10000) return `$${(p / 1000).toFixed(1)}k`;
  if (p >= 1000) return `$${Math.round(p).toLocaleString('en-US')}`;
  if (p >= 10) return `$${Math.round(p)}`;
  if (p >= 1) return `$${p.toFixed(2)}`;
  return `$${Number(p.toPrecision(2))}`;
}
function fmtPct(c) {
  if (typeof c !== 'number' || !isFinite(c)) return '';
  return `${c >= 0 ? '+' : ''}${c.toFixed(1)}%`;
}
function fmtNum(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return String(Math.round(n * 10) / 10);
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function joinList(a) {
  if (!a.length) return '';
  if (a.length === 1) return a[0];
  if (a.length === 2) return `${a[0]} and ${a[1]}`;
  return `${a.slice(0, -1).join(', ')}, and ${a[a.length - 1]}`;
}

// Render one signal as a spoken clause. `value` is already a human string; a
// signal may instead carry only `text` (a complete clause).
function signalClause(s) {
  if (s.text) return s.text;
  if (s.label && s.value) return `${s.label} ${s.value}`;
  return s.value || s.label || '';
}

// Deterministic, factual one-liner from any WorldRead. Real figures only.
function buildLine(wr) {
  const lead = wr.headline && wr.headline.text ? cap(wr.headline.text) : cap(`here's ${wr.topic}`);
  const clauses = (wr.signals || []).map(signalClause).filter(Boolean);
  let line = clauses.length ? `${lead} — ${clauses.join(', ')}.` : `${lead}.`;
  if (wr.missing && wr.missing.length) line += ` I couldn't reach ${joinList(wr.missing)} just now.`;
  return line.replace(/\s+/g, ' ').trim();
}

// ── numeric-token guard for the 70b polish ──
function numTokens(s) {
  return (String(s).match(/\d[\d,]*(?:\.\d+)?/g) || []).map((t) => t.replace(/,/g, ''));
}
function polishIsFaithful(deterministic, candidate) {
  if (!candidate) return false;
  const c = candidate.trim();
  if (!c || c.length > 320 || /\n/.test(c)) return false;
  const allowed = new Set(numTokens(deterministic));
  for (const tok of numTokens(c)) if (!allowed.has(tok)) return false;
  return true;
}

async function polish(line) {
  const sys = 'You are Hannibal, Fred\'s assistant, speaking one short line out loud. '
    + 'Rephrase the given world-status line to sound natural and conversational — ONE or two short '
    + 'sentences, spoken style, no markdown, no lists, no preamble or quotes. '
    + 'CRITICAL: keep every number, ticker, percentage and place name EXACTLY as given. '
    + 'Do not add, remove, round, or invent any figure or fact.';
  const res = await fetch(`${HEAVY.ollamaUrl}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: HEAVY.model, stream: false, keep_alive: '30m', options: { temperature: 0.3 },
      messages: [{ role: 'system', content: sys }, { role: 'user', content: line }],
    }),
    signal: AbortSignal.timeout(HEAVY.timeoutMs),
  });
  if (!res.ok) throw new Error(`narrator HTTP ${res.status}`);
  const j = await res.json();
  return ((j.message && j.message.content) || '').trim().replace(/^["']|["']$/g, '');
}

// Public: WorldRead -> { line, source:'deterministic'|'70b' }.
async function narrate(wr) {
  const deterministic = buildLine(wr);
  if (!HEAVY.polish) return { line: deterministic, source: 'deterministic' };
  try {
    const candidate = await polish(deterministic);
    if (polishIsFaithful(deterministic, candidate)) return { line: candidate, source: '70b' };
  } catch (_) { /* fall back to the exact deterministic line */ }
  return { line: deterministic, source: 'deterministic' };
}

module.exports = { narrate, buildLine, polishIsFaithful, fmtPrice, fmtPct, fmtNum, cap, joinList };
