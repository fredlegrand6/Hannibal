// ─────────────────────────────────────────────────────────────────────────
// MEMORY FACTS — what Hannibal knows for sure about Fred's life.
//
// The Qdrant memory (hannibal_memory) stores raw conversation snippets and is
// searched by similarity: good for "what did we talk about", but hit-or-miss
// for the things Hannibal should simply ALWAYS know — who Jay is, which client
// HTS is, how Fred likes his briefings. Those live here instead:
//
//   • short, single facts ("Jay is Fred's son, 26, works with him on Mutuele"),
//     each with a category, saved by Claude through the memory.remember tool
//     when Fred tells it something lasting, and removed with memory.forget;
//   • stored locally in data/memory-facts.json (no network, survives restarts,
//     readable and editable by hand);
//   • the whole list rides in Claude's system prompt every turn, so it is never
//     a retrieval miss. The prompt is cached, so this costs almost nothing until
//     a fact changes.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');

const CATEGORIES = ['person', 'project', 'preference', 'decision', 'place', 'routine', 'other'];
const MAX_FACTS = 400;            // hard cap; the oldest "other" facts go first
const MAX_FACT_CHARS = 400;
const PROMPT_CHAR_BUDGET = 24000; // ~6k tokens in the (cached) system prompt

function createFactStore({ filePath, now = () => new Date().toISOString() } = {}) {
  const file = filePath || path.join(__dirname, '..', '..', 'data', 'memory-facts.json');
  let facts = [];
  let seq = 0;

  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      facts = Array.isArray(j.facts) ? j.facts.filter((f) => f && f.text) : [];
    } catch (_) { facts = []; }
    seq = facts.reduce((m, f) => Math.max(m, parseInt(String(f.id).replace(/\D/g, ''), 10) || 0), 0);
  }
  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, facts }, null, 2));
      fs.renameSync(tmp, file);              // atomic: a crash never leaves half a file
    } catch (e) { console.warn('[facts] save failed:', e.message); }
  }
  const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();

  // Save one fact. A near-identical fact is updated instead of duplicated.
  function remember(text, category) {
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_CHARS);
    if (!t) return { ok: false, error: 'empty fact' };
    const cat = CATEGORIES.includes(category) ? category : 'other';
    const n = norm(t);
    const dup = facts.find((f) => norm(f.text) === n);
    if (dup) { dup.updated = now(); dup.category = cat; save(); return { ok: true, id: dup.id, duplicate: true }; }
    const fact = { id: `f${++seq}`, text: t, category: cat, created: now() };
    facts.push(fact);
    while (facts.length > MAX_FACTS) {
      const i = facts.findIndex((f) => f.category === 'other');
      facts.splice(i >= 0 ? i : 0, 1);
    }
    save();
    return { ok: true, id: fact.id, total: facts.length };
  }

  // Remove by id ("f12") or by text: every fact containing all the given words.
  function forget(query) {
    const q = String(query || '').trim();
    if (!q) return { ok: false, error: 'say which fact to forget' };
    let hit;
    if (/^f\d+$/i.test(q)) hit = facts.filter((f) => f.id.toLowerCase() === q.toLowerCase());
    else {
      const words = norm(q).split(' ').filter((w) => w.length > 1);
      hit = facts.filter((f) => { const n = norm(f.text); return words.length && words.every((w) => n.includes(w)); });
    }
    if (!hit.length) return { ok: false, error: `no saved fact matches "${q}"`, removed: [] };
    if (hit.length > 5) return { ok: false, error: `"${q}" matches ${hit.length} facts — be more specific or use an id`, matches: hit.map((f) => ({ id: f.id, text: f.text })) };
    facts = facts.filter((f) => !hit.includes(f));
    save();
    return { ok: true, removed: hit.map((f) => ({ id: f.id, text: f.text })) };
  }

  function list(category) {
    const out = category ? facts.filter((f) => f.category === category) : facts.slice();
    return { ok: true, count: out.length, facts: out.map((f) => ({ id: f.id, category: f.category, text: f.text })) };
  }

  // The block that goes into Claude's system prompt. Grouped, newest kept if over budget.
  function renderForPrompt() {
    if (!facts.length) return '';
    const lines = [];
    let used = 0;
    const newestFirst = facts.slice().reverse();
    const kept = [];
    for (const f of newestFirst) {
      const line = `- [${f.id}] ${f.text}`;
      if (used + line.length > PROMPT_CHAR_BUDGET) break;
      used += line.length + 1; kept.push(f);
    }
    for (const cat of CATEGORIES) {
      const group = kept.filter((f) => f.category === cat).reverse();
      if (!group.length) continue;
      lines.push(`${cat[0].toUpperCase()}${cat.slice(1)}s:`.replace('Others:', 'Other:'));
      for (const f of group) lines.push(`- [${f.id}] ${f.text}`);
    }
    return `\n\nWHAT YOU KNOW ABOUT FRED'S WORLD (saved facts — trust these, use them naturally, never recite the list):\n${lines.join('\n')}`;
  }

  load();
  return { remember, forget, list, renderForPrompt, reload: load, get size() { return facts.length; }, file };
}

let _default = null;
const getDefaultFactStore = () => (_default || (_default = createFactStore()));

function registerFacts(ipcMain, store = getDefaultFactStore()) {
  ipcMain.handle('facts:remember', (_e, text, category) => store.remember(text, category));
  ipcMain.handle('facts:forget', (_e, query) => store.forget(query));
  ipcMain.handle('facts:list', (_e, category) => store.list(category));
}

module.exports = { createFactStore, getDefaultFactStore, registerFacts, CATEGORIES };
