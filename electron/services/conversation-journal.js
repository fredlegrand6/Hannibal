// ─────────────────────────────────────────────────────────────────────────
// CONVERSATION JOURNAL: Hannibal follows the thread across days and devices.
//
// Saved facts (memory-facts.js) hold what is always true; Qdrant holds loose
// snippets. Neither tells Hannibal "what were we in the middle of?". This does:
//
//   • every exchange (desk, phone, Telegram) is noted as it happens;
//   • after a quiet spell (20 min by default) that stretch becomes one EPISODE:
//     a short summary written by Claude, with the people and projects it
//     touched and the OPEN THREADS (what was left to do or decide);
//   • the recent episodes and their open threads ride in Claude's system
//     prompt, so after a restart, a night's sleep or a switch from the phone to
//     the desk he picks up where they left off; older ones are searchable with
//     the memory.conversations tool;
//   • data/conversations.json on each side; the server's copy is the master
//     and both sides end up with every episode (merged by id).
//
// Nothing here throws: a failed summary keeps the notes and tries again later.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_EPISODES = 3000;
const MAX_PENDING = 400;               // exchanges kept while waiting for a summary
const MAX_LINE = 1500;                 // chars kept per side of an exchange
const PROMPT_EPISODES = 12;            // recent episodes in the prompt
const PROMPT_DAYS = 21;
const PROMPT_CHAR_BUDGET = 7000;
const OPEN_THREAD_EPISODES = 8;        // open threads are taken from this many recent episodes

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set('the a an and or of to in on at for with about is was we he she it i you me my our did do what when where who how that this from by be are were have has had last time'.split(' '));
// Words, folded so "Liège"/"liege", "launches"/"launch", "bookings"/"booking"
// meet: no accents, a light English/Dutch/French ending trim.
const fold = (s) => norm(String(s || '').normalize('NFD').replace(/\p{M}+/gu, ''));
const stem = (w) => (w.length > 4 ? w.replace(/(ings|ing|ies|es|ed|en|s)$/, '') : w);
const terms = (s) => fold(s).split(' ').filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
const cosine = (a, b) => {
  if (!a || !b || a.length !== b.length) return 0;
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return x && y ? d / Math.sqrt(x * y) : 0;
};
// By meaning (embeddings, nomic-embed-text). A related episode scores well
// above the crowd; these are the floors (env can tune them).
const SEARCH_MIN = () => Number(process.env.MEMORY_DIARY_MIN) || 0.5;     // memory.conversations: Fred asked, be generous
const THREAD_MIN = () => Number(process.env.MEMORY_THREAD_MIN) || 0.6;    // brought up unasked: only clear matches
const THREAD_NEAR_TOP = 0.05;

function dayLabel(iso, nowMs) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const days = Math.floor((startOfDay(nowMs) - startOfDay(d.getTime())) / 86400000);
  const when = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${when} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }

const cleanList = (a, n = 8) => (Array.isArray(a) ? a : []).map((x) => clip(x, 120)).filter(Boolean).slice(0, n);
function cleanEpisode(e) {
  if (!e || !e.id || !e.summary) return null;
  return {
    id: String(e.id), start: String(e.start || e.end || ''), end: String(e.end || e.start || ''),
    where: cleanList(e.where, 4), title: clip(e.title, 100), summary: clip(e.summary, 1200),
    people: cleanList(e.people), projects: cleanList(e.projects), open: cleanList(e.open, 6),
  };
}

// Read Claude's reply: JSON, possibly in a code fence or with words around it.
function parseSummary(text) {
  const s = String(text || '');
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const j = JSON.parse(s.slice(a, b + 1));
    if (!j || !j.summary) return null;
    return { title: j.title, summary: j.summary, people: j.people, projects: j.projects, open: j.open || j.open_threads };
  } catch (_) { return null; }
}

const SUMMARY_PROMPT = `You keep Hannibal's diary. Hannibal is Fred's personal AI assistant. Below is one stretch of their conversation.
Write it down so that Hannibal, reading it days later, can pick up the thread naturally.
Reply with JSON only, no other text:
{"title": "3-8 words",
 "summary": "2-5 plain sentences: what Fred wanted, what was found, said or done, what was decided. Concrete names, numbers and dates. Write about Fred in the third person.",
 "people": ["people mentioned, by name"],
 "projects": ["projects, companies or products touched"],
 "open": ["things left open: what Fred still wants done, what Hannibal promised, what to follow up. Empty if nothing."]}
Leave out small talk and anything that was only about getting the voice or the app to work, unless that was the topic.`;

function createJournal({ filePath, now = () => Date.now(), summarize = null, idleMs = 20 * 60 * 1000, onEpisode = null, embed = null } = {}) {
  const file = filePath || path.join(__dirname, '..', '..', 'data', 'conversations.json');
  // Embeddings of the episodes, cached beside the diary (a cache: safe to delete).
  const vecFile = file.replace(/\.json$/, '') + '.vectors.json';
  let vectors = {};
  try { vectors = JSON.parse(fs.readFileSync(vecFile, 'utf8')) || {}; } catch (_) { vectors = {}; }
  let vecDirty = false;
  const saveVectors = () => {
    if (!vecDirty) return;
    try { const tmp = `${vecFile}.tmp`; fs.writeFileSync(tmp, JSON.stringify(vectors)); fs.renameSync(tmp, vecFile); vecDirty = false; } catch (_) {}
  };
  let episodes = [];
  let pending = [];          // [{ at, where, fred, hannibal }]
  let closing = null;

  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      episodes = (Array.isArray(j.episodes) ? j.episodes : []).map(cleanEpisode).filter(Boolean);
      pending = Array.isArray(j.pending) ? j.pending.filter((p) => p && p.at) : [];
    } catch (_) { episodes = []; pending = []; }
    sortEpisodes();
  }
  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, episodes, pending }, null, 1));
      fs.renameSync(tmp, file);
    } catch (e) { console.warn('[journal] save failed:', e.message); }
  }
  function sortEpisodes() {
    episodes.sort((x, y) => String(x.end).localeCompare(String(y.end)));
    if (episodes.length > MAX_EPISODES) episodes = episodes.slice(-MAX_EPISODES);
  }

  // One exchange: what Fred said and what Hannibal answered.
  function note(where, fred, hannibal) {
    const f = clip(fred, MAX_LINE); const h = clip(hannibal, MAX_LINE);
    if (!f && !h) return;
    pending.push({ at: new Date(now()).toISOString(), where: String(where || 'desk'), fred: f, hannibal: h });
    if (pending.length > MAX_PENDING) pending = pending.slice(-MAX_PENDING);
    save();
  }

  const lastAt = () => (pending.length ? Date.parse(pending[pending.length - 1].at) : 0);
  // Time to write the diary: quiet for a while, or a long stretch already.
  const due = () => pending.length > 0 && (now() - lastAt() >= idleMs || pending.length >= 60);

  function transcript(list) {
    return list.map((p) => `[${dayLabel(p.at, now())}, ${p.where}]\nFred: ${p.fred || '(nothing said)'}\nHannibal: ${p.hannibal || '(no answer)'}`).join('\n\n');
  }

  // Turn the pending notes into an episode. Returns the episode or null.
  function close() {
    if (closing) return closing;
    if (!pending.length) return Promise.resolve(null);
    const batch = pending.slice();
    closing = (async () => {
      let s = null;
      if (summarize) {
        try { s = parseSummary(await summarize(transcript(batch), SUMMARY_PROMPT)); }
        catch (e) { console.warn('[journal] summary failed:', e && e.message); }
      }
      if (!s) {
        // No summary: keep trying for a day, then store the plain gist so nothing is lost.
        if (now() - Date.parse(batch[0].at) < 24 * 3600 * 1000) return null;
        s = { title: 'Conversation', summary: batch.slice(-6).map((p) => `Fred: ${clip(p.fred, 160)}`).join(' ') };
      }
      const ep = cleanEpisode({
        ...s, id: `ep-${Date.parse(batch[0].at).toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        start: batch[0].at, end: batch[batch.length - 1].at, where: [...new Set(batch.map((p) => p.where))],
      });
      if (!ep) return null;
      pending = pending.slice(batch.length);   // notes added meanwhile wait for the next episode
      api.lastTranscript = transcript(batch);  // for the threads pass
      episodes.push(ep); sortEpisodes(); save();
      console.log(`[journal] new episode: ${ep.title} (${batch.length} exchanges)`);
      try { onEpisode && onEpisode(ep); } catch (_) {}
      return ep;
    })().finally(() => { closing = null; });
    return closing;
  }

  // The block for Claude's system prompt: the recent episodes, then open threads.
  function renderForPrompt({ openThreads = true } = {}) {
    const cutoff = now() - PROMPT_DAYS * 86400000;
    const recent = episodes.filter((e) => Date.parse(e.end) >= cutoff).slice(-PROMPT_EPISODES);
    if (!recent.length) return '';
    const lines = []; let used = 0;
    for (const e of recent.slice().reverse()) {          // newest first while trimming
      const line = `- ${dayLabel(e.start, now())} (${e.where.join('+') || 'desk'}): ${e.title ? `${e.title}. ` : ''}${e.summary}`;
      if (used + line.length > PROMPT_CHAR_BUDGET) break;
      used += line.length; lines.unshift(line);
    }
    const open = [];
    for (const e of episodes.slice(-OPEN_THREAD_EPISODES).reverse()) {
      for (const o of e.open) if (open.length < 10 && !open.some((x) => norm(x) === norm(o))) open.push(`${o} (${dayLabel(e.end, now()).split(' ')[0]})`);
    }
    return '\n\nYOUR RECENT CONVERSATIONS WITH FRED (your diary, oldest first; use it to follow the thread, never read it out):\n'
      + lines.join('\n')
      + (openThreads && open.length ? `\nOPEN THREADS (left open in those conversations; follow up when it fits, drop what he has clearly finished):\n${open.map((o) => `- ${o}`).join('\n')}` : '')
      + '\nOlder conversations: search them with memory.conversations.';
  }

  // Keyword score per episode (folded words; names and projects count double).
  function keywordScores(query) {
    const want = terms(query);
    return episodes.map((e, i) => {
      const hay = new Set(terms([e.title, e.summary, e.people.join(' '), e.projects.join(' '), e.open.join(' ')].join(' ')));
      const tagged = new Set(terms([...e.people, ...e.projects].join(' ')));
      let score = 0;
      for (const w of want) { if (hay.has(w)) score += 1; if (tagged.has(w)) score += 1; }
      return { e, score, i };
    });
  }
  const shape = (e) => ({ when: dayLabel(e.start, now()), where: e.where.join('+'), title: e.title, summary: e.summary,
    people: e.people, projects: e.projects, open: e.open });

  // Find past conversations by words (names, projects, topics). Newest first on ties.
  function search(query, limit = 5) {
    const n = Math.min(Math.max(Number(limit) || 5, 1), 15);
    const scored = keywordScores(query);
    const want = terms(query);
    const hits = (want.length ? scored.filter((x) => x.score > 0) : scored)
      .sort((a, b) => b.score - a.score || b.i - a.i).slice(0, n);
    return {
      ok: true, count: hits.length,
      conversations: hits.map(({ e }) => shape(e)),
      ...(hits.length ? {} : { note: `no past conversation mentions "${query}"` }),
    };
  }

  // ── by meaning ──
  const episodeText = (e) => [e.title, e.summary, e.people.length ? `People: ${e.people.join(', ')}` : '',
    e.projects.length ? `Projects: ${e.projects.join(', ')}` : '', e.open.length ? `Open: ${e.open.join('; ')}` : ''].filter(Boolean).join('. ');
  // Embed the episodes that have no vector yet (newest first, a batch at a time).
  async function ensureVectors(max = 60) {
    if (!embed) return false;
    const missing = episodes.filter((e) => !vectors[e.id]).slice(-max).reverse();
    for (const e of missing) {
      let v = null;
      try { v = await embed(`search_document: ${episodeText(e)}`); } catch (_) { v = null; }
      if (!Array.isArray(v) || !v.length) break;            // embeddings down: try again next time
      vectors[e.id] = v; vecDirty = true;
    }
    const keep = new Set(episodes.map((e) => e.id));
    for (const id of Object.keys(vectors)) if (!keep.has(id)) { delete vectors[id]; vecDirty = true; }
    saveVectors();
    return true;
  }
  async function queryVector(text) {
    if (!embed || !String(text || '').trim()) return null;
    try { const v = await embed(`search_query: ${String(text).slice(0, 2000)}`); return Array.isArray(v) && v.length ? v : null; } catch (_) { return null; }
  }

  // memory.conversations: by meaning AND by words. "Jay's app" finds the
  // Mutuele talks; "the Spanish hotel client" finds HTS. Falls back to words
  // alone when embeddings are unreachable.
  async function find(query, limit = 5) {
    const n = Math.min(Math.max(Number(limit) || 5, 1), 15);
    const qv = await queryVector(query);
    if (!qv) return search(query, n);
    await ensureVectors();
    const scored = keywordScores(query).map((x) => ({ ...x, sem: cosine(qv, vectors[x.e.id]) }))
      .map((x) => ({ ...x, total: x.sem + 0.04 * Math.min(x.score, 4) }))
      .filter((x) => x.sem >= SEARCH_MIN() || x.score > 0)
      .sort((a, b) => b.total - a.total || b.i - a.i).slice(0, n);
    return {
      ok: true, count: scored.length, by: 'meaning and words',
      conversations: scored.map(({ e }) => shape(e)),
      ...(scored.length ? {} : { note: `no past conversation is about "${query}"` }),
    };
  }

  // The episodes already in the prompt (renderForPrompt) are not recalled again.
  function recentIds() {
    const cutoff = now() - PROMPT_DAYS * 86400000;
    return new Set(episodes.filter((e) => Date.parse(e.end) >= cutoff).slice(-PROMPT_EPISODES).map((e) => e.id));
  }

  // FOLLOW THE THREAD: older conversations that are about what Fred and
  // Hannibal are talking about right now (the last few lines, not one word).
  // Only clear matches, at most `limit`, closest first.
  async function recall(thread, limit = 2) {
    const qv = await queryVector(thread);
    if (!qv) return [];
    await ensureVectors();
    const skip = recentIds();
    const scored = episodes.filter((e) => !skip.has(e.id) && vectors[e.id])
      .map((e) => ({ e, sem: cosine(qv, vectors[e.id]) }))
      .filter((x) => x.sem >= THREAD_MIN())
      .sort((a, b) => b.sem - a.sem);
    if (!scored.length) return [];
    const top = scored[0].sem;
    return scored.filter((x) => top - x.sem <= THREAD_NEAR_TOP).slice(0, limit).map(({ e, sem }) => ({ ...shape(e), score: Number(sem.toFixed(3)) }));
  }
  const renderRecall = (list) => (list && list.length
    ? `Earlier conversations about what you are talking about now (from your diary; use them to follow the thread, mention only if it helps):\n${list.map((c) => `- ${c.when}: ${c.title ? `${c.title}. ` : ''}${c.summary}${c.open && c.open.length ? ` Left open: ${c.open.join('; ')}.` : ''}`).join('\n')}`
    : '');

  // Take episodes from the other side (union by id). Returns how many were new.
  function merge(list) {
    const have = new Set(episodes.map((e) => e.id));
    let added = 0;
    for (const raw of Array.isArray(list) ? list : []) {
      const e = cleanEpisode(raw);
      if (e && !have.has(e.id)) { episodes.push(e); have.add(e.id); added += 1; }
    }
    if (added) { sortEpisodes(); save(); }
    return added;
  }

  load();
  const api = {
    lastTranscript: '',
    note, due, close, renderForPrompt, search, find, recall, renderRecall, ensureVectors, merge, reload: load,
    all: () => episodes.map((e) => ({ ...e })),
    get size() { return episodes.length; }, get pendingCount() { return pending.length; }, get lastAt() { return lastAt(); }, file,
  };
  return api;
}

function registerJournal(ipcMain, journal) {
  ipcMain.handle('journal:search', (_e, query, limit) => (journal.find ? journal.find(query, limit) : journal.search(query, limit)));
}

module.exports = { createJournal, registerJournal, parseSummary, SUMMARY_PROMPT };
