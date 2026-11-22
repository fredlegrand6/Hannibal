// ─────────────────────────────────────────────────────────────────────────
// PROACTIVE — Hannibal starts the conversation when it matters.
//
// 1. MORNING BRIEF. Once a day, from HANNIBAL_BRIEF_TIME (default 08:00, local
//    time; never earlier), Hannibal briefs Fred without being
//    asked: Claude checks the calendar, mail and reminders with its (read-only)
//    tools and speaks the few things that matter. The tick runs every minute,
//    so if the Mac was off or asleep at 08:00 the brief comes once when it
//    wakes, later that day. The renderer only delivers it at a quiet moment (not over
//    Fred, not while presence is muted/asleep) and reports back; the day is
//    marked done on disk as soon as he starts speaking it, so a restart or a
//    page reload never repeats it. Off: HANNIBAL_BRIEF=0.
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
  // `link` (optional): the calendar event this reminder belongs to,
  // { eventId, eventUid, title, offsetMin } — moving or deleting that event
  // moves or cancels the reminder with it (createLinkedReminders below).
  function add(message, at, link) {
    const msg = String(message || '').trim();
    if (!msg) return { ok: false, error: 'what should I remind Fred about?' };
    const ts = Date.parse(String(at || '').trim());
    if (!Number.isFinite(ts)) return { ok: false, error: `could not read the time "${at}" — use YYYY-MM-DDTHH:MM local time` };
    if (ts < now() - 60000) return { ok: false, error: `${fmt(ts)} is in the past` };
    const list = read();
    const r = { id: `r-${now()}-${Math.random().toString(36).slice(2, 6)}`, message: msg, triggerTs: ts, createdTs: now(), fired: false, by: 'claude' };
    if (link && link.eventId) {
      r.event = { id: String(link.eventId), ...(link.eventUid ? { uid: String(link.eventUid) } : {}), ...(link.title ? { title: String(link.title) } : {}),
        offsetMin: Math.max(0, Math.round(Number(link.offsetMin) || 0)) };
    }
    list.push(r);
    write(list);
    // Check our own work: read the file back, the reminder must really be there.
    const verified = read().some((x) => x.id === r.id && !x.fired);
    return verified ? { ok: true, verified: true, id: r.id, message: msg, when: fmt(ts), ...(r.event ? { forEvent: r.event.title || true } : {}) }
      : { ok: false, verified: false, error: 'the reminder did not stick: it is not in the list after saving' };
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
    const left = read().filter((r) => gone.some((g) => g.id === r.id));
    if (left.length) return { ok: false, verified: false, error: 'the reminder is still in the list after cancelling it' };
    // A reminder that belongs to a calendar event: the event itself stays. Say
    // so, so "cancel my call with Jay" never ends with only the reminder gone.
    const ev = gone.find((r) => r.event);
    return { ok: true, verified: true, cancelled: gone.map((r) => ({ message: r.message, when: fmt(r.triggerTs) })),
      ...(ev ? { note: `This reminder belonged to the calendar event “${ev.event.title || ev.message}”, which is still in the calendar. If Fred meant to cancel the event itself, use calendar.delete.` } : {}) };
  }

  function upcoming() {
    return { ok: true, reminders: read().filter((r) => !r.fired).sort((a, b) => a.triggerTs - b.triggerTs)
      .map((r) => ({ id: r.id, message: r.message, when: fmt(r.triggerTs), triggerTs: r.triggerTs,
        ...(r.event ? { eventId: r.event.id, ...(r.event.uid ? { eventUid: r.event.uid } : {}), offsetMin: r.event.offsetMin, forEvent: r.event.title || '' } : {}) })) };
  }

  // The active (not fired, not cancelled) reminders linked to one event.
  function forEvent(eventId, eventUid) {
    return read().filter((r) => !r.fired && r.event && sameEvent(r.event, eventId, eventUid))
      .map((r) => ({ id: r.id, message: r.message, triggerTs: r.triggerTs, offsetMin: r.event.offsetMin || 0, when: fmt(r.triggerTs) }));
  }
  // Give one reminder a new time (its event moved). Read back to check.
  function retime(id, ts) {
    const list = read();
    const r = list.find((x) => x.id === id && !x.fired);
    if (!r) return { ok: false, error: 'that reminder is not active any more' };
    r.triggerTs = Number(ts);
    write(list);
    const back = read().find((x) => x.id === id);
    return back && back.triggerTs === Number(ts) && !back.fired ? { ok: true, verified: true, id, when: fmt(ts) }
      : { ok: false, verified: false, error: 'the reminder still shows its old time' };
  }

  // What happened to reminders lately, so Hannibal can check his own work:
  // the ones that went off (and when), and any that are overdue and did NOT.
  function recent(hours = 48) {
    const t = now(); const since = t - Math.max(1, Number(hours) || 48) * 3600000;
    const list = read();
    const firedAt = (r) => Number(r.firedTs || r.firedAt || 0);
    const lately = list.filter((r) => r.fired && (firedAt(r) || Number(r.triggerTs)) >= since).sort((a, b) => firedAt(b) - firedAt(a));
    // delivered === false: it was due, but sending it to Fred failed. Not "went off".
    const went = lately.filter((r) => r.delivered !== false)
      .map((r) => ({ id: r.id, message: r.message, due: fmt(r.triggerTs), wentOff: firedAt(r) ? fmt(firedAt(r)) : 'yes (time not recorded)' }));
    const missed = [
      ...list.filter((r) => !r.fired && Number(r.triggerTs) < t - 5 * 60000)
        .map((r) => ({ id: r.id, message: r.message, due: fmt(r.triggerTs), why: 'never fired' })),
      ...lately.filter((r) => r.delivered === false)
        .map((r) => ({ id: r.id, message: r.message, due: fmt(r.triggerTs), why: `sending it failed${r.deliveryError ? ': ' + r.deliveryError : ''}` })),
    ];
    return { ok: true, wentOff: went, missed };
  }

  // The server tells us whether a fired reminder actually reached Fred.
  function markDelivered(id, ok, error) {
    const list = read();
    const r = list.find((x) => x.id === id);
    if (!r) return;
    r.delivered = !!ok;
    if (!ok) r.deliveryError = String(error || '').slice(0, 200); else delete r.deliveryError;
    write(list);
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

  return { add, cancel, upcoming, recent, takeDue, markDelivered, forEvent, retime };
}

// Two ids for the same calendar event: its address (href or full URL) or its UID.
function eventPath(id) {
  try { return decodeURIComponent(new URL(String(id || ''), 'https://x.invalid').pathname).replace(/\/+$/, ''); }
  catch (_) { return String(id || ''); }
}
function sameEvent(link, eventId, eventUid) {
  if (!link) return false;
  if (eventId && link.id && eventPath(link.id) === eventPath(eventId)) return true;
  return !!(eventUid && link.uid && String(link.uid) === String(eventUid));
}

// ── reminders linked to calendar events ─────────────────────────────────────
// Fred's brief (22 Nov): a booking can carry a reminder (e.g. 15 min before);
// moving the event moves the reminder, deleting the event cancels it, and a
// reminder that already fired or was cancelled is never mentioned again.
// A reminder lives on the side that booked it (desk or server); `remote` is the
// other side, when it is reachable: { list() → upcoming reminders, cancel(id),
// retime?(id, ts) }. Everything is read back before it is reported.
function createLinkedReminders({ local, remote = null, now = () => Date.now() } = {}) {
  async function remoteFor(eventId, eventUid) {
    if (!remote) return [];
    try {
      const list = (await remote.list()) || [];
      return list.filter((r) => r.eventId && sameEvent({ id: r.eventId, uid: r.eventUid }, eventId, eventUid))
        .map((r) => ({ id: r.id, message: r.message, triggerTs: Number(r.triggerTs), offsetMin: Number(r.offsetMin) || 0, when: r.when, there: true }));
    } catch (_) { return []; }
  }
  async function forEvent(eventId, eventUid) {
    return [...local.forEvent(eventId, eventUid), ...(await remoteFor(eventId, eventUid))];
  }
  function add(message, at, link) { return local.add(message, at, link); }
  // The event now starts at newStartMs: each linked reminder keeps its offset.
  // One that would now be in the past is dropped (said once, not fired late).
  // Answers carry times (ms), so the caller can say them on Fred's own clock.
  async function moveForEvent(eventId, newStartMs, { eventUid, title } = {}) {
    const out = { moved: [], dropped: [], failed: [] };
    for (const r of await forEvent(eventId, eventUid)) {
      const ts = Number(newStartMs) - (r.offsetMin || 0) * 60000;
      if (!Number.isFinite(ts)) { out.failed.push(r.triggerTs); continue; }
      try {
        if (ts <= now()) {
          const c = r.there ? await remote.cancel(r.id) : local.cancel(r.id);
          (c && c.ok ? out.dropped : out.failed).push(r.triggerTs);
          continue;
        }
        let res;
        if (!r.there) res = local.retime(r.id, ts);
        else if (remote.retime) res = await remote.retime(r.id, ts);
        else {        // the other side cannot change it: take it over here
          const c = await remote.cancel(r.id);
          res = c && c.ok ? local.add(r.message, new Date(ts).toISOString(), { eventId, eventUid, title, offsetMin: r.offsetMin }) : c;
        }
        (res && res.ok ? out.moved : out.failed).push(ts);
      } catch (_) { out.failed.push(ts); }
    }
    return out;
  }
  async function cancelForEvent(eventId, { eventUid } = {}) {
    const out = { cancelled: [], failed: [] };
    for (const r of await forEvent(eventId, eventUid)) {
      try {
        const c = r.there ? await remote.cancel(r.id) : local.cancel(r.id);
        (c && c.ok ? out.cancelled : out.failed).push(r.triggerTs);
      } catch (_) { out.failed.push(r.triggerTs); }
    }
    // Check: none of them may still be active.
    const left = await forEvent(eventId, eventUid);
    if (left.length && !out.failed.length) out.failed.push(...left.map((r) => r.triggerTs));
    return out;
  }
  // Every active linked reminder (to show next to its event in calendar.events).
  async function all() {
    const mine = local.upcoming().reminders.filter((r) => r.eventId);
    let theirs = [];
    if (remote) { try { theirs = ((await remote.list()) || []).filter((r) => r.eventId); } catch (_) {} }
    return [...mine, ...theirs];
  }
  return { forEvent, add, moveForEvent, cancelForEvent, all };
}

// ── notes ───────────────────────────────────────────────────────────────────
// The same data/notes.json the voice "note that…" command uses. Claude can add,
// find and remove notes one at a time (never replace the whole list), and every
// change is read back before it is reported.
function createNoteTools({ filePath = path.join(DATA, 'notes.json'), notify = () => {}, now = () => Date.now() } = {}) {
  const read = () => {
    try { const j = JSON.parse(fs.readFileSync(filePath, 'utf8')); return Array.isArray(j.notes) ? j.notes : []; }
    catch (_) { return []; }
  };
  const write = (list) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ notes: list }, null, 2));
    fs.renameSync(tmp, filePath);
    try { notify(); } catch (_) {}
  };
  const when = (ts) => new Date(ts).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const show = (n) => ({ id: n.id, text: n.text, when: when(n.ts) });

  function add(text) {
    const t = String(text || '').trim();
    if (!t) return { ok: false, error: 'what should the note say?' };
    const n = { id: `n-${now()}-${Math.random().toString(36).slice(2, 6)}`, text: t.slice(0, 4000), ts: now(), by: 'claude' };
    const list = read(); list.push(n); write(list);
    return read().some((x) => x.id === n.id) ? { ok: true, verified: true, ...show(n) }
      : { ok: false, verified: false, error: 'the note did not stick: it is not in the list after saving' };
  }

  // Newest first; with a query only the notes that contain it.
  function find(query, limit = 20) {
    const q = String(query || '').toLowerCase().trim();
    const hits = read().filter((n) => !q || String(n.text || '').toLowerCase().includes(q)).sort((a, b) => b.ts - a.ts);
    return { ok: true, total: hits.length, notes: hits.slice(0, Math.min(Number(limit) || 20, 100)).map(show) };
  }

  function remove(query) {
    const q = String(query || '').toLowerCase().trim();
    if (!q) return { ok: false, error: 'which note?' };
    const list = read();
    const exact = list.filter((n) => String(n.id).toLowerCase() === q);
    const hit = exact.length ? exact : list.filter((n) => String(n.text || '').toLowerCase().includes(q));
    if (!hit.length) return { ok: false, error: `no note matches "${query}"` };
    if (hit.length > 1) return { ok: false, error: `"${query}" matches ${hit.length} notes: be more specific or use the id`, matches: hit.map(show) };
    write(list.filter((n) => n !== hit[0]));
    if (read().some((n) => n.id === hit[0].id)) return { ok: false, verified: false, error: 'the note is still there after removing it' };
    return { ok: true, verified: true, removed: show(hit[0]) };
  }

  return { add, find, remove };
}

// Cancel across two lists (the server's own + the desk's, read through the
// link) without touching either until it is clear which ONE is meant: one
// match is cancelled where it lives; several (across both) are handed back.
async function cancelAcross({ local, remote = [], cancelRemote, query }) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return local.cancel(query);
  const hit = (list) => list.filter((r) => String(r.id).toLowerCase() === q || String(r.message || '').toLowerCase().includes(q));
  const here = hit(local.upcoming().reminders);
  const there = hit(remote);
  const all = [...here, ...there];
  const exact = all.filter((r) => String(r.id).toLowerCase() === q);
  const pick = exact.length === 1 ? exact : all;
  if (!pick.length) return { ok: false, error: `no active reminder matches "${query}"` };
  if (pick.length > 1) {
    return { ok: false, error: `"${query}" matches ${pick.length} reminders — be more specific`,
      matches: pick.map((r) => ({ id: r.id, message: r.message, when: r.when, ...(there.includes(r) ? { set: 'at the desk' } : {}) })) };
  }
  const one = pick[0];
  if (here.includes(one)) return local.cancel(one.id);
  try { return await cancelRemote(one.id); }
  catch (e) { return { ok: false, error: `could not reach the Mac to cancel it: ${e.message}` }; }
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
  // Rules (Fred, 22 Nov): once per calendar day, never before 08:00 local; if
  // the Mac was off at 08:00 it comes once when he starts later that day; a
  // restart or a page reload never brings a second one. The day is written to
  // disk (data/proactive.json, lastBrief) the moment he starts speaking it.
  function tick() {
    if (!enabled()) return 'disabled';
    const d = now();
    const from = parseHHMM(env.HANNIBAL_BRIEF_TIME, { h: 8, m: 0 });
    const until = parseHHMM(env.HANNIBAL_BRIEF_UNTIL, { h: 23, m: 59 });
    const mins = d.getHours() * 60 + d.getMinutes();
    if (mins < from.h * 60 + from.m) return 'too-early';
    if (mins >= until.h * 60 + until.m) return 'outside-window';
    const day = dayKey(d);
    if (state.lastBrief === day) return 'done-today';
    // Handed to the page and not spoken yet (waiting for a quiet moment):
    // don't send a second copy. Re-sent only if the page lost it.
    if (inFlight && inFlight.day === day && d - inFlight.since < 15 * 60000) return 'waiting';
    inFlight = { day, since: d };
    send({ kind: 'morning-brief', day, prompt: BRIEF_PROMPT });
    return 'sent';
  }

  const markDone = (day) => {
    if (state.lastBrief === day) return;
    state.lastBrief = day;
    delete state.briefTries;
    save();
    console.log(`[proactive] morning brief for ${day} counted (saved to disk)`);
  };

  // The renderer reports back. `started`: he began speaking it, so the day is
  // done right then, even if a restart, a crash or Fred cuts it short.
  function done({ kind, day, ok, started } = {}) {
    if (kind !== 'morning-brief' || !day) return { ok: false };
    // A failed or undelivered one is tried again after 15 minutes (inFlight
    // stays), not every minute.
    if (started || ok) markDone(day);
    return { ok: true };
  }

  return { tick, done, get state() { return state; }, BRIEF_PROMPT };
}

// Wire both into Electron main.
let registered = null;   // one scheduler per app run, never two timers
function registerProactive(ipcMain, { getWindow, onBrief, onReminder, onNudgeDone, banner, statePath, remindersPath, notesPath } = {}) {
  if (registered) { console.warn('[proactive] already running, not starting a second scheduler'); return registered; }
  const toRenderer = (channel, payload) => {
    const w = getWindow && getWindow();
    try { w && !w.isDestroyed() && w.webContents.send(channel, payload); } catch (_) {}
  };
  const reminders = createReminderTools({ ...(remindersPath ? { filePath: remindersPath } : {}), notify: () => toRenderer('reminders:changed', {}) });
  ipcMain.handle('reminders:add', (_e, message, at) => reminders.add(message, at));
  ipcMain.handle('reminders:cancel', (_e, query) => reminders.cancel(query));
  ipcMain.handle('reminders:upcoming', () => reminders.upcoming());
  ipcMain.handle('reminders:recent', (_e, hours) => reminders.recent(hours));
  const notes = createNoteTools({ ...(notesPath ? { filePath: notesPath } : {}), notify: () => toRenderer('notes:changed', {}) });
  ipcMain.handle('notes:add', (_e, text) => notes.add(text));
  ipcMain.handle('notes:find', (_e, query, limit) => notes.find(query, limit));
  ipcMain.handle('notes:remove', (_e, query) => notes.remove(query));

  const brief = createBriefScheduler({ ...(statePath ? { statePath } : {}), send: (job) => { console.log('[proactive] morning brief due → renderer'); toRenderer('proactive:run', job); } });
  ipcMain.handle('proactive:done', (_e, r) => {
    if (r && r.kind === 'nudge') { try { onNudgeDone && onNudgeDone(r); } catch (_) {} return { ok: true }; }
    const res = brief.done(r);
    // The brief that was spoken at the desk also goes to Fred's phone.
    if (r && r.ok && r.kind === 'morning-brief' && r.text && onBrief) { try { onBrief(String(r.text)); } catch (_) {} }
    return res;
  });
  // Old page builds told main when they fired one; main fires them itself now.
  ipcMain.handle('reminders:fired', () => ({ ok: true }));
  // Reminders fire HERE, in the main process, on a clock of their own. They
  // used to fire in the page only when Hannibal was at rest, and with the mic
  // always open that moment could fail to come for days (one due 18 Nov was
  // still waiting on 22 Nov). Now each due reminder goes out at once as a Mac
  // banner and to Fred's phone, and the page speaks it at the next chance.
  const fireDue = createReminderFirer({ reminders, toRenderer, onReminder, banner });
  const firstFire = setTimeout(fireDue, 15000);
  const fireTimer = setInterval(fireDue, 20000);
  // First check shortly after launch (the window needs a moment), then every minute.
  const first = setTimeout(() => brief.tick(), 45000);
  const timer = setInterval(() => brief.tick(), 60000);
  registered = { reminders, brief, fireDue, stop: () => { clearTimeout(first); clearInterval(timer); clearTimeout(firstFire); clearInterval(fireTimer); registered = null; } };
  return registered;
}

// Takes every due reminder once and sends it out: Mac banner, phone, voice.
// One missed by hours (the Mac was asleep or off) still goes out, marked late.
function createReminderFirer({ reminders, toRenderer = () => {}, onReminder = null, banner = null, now = () => Date.now() }) {
  return function fireDue() {
    let due = [];
    try { due = reminders.takeDue(); } catch (e) { console.warn('[reminder] check failed:', e.message); return []; }
    for (const r of due) {
      const lateMin = Math.round((now() - Number(r.triggerTs)) / 60000);
      const late = lateMin >= 30 ? ` (this was due ${new Date(Number(r.triggerTs)).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}, I missed it)` : '';
      const message = `${r.message}${late}`;
      console.log(`[reminder] fired: ${r.message}${late ? ` — ${lateMin} min late` : ''}`);
      try { banner && banner('Hannibal reminder', message); } catch (_) {}
      toRenderer('reminders:due', { id: r.id, message });
      if (onReminder) {
        Promise.resolve().then(() => onReminder(message))
          .then((res) => { if (res !== undefined) reminders.markDelivered(r.id, res !== false); })
          .catch((e) => { console.warn('[reminder] could not reach the phone:', e.message); reminders.markDelivered(r.id, false, e.message); });
      }
    }
    return due;
  };
}

module.exports = { createReminderTools, createLinkedReminders, sameEvent, createNoteTools, createBriefScheduler, registerProactive, createReminderFirer, cancelAcross, BRIEF_PROMPT };
