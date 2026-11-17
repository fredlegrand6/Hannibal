// ─────────────────────────────────────────────────────────────────────────
// WORLD AWARENESS · TOPIC ROUTER (brief §3.3, Stage 2) — maps a messy SPOKEN
// topic to a registered topic. Fast path = the registry's regex matchers;
// fallback = the heavy Ollama model classifies the phrase into one known key.
// Unknown topics GRACEFULLY DECLINE ("I don't track that one") rather than guess.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const { TOPICS, REGIONS, regionalTopic, matchTopic } = require('./topics');

const HEAVY = {
  ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  model: process.env.OLLAMA_MODEL_HEAVY || process.env.OLLAMA_MODEL || 'llama3.3:70b',
  timeoutMs: Number(process.env.WORLD_ROUTER_TIMEOUT_MS || 20000),
};

// key -> resolved topic object
function resolveKey(key) {
  if (!key) return null;
  const k = String(key).toLowerCase().trim();
  const r = REGIONS.find((x) => x.key === k || `regional:${x.key}` === k);
  if (r) return regionalTopic(r);
  return TOPICS.find((t) => t.key === k) || null;
}

function allKeys() {
  return [...TOPICS.map((t) => t.key), ...REGIONS.map((r) => `regional:${r.key}`)];
}

async function classifyWithLlm(spoken) {
  const keys = allKeys();
  const sys = 'You map a spoken request about "what is happening" to exactly ONE topic key from this list, '
    + 'or to "none" if it clearly is not any of them. Reply with STRICT JSON: {"key":"<key-or-none>"}.\n'
    + 'Keys: ' + keys.join(', ') + '.\n'
    + 'Guidance: stocks/equities/commodities/gold→markets; bitcoin/eth→crypto; a place/region→the matching regional:* key; '
    + 'war/military/tensions→conflict; flights/airports→flights; weather/forecast→weather; debt/regulation→government. '
    + 'If it is small-talk or unrelated, use "none".';
  try {
    const res = await fetch(`${HEAVY.ollamaUrl}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: HEAVY.model, stream: false, format: 'json', keep_alive: '30m', options: { temperature: 0 },
        messages: [{ role: 'system', content: sys }, { role: 'user', content: String(spoken || '') }],
      }),
      signal: AbortSignal.timeout(HEAVY.timeoutMs),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const parsed = JSON.parse((j.message && j.message.content) || '{}');
    const key = String(parsed.key || '').toLowerCase().trim();
    if (!key || key === 'none') return null;
    return resolveKey(key);
  } catch (_) { return null; }
}

// Resolve a spoken topic → topic object, or null to decline.
// `useLlm:false` (default for an already-clean key) skips the model.
async function route(spoken, { useLlm = true } = {}) {
  const fast = matchTopic(spoken);
  if (fast) return fast;
  const direct = resolveKey(spoken);     // caller passed a known key directly
  if (direct) return direct;
  if (!useLlm) return null;
  return classifyWithLlm(spoken);
}

module.exports = { route, resolveKey, allKeys };
