// ─────────────────────────────────────────────────────────────────────────
// QDRANT MEMORY (main process) — the same hannibal_memory collection the desk
// uses (src/voice-controller.js), reachable from main so channels that don't
// go through the renderer (Telegram) recall and store memories too.
// Embeddings: Ollama nomic-embed-text. Every call fails soft (never throws).
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const crypto = require('crypto');

const COLLECTION = 'hannibal_memory';
const EMBED_MODEL = 'nomic-embed-text';

function createQdrantMemory({ qdrantUrl, ollamaUrl, fetchImpl = fetch, log = (...a) => console.warn('[memory]', ...a) }) {
  const base = String(qdrantUrl || '').replace(/\/+$/, '');

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

  // Top memories for a question, as one block for Claude's context ('' if none).
  async function recall(text, limit = 5) {
    const vec = await embed(text);
    if (!vec) return '';
    try {
      const r = await fetchImpl(`${base}/collections/${COLLECTION}/points/search`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vector: vec, limit, with_payload: true, score_threshold: 0.35 }),
        signal: AbortSignal.timeout(5000),
      });
      const j = await r.json();
      const lines = (j.result || []).map((p) => (p.payload && (p.payload.text || p.payload.content)) || '').filter(Boolean);
      return lines.length ? `RELEVANT MEMORIES:\n${lines.map((t) => `- ${t}`).join('\n')}` : '';
    } catch (e) { log('query failed:', e.message); return ''; }
  }

  async function store(text, metadata = {}) {
    const vec = await embed(text);
    if (!vec) return false;
    try {
      await fetchImpl(`${base}/collections/${COLLECTION}/points`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points: [{ id: crypto.randomUUID(), vector: vec,
          payload: { text, source: 'hannibal', timestamp: new Date().toISOString(), ...metadata } }] }),
        signal: AbortSignal.timeout(5000),
      });
      return true;
    } catch (e) { log('store failed:', e.message); return false; }
  }

  return { recall, store, embed };
}

module.exports = { createQdrantMemory };
