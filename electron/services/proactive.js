// ─────────────────────────────────────────────────────────────────────────
// PROACTIVE — Hannibal starts the conversation when it matters.
//
// 1. MORNING BRIEF. Once a day, from HANNIBAL_BRIEF_TIME (default 08:00) until
//    HANNIBAL_BRIEF_UNTIL (default 12:00), Hannibal briefs Fred without being
//    asked: Claude checks the calendar, mail and reminders with its (read-only)
//    tools and speaks the few things that matter. The tick runs every minute,
//    so if the Mac was asleep at 08:00 the brief comes when it wakes (still
//    before noon). The renderer only delivers it at a quiet moment (not over
//    Fred, not while presence is muted/asleep) and reports back; the day is
//    marked done only after it was actually spoken. Off: HANNIBAL_BRIEF=0.
//
// 2. REMINDERS CLAUDE CAN SET. reminders.add / reminders.cancel give Claude
//    the same reminders the voice command uses (data/reminders.json, fired by
//    the renderer's existing tick), so "remind me Thursday to call Jay" works
//    in any phrasing. The renderer is told to reload after every change.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', '..', 'data');

// ── reminders ───────────────────────────────────────────────────────────────
function createReminderTools({ filePath = path.join(DATA, 'reminders.json'), notify = () => {}, now = () => Date.now() } = {}) {
  const read = () => {
    try { const j = JSON.parse(fs.readFileSync(filePath, 'utf8')); return Array.isArray(j.reminders) ? j.reminders : []; }
    catch (_) { return []; }
  };
  const write = (list) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ reminders: list }, null, 2));
    fs.renameSync(tmp, filePath);
    try { notify(); } catch (_) {}
  };
  const fmt = (ts) => {
    const d = new Date(ts);
    return d.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  };

  // `at`: local date-time "YYYY-MM-DDTHH:MM" (or any Date-parsable string).
  function add(message, at) {
    const msg = String(message || '').trim();
    if (!msg) return { ok: false, error: 'what should I remind Fred about?' };
    const ts = Date.parse(String(at || '').trim());
    if (!Number.isFinite(ts)) return { ok: false, error: `could not read the time "${at}" — use YYYY-MM-DDTHH:MM local time` };
    if (ts < now() - 60000) return { ok: false, error: `${fmt(ts)} is in the past` };
    const list = read();
    const r = { id: `r-${now()}-${Math.random().toString(36).slice(2, 6)}`, message: msg, triggerTs: ts, createdTs: now(), fired: false, by: 'claude' };
    list.push(r);
    write(list);
    return { ok: true, id: r.id, message: msg, when: fmt(ts) };
  }

  function cancel(query) {
    const q = String(query || '').toLowerCase().trim();
    if (!q) return { ok: false, error: 'which reminder?' };
    const list = read();
    const active = list.filter((r) => !r.fired);
    const hit = active.filter((r) => r.id.toLowerCase() === q || String(r.message || '').toLowerCase().includes(q));
    if (!hit.length) return { ok: false, error: `no active reminder matches "${query}"` };
    if (hit.length > 1 && !hit.some((r) => r.id.toLowerCase() === q)) {
      return { ok: false, error: `"${query}" matches ${hit.length} reminders — be more specific`, matches: hit.map((r) => ({ id: r.id, message: r.message, when: fmt(r.triggerTs) })) };
    }
    const gone = hit.length > 1 ? hit.filter((r) => r.id.toLowerCase() === q) : hit;
    write(list.filter((r) => !gone.includes(r)));
    return { ok: true, cancelled: gone.map((r) => ({ message: r.message, when: fmt(r.triggerTs) })) };
  }

  function upcoming() {
    return { ok: true, reminders: read().filter((r) => !r.fired).sort((a, b) => a.triggerTs - b.triggerTs)
      .map((r) => ({ id: r.id, message: r.message, when: fmt(r.triggerTs) })) };
  }

  // Reminders that are due now, marked fired so each goes out once.
  // (The desk fires its own in the renderer; the always-on server uses this.)
  function takeDue() {
    const list = read();
    const t = now();
    const due = list.filter((r) => !r.fired && Number(r.triggerTs) <= t);
    if (!due.length) return [];
    for (const r of due) { r.fired = true; r.firedTs = t; }
    write(list);
    return due.map((r) => ({ id: r.id, message: r.message, triggerTs: r.triggerTs }));
  }

  return { add, cancel, upcoming, takeDue };
}

// ── morning brief ───────────────────────────────────────────────────────────
const BRIEF_PROMPT = [
  '[Proactive — Fred did not ask; you are starting the conversation. Morning brief.]',
  "Good morning Fred with his morning brief. First check, with your tools: today's calendar (calendar.events),",
  'his inbox (mail.inbox) and upcoming reminders (reminders.upcoming). Then speak 3 to 5 short sentences:',
  'what his day looks like, any mail that needs him (who and why, not counts), and anything due.',
  'Use what you know from saved facts to judge what matters. Skip anything routine. If a service fails, just leave it out.',
  'This is read-only: do not send, change or delete anything. End by asking if he wants anything handled.',
].join(' ');

function parseHHMM(s, fallback) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  return { h: Math.min(23, +m[1]), m: Math.min(59, +m[2]) };
}
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function createBriefScheduler({ send, statePath = path.join(DATA, 'proactive.json'), now = () => new Date(), env = process.env } = {}) {
  let state = {};
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')) || {}; } catch (_) { state = {}; }
  const save = () => { try { fs.writeFileSync(statePath, JSON.stringify(state, null, 2)); } catch (_) {} };
  let inFlight = null;   // { day, since }

  const enabled = () => !/^(0|false|off|no)$/i.test(env.HANNIBAL_BRIEF || '');

  // Called every minute. Returns what it did (for tests/logs).
  function tick() {
    if (!enabled()) return 'disabled';
    const d = now();
    const from = parseHHMM(env.HANNIBAL_BRIEF_TIME, { h: 8, m: 0 });
    const until = parseHHMM(env.HANNIBAL_BRIEF_UNTIL, { h: 12, m: 0 });
    const mins = d.getHours() * 60 + d.getMinutes();
    if (mins < from.h * 60 + from.m || mins >= until.h * 60 + until.m) return 'outside-window';
    const day = dayKey(d);
    if (state.lastBrief === day) return 'done-today';
    if (inFlight && inFlight.day === day && d - inFlight.since < 15 * 60000) return 'waiting';
    inFlight = { day, since: d };
    send({ kind: 'morning-brief', day, prompt: BRIEF_PROMPT });
    return 'sent';
  }

  // The renderer reports back. Only a spoken brief marks the day as done.
  function done({ kind, day, ok } = {}) {
    if (kind !== 'morning-brief') return { ok: false };
    if (inFlight && inFlight.day === day) inFlight = null;
    if (ok) { state.lastBrief = day; save(); }
    return { ok: true };
  }

  return { tick, done, get state() { return state; }, BRIEF_PROMPT };
}

// Wire both into Electron main.
function registerProactive(ipcMain, { getWindow, onBrief, onReminder, statePath, remindersPath } = {}) {
  const toRenderer = (channel, payload) => {
    const w = getWindow && getWindow();
    try { w && !w.isDestroyed() && w.webContents.send(channel, payload); } catch (_) {}
  };
  const reminders = createReminderTools({ ...(remindersPath ? { filePath: remindersPath } : {}), notify: () => toRenderer('reminders:changed', {}) });
  ipcMain.handle('reminders:add', (_e, message, at) => reminders.add(message, at));
  ipcMain.handle('reminders:cancel', (_e, query) => reminders.cancel(query));
  ipcMain.handle('reminders:upcoming', () => reminders.upcoming());

  const brief = createBriefScheduler({ ...(statePath ? { statePath } : {}), send: (job) => { console.log('[proactive] morning brief due → renderer'); toRenderer('proactive:run', job); } });
  ipcMain.handle('proactive:done', (_e, r) => {
    const res = brief.done(r);
    // The brief that was spoken at the desk also goes to Fred's phone.
    if (r && r.ok && r.kind === 'morning-brief' && r.text && onBrief) { try { onBrief(String(r.text)); } catch (_) {} }
    return res;
  });
  // A reminder fired at the desk → also on the phone.
  ipcMain.handle('reminders:fired', (_e, message) => {
    if (onReminder && message) { try { onReminder(String(message)); } catch (_) {} }
    return { ok: true };
  });
  // First check shortly after launch (the window needs a moment), then every minute.
  const first = setTimeout(() => brief.tick(), 45000);
  const timer = setInterval(() => brief.tick(), 60000);
  return { reminders, brief, stop: () => { clearTimeout(first); clearInterval(timer); } };
}

module.exports = { createReminderTools, createBriefScheduler, registerProactive, BRIEF_PROMPT };
