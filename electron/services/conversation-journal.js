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
const terms = (s) => norm(s).split(' ').filter((w) => w.length > 1 && !STOP.has(w));

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

function createJournal({ filePath, now = () => Date.now(), summarize = null, idleMs = 20 * 60 * 1000, onEpisode = null } = {}) {
  const file = filePath || path.join(__dirname, '..', '..', 'data', 'conversations.json');
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
      episodes.push(ep); sortEpisodes(); save();
      console.log(`[journal] new episode: ${ep.title} (${batch.length} exchanges)`);
      try { onEpisode && onEpisode(ep); } catch (_) {}
      return ep;
    })().finally(() => { closing = null; });
    return closing;
  }

  // The block for Claude's system prompt: the recent episodes, then open threads.
  function renderForPrompt() {
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
      + (open.length ? `\nOPEN THREADS (left open in those conversations; follow up when it fits, drop what he has clearly finished):\n${open.map((o) => `- ${o}`).join('\n')}` : '')
      + '\nOlder conversations: search them with memory.conversations.';
  }

  // Find past conversations by words (names, projects, topics). Newest first on ties.
  function search(query, limit = 5) {
    const want = terms(query);
    const n = Math.min(Math.max(Number(limit) || 5, 1), 15);
    const scored = episodes.map((e, i) => {
      const hay = new Set(terms([e.title, e.summary, e.people.join(' '), e.projects.join(' '), e.open.join(' ')].join(' ')));
      const tagged = new Set(terms([...e.people, ...e.projects].join(' ')));
      let score = 0;
      for (const w of want) { if (hay.has(w)) score += 1; if (tagged.has(w)) score += 1; }
      return { e, score, i };
    });
    const hits = (want.length ? scored.filter((x) => x.score > 0) : scored)
      .sort((a, b) => b.score - a.score || b.i - a.i).slice(0, n);
    return {
      ok: true, count: hits.length,
      conversations: hits.map(({ e }) => ({ when: dayLabel(e.start, now()), where: e.where.join('+'), title: e.title, summary: e.summary,
        people: e.people, projects: e.projects, open: e.open })),
      ...(hits.length ? {} : { note: `no past conversation mentions "${query}"` }),
    };
  }

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
  return {
    note, due, close, renderForPrompt, search, merge, reload: load,
    all: () => episodes.map((e) => ({ ...e })),
    get size() { return episodes.length; }, get pendingCount() { return pending.length; }, get lastAt() { return lastAt(); }, file,
  };
}

function registerJournal(ipcMain, journal) {
  ipcMain.handle('journal:search', (_e, query, limit) => journal.search(query, limit));
}

module.exports = { createJournal, registerJournal, parseSummary, SUMMARY_PROMPT };
