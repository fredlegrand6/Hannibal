// ─────────────────────────────────────────────────────────────────────────
// THREADS: what Fred and Hannibal are working on, each with its CURRENT status.
//
// The diary (conversation-journal.js) remembers what was said. That is not
// enough: an "open" item in an old summary stays open forever, so Hannibal
// brought back things Fred had already finished or dropped. A thread is a
// living object instead:
//
//   { id, title, people, projects, status, statusNote, waitingOn, until,
//     createdAt, updatedAt, lastMentionedAt, history:[{ when, event, source }] }
//   status: open | in_progress | waiting_on | done | dropped | snoozed
//
// Status changes come from Fred's own words (Claude calls memory.thread at
// once: Fred's word wins, even with no tool record), from things done outside
// the chat (a reminder that fired, a mail sent, Claude Code finishing a job),
// and from a short Claude pass after each stretch of conversation that maps
// what was said onto the existing threads BY MEANING and only creates a new
// thread when nothing matches.
//
// In the prompt: only open / in progress / waiting threads (and snoozed ones
// whose date has passed), each with its latest step; done and dropped ones
// sit in a short "recently closed, don't bring up" list for 7 days, then only
// memory.threads finds them. data/threads.json, synced desk <-> server by id
// (the newer update wins). Nothing here throws.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATUSES = ['open', 'in_progress', 'waiting_on', 'done', 'dropped', 'snoozed'];
const ACTIVE = new Set(['open', 'in_progress', 'waiting_on']);
const CLOSED = new Set(['done', 'dropped']);
const DAY = 86400000;
const CLOSED_IN_PROMPT_DAYS = 7;
const MAX_HISTORY = 30;
const MAX_THREADS = 2000;
const MAX_EVENTS = 60;
// By meaning (nomic-embed-text cosine). Tuned on Fred's own threads, Nov 2026.
const SAME_THREAD = () => Number(process.env.THREAD_SAME_MIN) || 0.82;   // this close = the same thread (dedupe)
const RELEVANT = () => Number(process.env.THREAD_RELEVANT_MIN) || 0.6;   // brought into a turn unasked
const FIND_MIN = () => Number(process.env.THREAD_FIND_MIN) || 0.5;       // memory.threads search
const CLOSED_TOPIC = () => Number(process.env.THREAD_CLOSED_MIN) || 0.72; // a nudge about a closed thread is skipped

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set('the a an and or of to in on at for with about is was we he she it i you me my our did do what when where who how that this from by be are were have has had fix make get de het een en van op te met le la les et du des el los las y'.split(' '));
const stem = (w) => (w.length > 4 ? w.replace(/(ings|ing|ies|es|ed|en|s)$/, '') : w);
const terms = (s) => [...new Set(norm(s).split(' ').filter((w) => w.length > 1 && !STOP.has(w)).map(stem))];
const overlap = (a, b) => {
  const A = new Set(terms(a)); const B = new Set(terms(b));
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n += 1;
  return n / Math.min(A.size, B.size);
};
const cosine = (a, b) => {
  if (!a || !b || a.length !== b.length) return 0;
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return x && y ? d / Math.sqrt(x * y) : 0;
};
const idFor = (title) => `t-${crypto.createHash('sha1').update(norm(title)).digest('hex').slice(0, 10)}`;
const dayLabel = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const STATUS_WORDS = { open: 'open', in_progress: 'in progress', waiting_on: 'waiting', done: 'done', dropped: 'dropped', snoozed: 'snoozed' };

function normStatus(s) {
  const t = String(s || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (STATUSES.includes(t)) return t;
  if (/^(closed|finished|complete|completed|fixed|solved|resolved|tested)$/.test(t)) return 'done';
  if (/^(cancel+ed|abandoned|forget|forgotten|skip|skipped|not_needed)$/.test(t)) return 'dropped';
  if (/^(waiting|blocked|pending)$/.test(t)) return 'waiting_on';
  if (/^(later|paused|parked|on_hold)$/.test(t)) return 'snoozed';
  if (/^(started|ongoing|working|active)$/.test(t)) return 'in_progress';
  return null;
}

function cleanThread(t) {
  if (!t || !String(t.title || '').trim()) return null;
  const at = Number(t.updatedAt) || Date.parse(t.updatedAt) || Date.now();
  return {
    id: String(t.id || idFor(t.title)),
    title: clip(t.title, 140),
    people: (Array.isArray(t.people) ? t.people : []).map((x) => clip(x, 60)).filter(Boolean).slice(0, 12),
    projects: (Array.isArray(t.projects) ? t.projects : []).map((x) => clip(x, 60)).filter(Boolean).slice(0, 12),
    status: normStatus(t.status) || 'open',
    statusNote: clip(t.statusNote, 300),
    waitingOn: clip(t.waitingOn, 80),
    until: t.until ? String(t.until).slice(0, 25) : '',
    createdAt: Number(t.createdAt) || Date.parse(t.createdAt) || at,
    updatedAt: at,
    lastMentionedAt: Number(t.lastMentionedAt) || 0,
    history: (Array.isArray(t.history) ? t.history : []).filter((h) => h && h.event)
      .map((h) => ({ when: Number(h.when) || Date.parse(h.when) || at, event: clip(h.event, 300), source: clip(h.source || 'hannibal', 30) }))
      .slice(-MAX_HISTORY),
  };
}

const THREADS_PROMPT = `You keep Hannibal's list of THREADS: the things Fred (his principal) and Hannibal (his AI assistant) are working on, each with a current status.
You get the current threads (JSON), things that happened outside the chat (EVENTS), and the latest conversation.
Decide what changed. Rules:
- Match by MEANING, not words: "the brief runs three times" and "morning brief once at 8:00" are the same thread. Only create a new thread when nothing existing fits, and only for real work, plans, promises or questions Fred cares about (not small talk, not one-off answers that are already complete).
- Fred's word wins: if Fred says something is done, fixed, tested, sent, cancelled or that it happened, mark it done (source "fred") even if nothing else confirms it. "Forget it", "drop it", "not important" -> dropped. "Later", "after the weekend" -> snoozed (with until as YYYY-MM-DD when he gave a time). Waiting on someone -> waiting_on (with waiting_on = who).
- An event that finishes a thread (a reminder fired, a mail sent, an event deleted, Claude Code merged a fix) -> done (source "event").
- A question Hannibal asked that Fred never answered and that no longer matters -> dropped.
- Two existing threads that mean the same thing -> merge: keep one, give the other "merge_into" with the kept id.
- Do not repeat threads that did not change.
Answer with JSON only, no prose:
{"updates":[{"id":"existing id, or omit for a new thread","title":"short title, e.g. Morning brief runs once a day at 08:00","status":"open|in_progress|waiting_on|done|dropped|snoozed","note":"one short line: what happened / the latest step","people":["..."],"projects":["..."],"waiting_on":"","until":"","source":"fred|event|hannibal","merge_into":""}]}`;

function parseUpdates(text) {
  const m = /\{[\s\S]*\}/.exec(String(text || ''));
  if (!m) return null;
  try { const j = JSON.parse(m[0]); return Array.isArray(j.updates) ? j.updates : null; } catch (_) { return null; }
}

function createThreadStore({ filePath, now = () => Date.now(), embed = null, onChange = null, log = (...a) => console.log('[threads]', ...a) } = {}) {
  const file = filePath || path.join(__dirname, '..', '..', 'data', 'threads.json');
  const vecFile = file.replace(/\.json$/, '') + '.vectors.json';
  let threads = [];
  let events = [];          // [{ when, text, source }] waiting for the next pass
  let vectors = {};         // key (id|title) -> vector
  let vecDirty = false;
  let existed = false;

  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      threads = (Array.isArray(j.threads) ? j.threads : []).map(cleanThread).filter(Boolean);
      events = Array.isArray(j.events) ? j.events.slice(-MAX_EVENTS) : [];
      existed = true;
    } catch (_) { threads = []; events = []; existed = false; }
    try { vectors = JSON.parse(fs.readFileSync(vecFile, 'utf8')) || {}; } catch (_) { vectors = {}; }
  }
  function save(changed = true) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (threads.length > MAX_THREADS) threads = threads.sort((a, b) => a.updatedAt - b.updatedAt).slice(-MAX_THREADS);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, threads, events }, null, 1));
      fs.renameSync(tmp, file);
      existed = true;
    } catch (e) { console.warn('[threads] save failed:', e.message); }
    if (changed) { try { onChange && onChange(threads.map((t) => ({ ...t }))); } catch (_) {} }
  }
  function saveVectors() {
    if (!vecDirty) return;
    try { const tmp = `${vecFile}.tmp`; fs.writeFileSync(tmp, JSON.stringify(vectors)); fs.renameSync(tmp, vecFile); vecDirty = false; } catch (_) {}
  }

  const vecKey = (t) => `${t.id}|${norm(t.title)}`;
  const threadText = (t) => [t.title, t.people.length ? `People: ${t.people.join(', ')}` : '', t.projects.length ? `Projects: ${t.projects.join(', ')}` : '',
    t.statusNote].filter(Boolean).join('. ');
  async function vec(text) {
    if (!embed || !String(text || '').trim()) return null;
    try { const v = await embed(String(text).slice(0, 2000)); return Array.isArray(v) && v.length ? v : null; } catch (_) { return null; }
  }
  async function ensureVectors() {
    if (!embed) return false;
    for (const t of threads) {
      const k = vecKey(t);
      if (vectors[k]) continue;
      const v = await vec(threadText(t));
      if (!v) return false;                   // embeddings down: words only for now
      vectors[k] = v; vecDirty = true;
    }
    const keep = new Set(threads.map(vecKey));
    for (const k of Object.keys(vectors)) if (!keep.has(k)) { delete vectors[k]; vecDirty = true; }
    saveVectors();
    return true;
  }
  // Each thread scored against a text: by meaning when embeddings work, else by words.
  async function scoreAll(text, list = threads) {
    const q = await vec(text);
    const haveVecs = q ? await ensureVectors() : false;
    return list.map((t) => {
      const sem = q && haveVecs ? cosine(q, vectors[vecKey(t)]) : 0;
      const words = overlap(text, [t.title, t.people.join(' '), t.projects.join(' ')].join(' '));
      return { t, sem, words, byMeaning: !!(q && haveVecs) };
    });
  }

  const isActive = (t) => ACTIVE.has(t.status) || (t.status === 'snoozed' && (!t.until || Date.parse(t.until) <= now()));
  const byId = (id) => threads.find((t) => t.id === id);
  const latest = (t) => t.history[t.history.length - 1];

  function push(t, event, source) {
    t.history.push({ when: now(), event: clip(event, 300), source: source || 'hannibal' });
    if (t.history.length > MAX_HISTORY) t.history = t.history.slice(-MAX_HISTORY);
    t.updatedAt = now();
  }

  // Apply a change to a thread. Fred's word wins: a later 'hannibal' guess never reopens what Fred closed.
  function applyTo(t, u) {
    const status = normStatus(u.status);
    const src = u.source || 'hannibal';
    const lastFred = [...t.history].reverse().find((h) => h.source === 'fred');
    if (status && status !== t.status && CLOSED.has(t.status) && src !== 'fred' && lastFred && /done|dropped/.test(lastFred.event) && !CLOSED.has(status)) {
      return false;   // Fred closed it himself; only Fred reopens it
    }
    let changed = false;
    if (status && status !== t.status) {
      t.status = status; changed = true;
      push(t, `${STATUS_WORDS[status]}${u.note ? `: ${u.note}` : ''}`, src);
    } else if (u.note && u.note !== t.statusNote) {
      push(t, u.note, src); changed = true;
    }
    if (u.note) t.statusNote = clip(u.note, 300);
    if (u.waiting_on !== undefined || u.waitingOn !== undefined) t.waitingOn = clip(u.waiting_on || u.waitingOn, 80);
    if (u.until !== undefined) t.until = u.until ? String(u.until).slice(0, 25) : '';
    for (const k of ['people', 'projects']) {
      const add = (Array.isArray(u[k]) ? u[k] : []).map((x) => clip(x, 60)).filter(Boolean);
      const merged = [...new Set([...t[k], ...add])].slice(0, 12);
      if (merged.length !== t[k].length) { t[k] = merged; changed = true; }
    }
    if (changed) t.updatedAt = now();
    return changed;
  }

  // The thread this text is about, by id or meaning (null if none is close enough).
  async function match(text, { min = SAME_THREAD(), statuses = null } = {}) {
    const direct = byId(String(text || '').trim());
    if (direct) return direct;
    const exact = threads.find((t) => norm(t.title) === norm(text));
    if (exact) return exact;
    const pool = statuses ? threads.filter((t) => statuses.includes(t.status)) : threads;
    const scored = (await scoreAll(text, pool)).map((x) => ({ ...x, s: x.byMeaning ? x.sem : x.words * 0.9 }))
      .sort((a, b) => b.s - a.s);
    return scored.length && scored[0].s >= min ? scored[0].t : null;
  }

  // Create or update. Used by the pass, by Claude's memory.thread tool, and by housekeeping.
  async function upsert(u, { create = true, minMatch } = {}) {
    if (!u) return { ok: false, error: 'nothing to update' };
    let t = (u.id && byId(u.id)) || null;
    if (!t && u.title) t = await match(u.title, minMatch ? { min: minMatch } : {});
    if (!t) {
      if (!create || !u.title) return { ok: false, error: `no thread matches "${u.title || u.id}"` };
      t = cleanThread({ id: byId(idFor(u.title)) ? `t-${now().toString(36)}${Math.random().toString(36).slice(2, 5)}` : idFor(u.title),
        title: u.title, people: u.people, projects: u.projects, status: normStatus(u.status) || 'open', statusNote: u.note,
        waitingOn: u.waiting_on || u.waitingOn, until: u.until, createdAt: now(), updatedAt: now(),
        history: [{ when: now(), event: `${STATUS_WORDS[normStatus(u.status) || 'open']}${u.note ? `: ${u.note}` : ''}`, source: u.source || 'hannibal' }] });
      threads.push(t);
      save();
      log(`new: ${t.title} (${t.status})`);
      return { ok: true, created: true, thread: { ...t } };
    }
    if (u.merge_into && u.merge_into !== t.id && byId(u.merge_into)) {
      const keep = byId(u.merge_into);
      keep.history = [...keep.history, ...t.history].sort((a, b) => a.when - b.when).slice(-MAX_HISTORY);
      keep.people = [...new Set([...keep.people, ...t.people])].slice(0, 12);
      keep.projects = [...new Set([...keep.projects, ...t.projects])].slice(0, 12);
      push(keep, `merged with "${t.title}"`, 'hannibal');
      threads = threads.filter((x) => x !== t);
      save();
      log(`merged "${t.title}" into "${keep.title}"`);
      return { ok: true, merged: true, thread: { ...keep } };
    }
    const changed = applyTo(t, u);
    if (changed) { save(); log(`${t.title} -> ${t.status}${u.note ? ` (${clip(u.note, 80)})` : ''}`); }
    return { ok: true, changed, thread: { ...t } };
  }

  // Something happened outside the chat; the next pass (or Claude) uses it.
  function observe(text, source = 'event') {
    const t = clip(text, 300);
    if (!t) return;
    events.push({ when: now(), text: t, source });
    if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
    save(false);
  }

  // The Claude pass: map a stretch of conversation onto the threads.
  async function reconcile({ transcript, summarize }) {
    if (!summarize || !String(transcript || '').trim()) return { ok: false, error: 'nothing to read' };
    const cut = now() - 14 * DAY;
    const shown = threads.filter((t) => !CLOSED.has(t.status) || t.updatedAt >= cut)
      .map((t) => ({ id: t.id, title: t.title, status: t.status, note: t.statusNote, waiting_on: t.waitingOn || undefined, until: t.until || undefined }));
    const ev = events.slice();
    const input = `CURRENT THREADS:\n${JSON.stringify(shown)}\n\nEVENTS (outside the chat):\n${ev.length ? ev.map((e) => `- ${new Date(e.when).toISOString().slice(0, 16)} ${e.text}`).join('\n') : '(none)'}\n\nCONVERSATION:\n${transcript}`;
    let updates = null;
    try { updates = parseUpdates(await summarize(input, THREADS_PROMPT)); } catch (e) { console.warn('[threads] pass failed:', e && e.message); }
    if (!updates) return { ok: false, error: 'no answer' };
    const done = [];
    for (const u of updates) {
      const r = await upsert(u);
      if (r.ok && (r.created || r.changed || r.merged)) done.push(r.thread.title);
    }
    events = events.filter((e) => !ev.includes(e));
    save(false);
    return { ok: true, updated: done };
  }

  // ── what Claude sees ──
  function lineFor(t) {
    const st = t.status === 'waiting_on' && t.waitingOn ? `waiting on ${t.waitingOn}` : STATUS_WORDS[t.status];
    const l = latest(t);
    return `- [${t.id}] ${t.title} — ${st}${l ? `; latest (${dayLabel(l.when)}, ${l.source}): ${l.event}` : ''}`;
  }
  function renderForPrompt() {
    const open = threads.filter(isActive).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 15);
    const closed = threads.filter((t) => CLOSED.has(t.status) && now() - t.updatedAt <= CLOSED_IN_PROMPT_DAYS * DAY)
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12);
    if (!open.length && !closed.length) return '';
    return '\n\nTHREADS (what you and Fred are working on, with the CURRENT status; this beats anything older in the diary or memories):'
      + (open.length ? `\nOPEN:\n${open.map(lineFor).join('\n')}` : '\nOPEN: none')
      + (closed.length ? `\nRECENTLY CLOSED (finished or dropped: don't bring these up, don't suggest testing or redoing them):\n${closed.map((t) => `- ${t.title} — ${STATUS_WORDS[t.status]} ${dayLabel(t.updatedAt)}${t.statusNote ? ` (${t.statusNote})` : ''}`).join('\n')}` : '')
      + '\nWhen Fred says one is done, dropped, for later or waiting on someone, call memory.thread right away (his word wins). memory.threads finds older ones.';
  }

  // Threads (any status) that the current conversation is about, for this turn.
  async function relevant(text, limit = 3) {
    if (!String(text || '').trim() || !threads.length) return [];
    const scored = (await scoreAll(text)).filter((x) => (x.byMeaning ? x.sem >= RELEVANT() : x.words >= 0.6))
      .sort((a, b) => (b.sem - a.sem) || (b.words - a.words)).slice(0, limit);
    const at = now();
    for (const x of scored) x.t.lastMentionedAt = at;
    return scored.map((x) => ({ ...x.t }));
  }
  const renderRelevant = (list) => (list && list.length
    ? `Threads this is about (CURRENT status; reason from this, not from older memories):\n${list.map((t) => `${lineFor(t)}${t.history.length > 1 ? ` | steps: ${t.history.slice(-4).map((h) => `${dayLabel(h.when)} ${h.event}`).join(' → ')}` : ''}`).join('\n')}`
    : '');

  // memory.threads: by meaning and words, any status, with the steps.
  async function find(query, { limit = 6, includeClosed = true } = {}) {
    const pool = includeClosed ? threads : threads.filter(isActive);
    const q = String(query || '').trim();
    const scored = q
      ? (await scoreAll(q, pool)).filter((x) => (x.byMeaning ? x.sem >= FIND_MIN() : false) || x.words >= 0.34)
        .sort((a, b) => (b.sem + 0.2 * b.words) - (a.sem + 0.2 * a.words))
      : pool.map((t) => ({ t })).sort((a, b) => b.t.updatedAt - a.t.updatedAt);
    const out = scored.slice(0, Math.min(Math.max(Number(limit) || 6, 1), 20)).map(({ t }) => ({
      id: t.id, title: t.title, status: t.status, waiting_on: t.waitingOn || undefined, until: t.until || undefined,
      note: t.statusNote, people: t.people, projects: t.projects, updated: dayLabel(t.updatedAt),
      steps: t.history.slice(-8).map((h) => `${dayLabel(h.when)} (${h.source}): ${h.event}`),
    }));
    return { ok: true, count: out.length, threads: out, ...(out.length ? {} : { note: `no thread about "${q}"` }) };
  }

  // Is this (a nudge) about something already finished or dropped?
  async function isClosedTopic(text) {
    const closed = threads.filter((t) => CLOSED.has(t.status));
    if (!closed.length) return null;
    const scored = await scoreAll(text, closed);
    const hit = scored.find((x) => (x.byMeaning ? x.sem >= CLOSED_TOPIC() : x.words >= 0.75));
    return hit ? { ...hit.t } : null;
  }

  // Other side's threads: by id, the newer update wins.
  function merge(list) {
    let n = 0;
    for (const raw of Array.isArray(list) ? list : []) {
      const t = cleanThread(raw);
      if (!t) continue;
      const have = byId(t.id);
      if (!have) { threads.push(t); n += 1; }
      else if (t.updatedAt > have.updatedAt) { Object.assign(have, t); n += 1; }
    }
    if (n) save(false);
    return n;
  }

  load();
  return {
    upsert, observe, reconcile, renderForPrompt, relevant, renderRelevant, find, isClosedTopic, merge, match,
    all: () => threads.map((t) => ({ ...t })), get existed() { return existed; }, get size() { return threads.length; }, file,
  };
}

// Claude's tools (catalog channels threads:find / threads:update).
function registerThreads(ipcMain, store) {
  ipcMain.handle('threads:find', (_e, query, limit, includeClosed) => store.find(query, { limit, includeClosed: includeClosed !== false }));
  ipcMain.handle('threads:update', async (_e, thread, status, note, waitingOn, until) => {
    if (!thread) return { ok: false, error: 'say which thread' };
    if (status && !normStatus(status)) return { ok: false, error: `status must be one of ${STATUSES.join(', ')}` };
    // Fred is almost always talking about something already open: look there
    // first (a little more generous), then at everything, and only then create.
    const open = await store.match(thread, { min: 0.65, statuses: ['open', 'in_progress', 'waiting_on', 'snoozed'] });
    const r = await store.upsert({ title: thread, id: open ? open.id : thread, status, note, waiting_on: waitingOn, until, source: 'fred' }, { minMatch: 0.72 });
    return r.ok ? { ok: true, created: !!r.created, title: r.thread.title, status: r.thread.status } : r;
  });
}

module.exports = { createThreadStore, registerThreads, THREADS_PROMPT, parseUpdates, normStatus, STATUSES };
