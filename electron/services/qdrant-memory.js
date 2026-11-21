// ─────────────────────────────────────────────────────────────────────────
// QDRANT MEMORY (main process) — the one place that reads and writes the
// hannibal_memory collection. The desk (src/voice-controller.js, through the
// memory:store / memory:search IPC) and Telegram both go through here, so the
// same rules apply everywhere:
//
//   • a GATE decides what is worth keeping: small talk ("thanks", "hey
//     Hannibal"), overheard songs and rambling, and the old noisy record types
//     (world-read prices, agent runs, app commands) are not stored;
//   • DEDUPE: a near-identical memory that is already there is not stored again;
//   • RECALL finds related memories, not only the same wording. Measured on
//     Fred's own memories (Nov 2026): a related memory ranks first but scores
//     only 0.58-0.66 with nomic-embed-text, unrelated questions top out around
//     0.41-0.53. So a hit must clear MIN_SCORE (default 0.57, MEMORY_MIN_SCORE
//     in .env), stand out from the crowd (the 20th-best score) and be close to
//     the best hit. Each line carries its date, so Claude knows how old it is.
//
// Lasting facts about Fred's life live in memory-facts.js, not here.
// Embeddings: Ollama nomic-embed-text. Every call fails soft (never throws).
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const crypto = require('crypto');

const COLLECTION = 'hannibal_memory';
const EMBED_MODEL = 'nomic-embed-text';
const DEFAULT_MIN_SCORE = 0.57;  // related memories score 0.58-0.66; unrelated tops ~0.41-0.53
const NEAR_TOP = 0.06;           // keep only hits this close to the best one
const CROWD_AT = 20;             // the n-th best score stands for "everything scores this much"
const STAND_OUT = 0.07;          // a real hit beats the crowd by at least this much
const DUPLICATE_SCORE = 0.97;    // this similar to an existing memory = already known

// Record types that are not kept any more (and are left out of recall if old
// ones are still in the collection).
const SKIP_TYPES = ['world-read', 'agent_run', 'agent-action'];

const NOISE = /\[(music|song|speaking in foreign language|foreign language|inaudible|applause|laughter|silence|no speech)\]|\*\s*song\s*\*|\((breathing|music|laughs?|sighs?|coughs?|silence)[^)]*\)/i;
const WAKE = /^(hey|hi|ok|okay)?[\s,]*(hannibal|jarvis)\b[\s,.!?]*/i;
const SMALL_TALK = /^(hey|hi|hello|thanks?|thank you|thank you very much|thanks a lot|ok|okay|yes|yep|yeah|no|nope|sure|cool|nice|lovely|great|perfect|good|good morning|good night|morning|bye|goodbye|please do|go ahead|do it|never mind|how are you|how are you doing|how are you today|you listening|are you there|are you awake)[\s,.!?]*(hannibal|fred|mate)?[\s,.!?]*$/i;
const MIN_WORDS = 4;
const MAX_SAID_CHARS = 600;      // longer than this is almost always overheard audio
const MAX_REPLY_CHARS = 1200;    // Hannibal's side of a stored exchange, cut at a sentence end

// Hannibal's reply as it should be remembered: never cut mid-sentence.
// Too long → up to the last full sentence that fits. Stopped halfway (Fred cut
// in) → the sentences he finished, or a plain note that he was interrupted.
const SENTENCE_END = /[.!?…]["'”’)\]]*(?=\s|$)/g;
function tidyReply(reply, max = MAX_REPLY_CHARS) {
  const t = String(reply || '').replace(/\s+/g, ' ').trim();
  if (!t || /…\s*(\(interrupted\))?$/.test(t)) return t;     // already tidied
  const ends = [...t.matchAll(SENTENCE_END)].map((m) => m.index + m[0].length);
  const complete = ends.length && ends[ends.length - 1] === t.length;
  if (complete && t.length <= max) return t;
  const fit = ends.filter((e) => e <= max).pop();
  if (fit) return t.slice(0, fit) + (t.length > fit && !complete ? ' … (interrupted)' : t.length > fit ? ' …' : '');
  if (t.length <= max && !complete) return `${t} … (interrupted)`;
  return `${t.slice(0, max).replace(/\s+\S*$/, '')} …`;
}

// A stored exchange with Hannibal's side tidied (other texts unchanged).
function tidyExchange(text) {
  const m = /^([\s\S]*?\n\s*Hannibal (?:replied|did):\s*)([\s\S]*)$/i.exec(String(text || ''));
  return m ? m[1] + tidyReply(m[2]) : String(text || '');
}

// The part Fred said, from a stored exchange ("Fred said (Telegram): …\nHannibal replied: …").
function fredsPart(text) {
  const m = /^Fred (?:said|asked)(?: \([^)]*\))?:\s*([\s\S]*?)\n\s*Hannibal (?:replied|did):/i.exec(String(text || ''));
  return m ? m[1] : String(text || '');
}

// Is this worth putting in long-term memory?
function worthRemembering(text, metadata = {}) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (SKIP_TYPES.includes(metadata.type)) return false;
  if (metadata.type !== 'conversation') return true;      // notes, explicit stores, awareness
  const said = fredsPart(t).trim();
  if (!said || NOISE.test(said) || said.length > MAX_SAID_CHARS) return false;
  const core = said.replace(WAKE, '').trim();
  if (!core || SMALL_TALK.test(core)) return false;
  const words = core.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words.length >= MIN_WORDS;
}

function fmtDate(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Amsterdam' });
}

function createQdrantMemory({
  qdrantUrl, ollamaUrl, apiKey = process.env.QDRANT_API_KEY,
  minScore = Number(process.env.MEMORY_MIN_SCORE) || DEFAULT_MIN_SCORE,
  fetchImpl = fetch, log = (...a) => console.warn('[memory]', ...a),
}) {
  const base = String(qdrantUrl || '').replace(/\/+$/, '');
  const qHeaders = { 'Content-Type': 'application/json', ...(apiKey ? { 'api-key': apiKey } : {}) };
  const notSkipped = { must_not: [{ key: 'type', match: { any: SKIP_TYPES } }] };

  async function embed(text) {
    try {
      const r = await fetchImpl(`${ollamaUrl}/api/embeddings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
        signal: AbortSignal.timeout(10000),
      });
      const j = await r.json();
      return j.embedding || null;
    } catch (e) { log('embed failed:', e.message); return null; }
  }

  async function rawSearch(vector, limit, threshold) {
    const r = await fetchImpl(`${base}/collections/${COLLECTION}/points/search`, {
      method: 'POST', headers: qHeaders,
      body: JSON.stringify({ vector, limit, with_payload: true, ...(threshold ? { score_threshold: threshold } : {}), filter: notSkipped }),
      signal: AbortSignal.timeout(5000),
    });
    const j = await r.json();
    return (j.result || []).map((p) => ({
      text: (p.payload && (p.payload.text || p.payload.content)) || '',
      score: p.score,
      ts: (p.payload && p.payload.timestamp) || '',
      type: (p.payload && p.payload.type) || '',
    })).filter((m) => m.text);
  }

  // Relevant memories for a question, best first: [{ text, score, ts, type }].
  async function search(text, limit = 5) {
    const vec = await embed(text);
    if (!vec) return [];
    try {
      const all = await rawSearch(vec, Math.max(CROWD_AT, limit));
      if (!all.length || all[0].score < minScore) return [];
      const crowd = all.length >= CROWD_AT ? all[CROWD_AT - 1].score : 0;
      const top = all[0].score;
      if (top - crowd < STAND_OUT) return [];
      return all.filter((h) => h.score >= minScore && h.score >= top - NEAR_TOP).slice(0, limit);
    } catch (e) { log('query failed:', e.message); return []; }
  }

  // The same, as one block for Claude's context ('' if none).
  async function recall(text, limit = 5) {
    const hits = await search(text, limit);
    if (!hits.length) return '';
    const lines = hits.map((h) => { const d = fmtDate(h.ts); return `- ${d ? `(${d}) ` : ''}${h.text}`; });
    return `RELEVANT MEMORIES (past conversations, may be out of date):\n${lines.join('\n')}`;
  }

  // Store one memory if it is worth keeping and not already there.
  // -> true (stored) | false (skipped or failed).
  async function store(text, metadata = {}) {
    if (!worthRemembering(text, metadata)) return false;
    text = tidyExchange(text);
    const vec = await embed(text);
    if (!vec) return false;
    try {
      const same = await rawSearch(vec, 1, DUPLICATE_SCORE).catch(() => []);
      if (same.length) return false;
      await fetchImpl(`${base}/collections/${COLLECTION}/points`, {
        method: 'PUT', headers: qHeaders,
        body: JSON.stringify({ points: [{ id: crypto.randomUUID(), vector: vec,
          payload: { text, source: 'hannibal', timestamp: new Date().toISOString(), ...metadata } }] }),
        signal: AbortSignal.timeout(5000),
      });
      return true;
    } catch (e) { log('store failed:', e.message); return false; }
  }

  // One-off clean-up: memories saved before replies were tidied end mid-word
  // (they were cut at 500 characters). Trim them back to the last full
  // sentence, keep the old text as text_was. Safe to run again. -> how many.
  async function repairCutReplies() {
    let fixed = 0; let offset = null;
    try {
      do {
        const r = await fetchImpl(`${base}/collections/${COLLECTION}/points/scroll`, {
          method: 'POST', headers: qHeaders, signal: AbortSignal.timeout(10000),
          body: JSON.stringify({ limit: 200, with_payload: true, with_vector: false, ...(offset != null ? { offset } : {}),
            filter: { must: [{ key: 'type', match: { value: 'conversation' } }] } }),
        });
        const j = await r.json();
        for (const p of (j.result && j.result.points) || []) {
          const old = String((p.payload && p.payload.text) || '');
          const reply = (old.split(/\nHannibal replied:\s*/)[1] || '');
          let text = tidyExchange(old);
          if (reply.length >= 495) text = text.replace(/ … \(interrupted\)$/, ' …');   // the old 500-character cut
          if (text === old) continue;
          await fetchImpl(`${base}/collections/${COLLECTION}/points/payload`, {
            method: 'POST', headers: qHeaders, signal: AbortSignal.timeout(5000),
            body: JSON.stringify({ points: [p.id], payload: { text, text_was: old } }),
          });
          fixed += 1;
        }
        offset = j.result ? j.result.next_page_offset : null;
      } while (offset != null);
      if (fixed) log(`repaired ${fixed} memories that ended mid-sentence`);
    } catch (e) { log('repair failed:', e.message); }
    return fixed;
  }

  return { recall, search, store, embed, repairCutReplies };
}

// memory:store / memory:search for the renderer (the desk voice loop).
function registerMemoryIpc(ipcMain, memory) {
  ipcMain.handle('memory:store', async (_e, { text, metadata } = {}) => ({ ok: await memory.store(String(text || ''), metadata || {}) }));
  ipcMain.handle('memory:search', async (_e, { text, limit } = {}) => memory.search(String(text || ''), Math.min(Number(limit) || 3, 10)));
}

module.exports = { createQdrantMemory, registerMemoryIpc, worthRemembering, tidyReply, tidyExchange, SKIP_TYPES };
