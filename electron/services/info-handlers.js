// ─────────────────────────────────────────────────────────────────────────
// INFO HANDLERS — the read tools that need no Mac: GEX131 health, calendar
// (Apple Calendar over CalDAV, see caldav.js), mail (Zoho IMAP via the Python scripts next to this file)
// and the web (SearXNG search + page fetch). Registered by the desk app
// (electron/main.js) and by the always-on server (server/hannibal-server.js).
//   opts: { python, searxngUrl, metricsLocal }
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { createCalendarAccount } = require('./caldav');
const assist = require('./calendar-assist');

function registerInfo(ipcMain, opts = {}) {
  const calendarAccount = opts.calendarAccount || createCalendarAccount();
  // Reminders linked to events (proactive.js createLinkedReminders), when this
  // side has them: an object, or a function that returns one (wired later).
  const linkedReminders = () => { try { return typeof opts.reminders === 'function' ? opts.reminders() : opts.reminders || null; } catch (_) { return null; } };
  const tz = () => assist.fredTz(opts.env || process.env);
  const nowFn = opts.now || (() => Date.now());   // tests pin the clock
// ── SYSTEM METRICS: ssh to GEX131, return a raw snapshot for the right-rail gauges.
// One ssh round-trip returns four @@-delimited sections. CPU% and NET rate are
// computed in the renderer from deltas between polls (cumulative counters here).
// nvidia-smi is attempted but the box's NVIDIA driver isn't currently loaded
// (Ollama is running on CPU), so gpu comes back null and the renderer shows it
// OFFLINE — the moment the driver is up, the same handler lights the GPU gauges. ──
const GEX131_SSH = process.env.GEX131_SSH_HOST || 'GEX131';
const METRICS_SCRIPT = [
  'nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>/dev/null || echo GPU_NA',
  'echo @@MEM; free -b | awk "/Mem:/{print \\$3, \\$2}"',
  'echo @@CPU; awk "/^cpu /{b=\\$2+\\$3+\\$4+\\$7+\\$8; print b, b+\\$5+\\$6}" /proc/stat',
  'echo @@NET; awk -F"[: ]+" "NR>2 && \\$2!=\\"lo\\"{rx+=\\$3; tx+=\\$11} END{print rx, tx}" /proc/net/dev',
  'echo @@UP; awk "{print int(\\$1)}" /proc/uptime',
].join('; ');

ipcMain.handle('system:metrics', async () => {
  try {
    const out = await new Promise((resolve, reject) => {
      // On the server itself the metrics are read locally; from the Mac, over ssh.
      const p = opts.metricsLocal
        ? spawn('bash', ['-c', METRICS_SCRIPT], { env: process.env })
        : spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', GEX131_SSH, METRICS_SCRIPT],
        { env: process.env });
      let so = '', se = '';
      p.stdout.on('data', (d) => { so += d; });
      p.stderr.on('data', (d) => { se += d; });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve(so) : reject(new Error(se || `ssh exit ${code}`))));
    });
    const [gpuRaw = '', memRaw = '', cpuRaw = '', netRaw = '', upRaw = ''] = out.split(/@@MEM|@@CPU|@@NET|@@UP/);
    const nums = (s) => s.trim().split(/[\s,]+/).map(Number);

    let gpu = null;
    if (!/GPU_NA/.test(gpuRaw) && gpuRaw.trim()) {
      const [util, vu, vt, temp] = nums(gpuRaw);
      if (Number.isFinite(util) && Number.isFinite(vt) && vt > 0) gpu = { util, vramUsedMB: vu, vramTotalMB: vt, temp };
    }
    const [memUsed, memTotal] = nums(memRaw);
    const [cpuBusy, cpuTotal] = nums(cpuRaw);
    const [netRx, netTx] = nums(netRaw);
    const [uptimeSec] = nums(upRaw);
    return { ok: true, ts: Date.now(), gpu,
      mem: { used: memUsed, total: memTotal },
      cpu: { busy: cpuBusy, total: cpuTotal },
      net: { rx: netRx, tx: netTx },
      uptime: Number.isFinite(uptimeSec) ? uptimeSec : null };
  } catch (e) {
    console.log('[metrics] ssh failed', e.message);
    return { ok: false, error: e.message };
  }
});

// ── CALENDAR: fetch events from Apple Calendar (or Nextcloud) over CalDAV. One
// REPORT (calendar-query) with a time-range filter returns matching VEVENTs as
// raw iCalendar, which we unfold + parse minimally (DTSTART/SUMMARY). Creds live
// in .env as an app password (never the main account password). ──
function parseICalEvents(xml, now, tz = assist.fredTz()) {
  const unesc = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&#13;|&#x0?d;/gi, '\r').replace(/&#10;|&#x0?a;/gi, '\n').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const events = [];
  // pull each <...calendar-data>…</…calendar-data> block regardless of ns prefix
  const blocks = xml.match(/<[^>]*calendar-data[^>]*>([\s\S]*?)<\/[^>]*calendar-data>/g) || [];
  for (let raw of blocks) {
    const ics = unesc(raw.replace(/<[^>]*calendar-data[^>]*>/, '').replace(/<\/[^>]*calendar-data>/, ''))
      .replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');  // unfold continuation lines
    for (const vevent of ics.split('BEGIN:VEVENT').slice(1)) {
      const body = vevent.split('END:VEVENT')[0];
      const uid = ((body.match(/(?:^|\n)UID[^:\n]*:(.*)/) || [])[1] || '').trim();
      const summary = (body.match(/\nSUMMARY[^:]*:(.*)/) || body.match(/^SUMMARY[^:]*:(.*)/) || [])[1];
      const dtLine = (body.match(/DTSTART([^:\n]*):([0-9TZ]+)/) || []);
      if (!dtLine[2]) continue;
      const params = dtLine[1] || '', v = dtLine[2];
      const allDay = /VALUE=DATE\b/.test(params) || /^\d{8}$/.test(v);
      // Every time is placed in Fred's own time zone (Bussum / Ibiza), whatever
      // zone the machine runs in: UTC, a TZID of the event's own, or floating.
      const instant = (prm, val) => {
        if (/^\d{8}$/.test(val)) return assist.wallMs(+val.slice(0, 4), +val.slice(4, 6), +val.slice(6, 8), 0, 0, tz);
        if (/Z$/.test(val) || /TZID=/.test(prm)) { const i = lineInstant(`X${prm}:${val}`); if (i && i.ms != null) return i.ms; }
        return assist.wallMs(+val.slice(0, 4), +val.slice(4, 6), +val.slice(6, 8), +val.slice(9, 11), +val.slice(11, 13), tz);
      };
      const ms = instant(params, v);
      const when = new Date(ms);
      const time = allDay ? 'All day' : assist.fmtTime(ms, tz);
      // Its end (DTEND or DURATION), for the clash check.
      const endLine = body.match(/(?:^|\n)DTEND([^:\n]*):([0-9TZ]+)/);
      const durLine = (body.match(/(?:^|\n)DURATION[^:\n]*:P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/) || null);
      let endTs = endLine ? instant(endLine[1] || '', endLine[2]) : null;
      if (endTs == null && durLine) endTs = ms + ((+durLine[1] || 0) * 7 * 1440 + (+durLine[2] || 0) * 1440 + (+durLine[3] || 0) * 60 + (+durLine[4] || 0)) * 60000;
      // A repeat of a recurring event (the server expanded it): keep which one it
      // is, so delete/move can change just this one.
      const rid = ((body.match(/(?:^|\n)RECURRENCE-ID[^:\n]*:([0-9TZ]+)/) || [])[1] || '').trim();
      events.push({ ts: when.getTime(), ...(endTs > when.getTime() ? { endTs } : {}), time, allDay, title: unesc2((summary || '(no title)').trim()), ...(uid ? { uid } : {}), ...(rid ? { repeats: true, occurrence: rid } : {}) });
    }
  }
  const today = assist.dayOf(now.getTime(), tz);
  const dayN = (ts) => Math.round((Date.UTC(...ymd(assist.dayOf(ts, tz))) - Date.UTC(...ymd(today))) / 864e5);
  return events
    // drop past timed events (30m grace), but keep one still going (for the clash check)
    .filter((e) => e.allDay || e.ts >= now.getTime() - 30 * 60 * 1000 || (e.endTs && e.endTs > now.getTime()))
    .sort((a, b) => a.ts - b.ts)
    .map((e) => {
      const n = dayN(e.ts);
      const day = n <= 0 ? 'today' : n === 1 ? 'tomorrow' : assist.fmtDate(assist.dayOf(e.ts, tz));
      return { ...e, day };
    });
}
const ymd = (d) => [d.y, d.mo - 1, d.d];
const unesc2 = (t) => String(t).replace(/\\([,;\\])/g, '$1').replace(/\\n/gi, ' ');

// Events from today through `days` days ahead (default 2 = today + tomorrow, max 31),
// from every calendar of the account (Apple Calendar: Home, Work, shared...).
// <c:expand> makes the server hand back each repeat of a recurring event.
async function fetchCalendar(days) {
  const a = await calendarAccount.get();
  if (a.error) return { ok: false, error: a.error };
  const n = Math.min(Math.max(Math.round(Number(days) || 2), 1), 31);
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const now = new Date(nowFn());
  const t0 = assist.dayOf(now.getTime(), tz()); const t1 = assist.addDays(t0, n);
  const start = new Date(assist.wallMs(t0.y, t0.mo, t0.d, 0, 0, tz()));
  const end = new Date(assist.wallMs(t1.y, t1.mo, t1.d, 0, 0, tz()));
  const range = `start="${fmt(start)}" end="${fmt(end)}"`;
  const body = `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data><c:expand ${range}/></c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range ${range}/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  const one = async (cal) => {
    const res = await fetch(cal.url, {
      method: 'REPORT',
      headers: { Authorization: a.auth, Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body, signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401) { calendarAccount.forget(); throw new Error('the calendar login was refused (check the app-specific password)'); }
    if (!res.ok && res.status !== 207) throw new Error(`caldav ${res.status} on ${cal.name}`);
    // One <response> per stored event: keep its address, so delete/move can reach it.
    const xml = await res.text();
    return String(xml).split(/<(?:[a-z0-9]+:)?response[\s>]/i).slice(1).flatMap((block) => {
      const href = ((block.match(/<(?:[a-z0-9]+:)?href[^>]*>([\s\S]*?)<\//i) || [])[1] || '').trim();
      return parseICalEvents(block, now, tz()).map((e) => ({ ...e, calendar: cal.name, ...(href ? { href } : {}) }));
    });
  };
  const got = await Promise.allSettled(a.read.map(one));
  const events = got.filter((g) => g.status === 'fulfilled').flatMap((g) => g.value);
  const failed = got.filter((g) => g.status === 'rejected').map((g) => g.reason && g.reason.message);
  if (failed.length === got.length) {     // every calendar failed; one odd one (iCloud's read-only "notification" list answers 403) is fine
    console.log('[calendar] caldav failed', failed.join('; '));
    return { ok: false, error: failed[0] };
  }
  // The same event can sit in two calendars (an invite copied over, same UID): keep one.
  // Different events that only share a title and time both stay.
  const seen = new Set();
  const list = events.sort((x, y) => x.ts - y.ts).filter((e) => {
    if (!e.uid) return true;
    const k = `${e.uid}|${e.ts}`; if (seen.has(k)) return false; seen.add(k); return true;
  }).map(({ uid, href, ...e }) => (href ? { ...e, id: href, ...(uid ? { uid } : {}) } : e));
  if (failed.length) console.log('[calendar] skipped:', failed.join('; '));
  // Each event's own reminder, when Hannibal set one with it and it is still
  // to come. A reminder that fired or was cancelled is not shown at all.
  const lr = linkedReminders();
  if (lr && lr.all) {
    try {
      const rems = await lr.all();
      const { sameEvent } = require('./proactive');
      for (const e of list) {
        const mine = rems.filter((r) => sameEvent({ id: r.eventId, uid: r.eventUid }, e.id, e.uid));
        if (mine.length) e.reminder = mine.map((r) => assist.fmtTime(Number(r.triggerTs), tz())).join(', ');
      }
    } catch (_) {}
  }
  return { ok: true, events: list };
}
ipcMain.handle('calendar:events', (_e, days) => fetchCalendar(days));

// Book an event. Only ever reached after Fred's yes (catalog: confirm, ceiling 'never').
// start: local "YYYY-MM-DDTHH:MM" (or "YYYY-MM-DD" for all day) in Fred's time zone.
// calendar: the calendar Fred named; default "Werk" (calendar-assist pickCalendar).
// remind_minutes: a reminder that many minutes before, linked to the event.
// Done only when it reads back from iCloud exactly as booked (verified true).
ipcMain.handle('calendar:add', async (_e, title, start, minutes, location, notes, calendar, remindMinutes) => {
  const a = await calendarAccount.get();
  if (a.error) return { ok: false, error: a.error };
  const picked = assist.pickCalendar(a, calendar, { env: opts.env || process.env });
  if (picked.error) return { ok: false, error: picked.error };
  const cal = picked.calendar;
  const ev = buildEvent({ title, start, minutes, location, notes, tz: tz(), now: nowFn() });
  if (!ev.ok) return ev;
  const url = `${cal.url.replace(/\/?$/, '/')}${ev.uid}.ics`;
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: a.auth, 'Content-Type': 'text/calendar; charset=utf-8', 'If-None-Match': '*' },
      body: ev.ics, signal: AbortSignal.timeout(10000),
    });
    if (res.status === 401) calendarAccount.forget();
    if (!res.ok) return { ok: false, verified: false, error: `caldav ${res.status}` };
    const back = await readBack(a, url);
    if (back === undefined) return { ok: false, verified: false, could_not_check: true, error: `iCloud took the booking of "${ev.title}" but I could not read it back to check it. It may well be there: do NOT book it again; look with calendar.events first.` };
    if (back === null || back.uid !== ev.uid) return { ok: false, verified: false, error: 'the calendar accepted the booking but it is not there when I look again' };
    if (timesOf(back.ics) !== timesOf(ev.ics) || !sameTitle(back.title, ev.title)) return { ok: false, verified: false, error: `"${ev.title}" is in the calendar, but not with the time or title I booked: check it in the Calendar app` };
    console.log(`[calendar] booked "${ev.title}" ${ev.when} in ${cal.name} (checked)`);
    const out = { ok: true, verified: true, id: new URL(url).pathname, title: ev.title, when: ev.when, calendar: cal.name };
    // The reminder that goes with it (linked, so a move or delete takes it along).
    const mins = Math.round(Number(remindMinutes) || 0);
    if (mins > 0 && ev.startMs) {
      const lr = linkedReminders();
      const r = lr ? await Promise.resolve(lr.add(ev.title, new Date(ev.startMs - mins * 60000).toISOString(), { eventId: out.id, eventUid: ev.uid, title: ev.title, offsetMin: mins })).catch((e) => ({ ok: false, error: e.message })) : { ok: false, error: 'reminders are not available here' };
      if (r && r.ok && r.verified !== false) out.reminder = `${assist.fmtTime(ev.startMs - mins * 60000, tz())} (${mins} minutes before)`;
      else out.reminder_failed = `the event is booked, but its reminder did not stick${r && r.error ? `: ${r.error}` : ''}. Tell Fred.`;
    }
    out.done = `Booked “${ev.title}” ${ev.when} in ${cal.name}${out.reminder ? `, reminder at ${out.reminder}` : ''} (checked in the calendar)`;
    return out;
  } catch (e) {
    return { ok: false, verified: false, error: e.message };
  }
});

// ── DELETE / MOVE an existing event. Only ever reached after Fred's yes (catalog:
// confirm, ceiling 'never'). The event is found by its id (the UID that
// calendar.events returns) and must carry the title Claude named in the
// question Fred said yes to, so a mixed-up id can never touch another event.
// Repeating events are left alone: changing one would change the whole series.
// The id is the event's address in the calendar (what calendar.events returns).
// It must sit inside one of Fred's own calendars; the stored event is read back
// fresh (with its ETag) so a change made meanwhile is never overwritten.
// Check our own work: read the event back from the calendar after a change.
// Returns the stored event (describeIcs) or null when it is not there (404).
// undefined = could not check (network), which is reported as "not verified".
async function readBack(a, url) {
  try {
    const res = await fetch(url, { headers: { Authorization: a.auth }, signal: AbortSignal.timeout(10000) });
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) return undefined;
    return describeIcs(await res.text());
  } catch (_) { return undefined; }
}
// The event's own times (start + end/duration), from its top-level VEVENT only:
// a VTIMEZONE or VALARM block has DTSTARTs of its own that must not count.
const timesOf = (ics) => {
  const lines = String(ics || '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const out = {}; let depth = 0, inEvent = false;
  for (const l of lines) {
    if (l === 'BEGIN:VEVENT' && depth === 1) inEvent = true;   // inside VCALENDAR
    if (/^BEGIN:/.test(l)) { depth += 1; continue; }
    if (/^END:/.test(l)) { depth -= 1; if (inEvent && depth === 1) break; continue; }
    if (!inEvent || depth !== 2) continue;
    const m = l.match(/^(DTSTART|DTEND|DURATION)[;:]/);
    if (m) out[m[1]] = l.replace(/^[^:]*:/, '').trim();
  }
  return `${out.DTSTART || ''}|${out.DTEND || ''}|${out.DURATION || ''}`;
};

async function findEvent(a, id) {
  const cal = a.read.find((c) => { try { return new URL(id, c.url).toString().startsWith(c.url); } catch (_) { return false; } });
  if (!cal) return null;
  const url = new URL(id, cal.url).toString();
  try {
    const res = await fetch(url, { headers: { Authorization: a.auth }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const ev = describeIcs(await res.text());
    return ev.uid ? { ...ev, etag: res.headers.get('etag'), cal, url } : null;
  } catch (_) { return null; }
}
const sameTitle = (a, b) => {
  const n = (x) => String(x || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  // Whole title only: "Call with Jay" must never authorize "Call with Jay and legal".
  return !!n(a) && n(a) === n(b);
};
async function locate(id, title, { scope } = {}) {
  const a = await calendarAccount.get();
  if (a.error) return { error: a.error };
  const ev = await findEvent(a, String(id || '').trim());
  if (!ev) return { error: 'that event is not in the calendar any more (check calendar.events for its id)' };
  if (title && !sameTitle(ev.title, title)) return { error: `that id belongs to "${ev.title}", not "${title}": nothing changed` };
  if (ev.recurring && !scope) return { error: `"${ev.title}" repeats: ask Fred "just this one or the whole series?", then call again with scope "this" (with its occurrence from calendar.events) or scope "all"` };
  if (ev.cal.writable === false) return { error: `"${ev.title}" is in ${ev.cal.name}, a calendar Fred can only read` };
  return { a, ev };
}

// PUT a changed copy of a stored event (If-Match), then read it back.
async function putBack(a, ev, ics) {
  const res = await fetch(ev.url, { method: 'PUT', headers: { Authorization: a.auth, 'Content-Type': 'text/calendar; charset=utf-8', ...(ev.etag ? { 'If-Match': ev.etag } : {}) }, body: ics, signal: AbortSignal.timeout(10000) });
  if (res.status === 412) return { error: 'the event changed in the meantime: look it up again' };
  if (!res.ok) return { error: `caldav ${res.status}` };
  return { back: await readBack(a, ev.url) };
}

// Reminders that go with an event: cancelled with it, moved with it. The
// answer only ever names reminders that were still to come (never one that
// already fired or was cancelled earlier).
async function remindersAfterDelete(ev) {
  const lr = linkedReminders();
  if (!lr) return {};
  try {
    const r = await lr.cancelForEvent(new URL(ev.url).pathname, { eventUid: ev.uid });
    const at = (list) => list.map((ts) => assist.fmtTime(Number(ts), tz())).join(', ');
    return { ...(r.cancelled.length ? { reminder: `cancelled (it was set for ${at(r.cancelled)})` } : {}),
      ...(r.failed.length ? { reminder_failed: `the event is gone, but its reminder (${at(r.failed)}) could not be cancelled. Tell Fred.` } : {}) };
  } catch (e) { return { reminder_failed: `could not check the event's reminder: ${e.message}` }; }
}
async function remindersAfterMove(ev, start) {
  const lr = linkedReminders();
  if (!lr) return {};
  const r0 = assist.resolveWhen(start, { tz: tz(), now: nowFn() });
  if (!r0.ok) return {};
  try {
    const r = await lr.moveForEvent(new URL(ev.url).pathname, r0.ms, { eventUid: ev.uid, title: ev.title });
    const at = (list) => list.map((ts) => assist.fmtTime(Number(ts), tz())).join(', ');
    return { ...(r.moved.length ? { reminder: `moved to ${at(r.moved)}` } : {}),
      ...(r.dropped.length ? { reminder: 'dropped: at the new time it would already be in the past' } : {}),
      ...(r.failed.length ? { reminder_failed: `the event moved, but its reminder could not be moved with it (${at(r.failed)}). Tell Fred.` } : {}) };
  } catch (e) { return { reminder_failed: `could not move the event's reminder: ${e.message}` }; }
}
const notChecked = (what) => ({ ok: false, verified: false, could_not_check: true, error: `iCloud said yes to ${what}, but I could not read the calendar back to check it. It may have worked: do NOT do it again; look with calendar.events first.` });

ipcMain.handle('calendar:delete', async (_e, id, title, _when, occurrence, scope) => {
  if (!id) return { ok: false, error: 'which event? Look it up with calendar.events first (or describe it with find and day)' };
  // Repeating: only ever with Fred's explicit choice ("this" or "all"), never guessed from an occurrence.
  const one = scope === 'this';
  const { a, ev, error } = await locate(id, title, { scope: one ? 'this' : scope === 'all' ? 'all' : undefined });
  if (error) return { ok: false, error };
  try {
    if (ev.recurring && one) {
      // Only this repeat: skip it in the series (EXDATE); the rest stays.
      const skip = skipOccurrence(ev.ics, occurrence);
      if (!skip.ok) return skip;
      const { back, error: err } = await putBack(a, ev, skip.ics);
      if (err) return { ok: false, error: err };
      if (back === undefined) return notChecked(`skipping that "${ev.title}"`);
      const st = back ? occurrenceState(back.ics, occurrence) : null;
      if (back === null || (st && st.gone)) return { ok: false, verified: false, error: `the whole "${ev.title}" series disappeared: check the Calendar app` };
      if (!st.skipped || st.override) return { ok: false, verified: false, error: `that "${ev.title}" is still in the calendar after skipping it` };
      console.log(`[calendar] skipped one "${ev.title}" (${occurrence}) (checked)`);
      return { ok: true, verified: true, deleted: ev.title, only: 'this one', calendar: ev.cal.name, done: `Deleted only this one “${ev.title}” from ${ev.cal.name}; the other repeats stay (checked)` };
    }
    const res = await fetch(ev.url, { method: 'DELETE', headers: { Authorization: a.auth, ...(ev.etag ? { 'If-Match': ev.etag } : {}) }, signal: AbortSignal.timeout(10000) });
    if (!res.ok && res.status !== 404) return { ok: false, error: `caldav ${res.status}` };
    const back = await readBack(a, ev.url);
    if (back === undefined) return notChecked(`deleting "${ev.title}"`);
    if (back) return { ok: false, verified: false, error: `"${ev.title}" is still in the calendar after deleting it` };
    console.log(`[calendar] deleted "${ev.title}"${ev.recurring ? ' (whole series)' : ''} (${ev.cal.name}) (checked)`);
    const rem = await remindersAfterDelete(ev);
    return { ok: true, verified: true, deleted: ev.title, ...(ev.recurring ? { only: 'the whole series' } : {}), calendar: ev.cal.name, ...rem,
      done: `Deleted “${ev.title}”${ev.recurring ? ' (the whole series)' : ''} from ${ev.cal.name}${rem.reminder ? `; its reminder ${rem.reminder}` : ''} (checked)` };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('calendar:move', async (_e, id, start, minutes, title, occurrence, scope) => {
  if (!id) return { ok: false, error: 'which event? Look it up with calendar.events first (or describe it with find and day)' };
  const one = scope === 'this';
  const { a, ev, error } = await locate(id, title, { scope: one ? 'this' : scope === 'all' ? 'all' : undefined });
  if (error) return { ok: false, error };
  const opt = { start, minutes, tz: tz(), now: nowFn() };
  if (ev.recurring && scope === 'all') {
    // The whole series to a new time: the series' own start moves, every repeat with it.
    const mv = moveSeries(ev.ics, occurrence, opt);
    if (!mv.ok) return mv;
    try {
      const { back, error: err } = await putBack(a, ev, mv.ics);
      if (err) return { ok: false, error: err };
      if (back === undefined) return notChecked(`moving the "${ev.title}" series`);
      if (back === null) return { ok: false, verified: false, error: `the whole "${ev.title}" series disappeared: check the Calendar app` };
      if (timesOf(back.ics) !== timesOf(mv.ics)) return { ok: false, verified: false, error: `the "${ev.title}" series still shows its old time after moving it` };
      console.log(`[calendar] moved the "${ev.title}" series to ${mv.when} (checked)`);
      return { ok: true, verified: true, title: ev.title, when: mv.when, only: 'the whole series', calendar: ev.cal.name, done: `Moved the whole “${ev.title}” series to ${mv.when} in ${ev.cal.name} (checked)` };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  if (ev.recurring && one) {
    // Only this repeat: an override with RECURRENCE-ID; the series stays.
    const mv = moveOccurrence(ev.ics, occurrence, opt);
    if (!mv.ok) return mv;
    try {
      const { back, error: err } = await putBack(a, ev, mv.ics);
      if (err) return { ok: false, error: err };
      if (back === undefined) return notChecked(`moving that "${ev.title}"`);
      const want = occurrenceState(mv.ics, occurrence).override;
      const st = back ? occurrenceState(back.ics, occurrence) : null;
      if (back === null || (st && st.gone)) return { ok: false, verified: false, error: `the whole "${ev.title}" series disappeared: check the Calendar app` };
      if (st.override !== want) return { ok: false, verified: false, error: `that "${ev.title}" still shows its old time after moving it` };
      console.log(`[calendar] moved one "${ev.title}" to ${mv.when} (checked)`);
      return { ok: true, verified: true, title: ev.title, when: mv.when, only: 'this one', calendar: ev.cal.name, done: `Moved only this one “${ev.title}” to ${mv.when} in ${ev.cal.name} (checked)` };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  const moved = moveEvent(ev.ics, opt);
  if (!moved.ok) return moved;
  try {
    const res = await fetch(ev.url, { method: 'PUT', headers: { Authorization: a.auth, 'Content-Type': 'text/calendar; charset=utf-8', ...(ev.etag ? { 'If-Match': ev.etag } : {}) }, body: moved.ics, signal: AbortSignal.timeout(10000) });
    if (res.status === 412) return { ok: false, error: 'the event changed in the meantime: look it up again' };
    if (!res.ok) return { ok: false, error: `caldav ${res.status}` };
    const back = await readBack(a, ev.url);
    if (back === undefined) return notChecked(`moving "${ev.title}"`);
    if (back === null) return { ok: false, verified: false, error: `"${ev.title}" is gone from the calendar after moving it` };
    if (timesOf(back.ics) !== timesOf(moved.ics)) return { ok: false, verified: false, error: `"${ev.title}" still shows its old time or length after moving it` };
    console.log(`[calendar] moved "${ev.title}" to ${moved.when} (checked)`);
    const rem = await remindersAfterMove(ev, start);
    return { ok: true, verified: true, title: ev.title, when: moved.when, calendar: ev.cal.name, ...rem,
      done: `Moved “${ev.title}” to ${moved.when} in ${ev.cal.name}${rem.reminder ? `; its reminder ${rem.reminder}` : ''} (checked)` };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── MAIL: Zoho inbox summary over IMAP (stdlib imaplib via a spawned Python
// script — same pattern as TTS/wakeword, no npm deps). Returns unread count +
// the latest few messages for the left-rail Mail panel. ──
ipcMain.handle('mail:inbox', async () => {
  if (!process.env.ZOHO_APP_PW) return { ok: false, error: 'Zoho app password not set in .env' };
  try {
    const { so, se, code } = await new Promise((resolve) => {
      const p = spawn(opts.python, [path.join(__dirname, 'imap-mail.py')], { env: process.env });
      let so = '', se = '';
      p.stdout.on('data', (d) => { so += d; });
      p.stderr.on('data', (d) => { se += d; });
      p.on('error', (e) => resolve({ so: '', se: e.message, code: -1 }));
      p.on('close', (code) => resolve({ so, se, code }));
    });
    try {
      const j = JSON.parse(so.trim().split('\n').pop() || '{}');
      if (j.error) return { ok: false, error: j.error };
      return { ok: true, unread: j.unread || 0, messages: j.messages || [] };
    } catch (_) {
      return { ok: false, error: se.trim() || `mail script exit ${code}` };
    }
  } catch (e) {
    console.log('[mail] failed', e.message);
    return { ok: false, error: e.message };
  }
});

// ── MAIL: read full body of a specific message by IMAP UID ──
ipcMain.handle('mail:read-body', async (_e, uid) => {
  if (!process.env.ZOHO_APP_PW) return { ok: false, error: 'Zoho app password not set' };
  if (!uid) return { ok: false, error: 'No message UID provided' };
  try {
    const { so, se, code } = await new Promise((resolve) => {
      const p = spawn(opts.python, [
        path.join(__dirname, 'imap-read-body.py'), String(uid)
      ], { env: process.env });
      let so = '', se = '';
      p.stdout.on('data', (d) => { so += d; });
      p.stderr.on('data', (d) => { se += d; });
      p.on('error', (e) => resolve({ so: '', se: e.message, code: -1 }));
      p.on('close', (code) => resolve({ so, se, code }));
    });
    try {
      const j = JSON.parse(so.trim().split('\n').pop() || '{}');
      if (j.error) return { ok: false, error: j.error };
      return { ok: true, from: j.from, from_email: j.from_email || '', subject: j.subject, date: j.date, body: j.body };
    } catch (_) {
      return { ok: false, error: se.trim() || `read-body exit ${code}` };
    }
  } catch (e) {
    console.log('[mail] read-body failed', e.message);
    return { ok: false, error: e.message };
  }
});

// ── WEB FETCH ──
// Pulls a URL through Node's fetch and strips HTML to plain text. CORS isn't
// a concern from main, and a 5s timeout + 200KB cap keeps a stray pointer to
// a huge page from blocking the renderer.
// SearXNG-backed web search. Returns parsed JSON; keeps the SearXNG URL on the
// main side so the renderer doesn't need to know about it. SearXNG must have
// `json` listed under search.formats in settings.yml (default is HTML only).
ipcMain.handle('web:search', async (_e, query) => {
  try {
    const q = String(query || '').trim();
    if (!q) return { ok: false, error: 'empty query' };
    const url = `${opts.searxngUrl}/search?q=${encodeURIComponent(q)}&format=json`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 Hannibal/2.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, results: Array.isArray(data.results) ? data.results : [] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('web:fetch', async (_e, url) => {
  try {
    if (!url || typeof url !== 'string') return { ok: false, error: 'No URL.' };
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 Hannibal/2.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    let html = await res.text();
    if (html.length > 200 * 1024) html = html.slice(0, 200 * 1024);
    // Strip scripts/styles before tags so their content doesn't leak as prose.
    const text = html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
      .replace(/\s+/g, ' ')
      .trim();
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
    return { ok: true, url, title: title.trim(), text };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── MAIL WORK (Zoho): triage, reply, write, mark read — electron/services/zoho-mail.py.
// Sending only happens after Fred's yes at the confirmation gate (catalog confirm:true).
function zoho(args, input) {
  return new Promise((resolve) => {
    if (!process.env.ZOHO_APP_PW) return resolve({ ok: false, error: 'Zoho app password not set in .env' });
    const p = spawn(opts.python, [path.join(__dirname, 'zoho-mail.py'), ...args], { env: process.env });
    let so = '', se = '';
    const kill = setTimeout(() => { try { p.kill(); } catch (_) {} }, 60000);
    p.stdout.on('data', (d) => { so += d; });
    p.stderr.on('data', (d) => { se += d; });
    p.on('error', (e) => { clearTimeout(kill); resolve({ ok: false, error: e.message }); });
    p.on('close', (code) => {
      clearTimeout(kill);
      try {
        const j = JSON.parse(so.trim().split('\n').pop() || '{}');
        resolve(j.error ? { ok: false, error: j.error } : j);
      } catch (_) { resolve({ ok: false, error: se.trim().slice(0, 300) || `zoho-mail exit ${code}` }); }
    });
    p.stdin.on('error', () => {});
    p.stdin.end(input ? JSON.stringify(input) : '');
  });
}
ipcMain.handle('mail:triage', (_e, days, limit) => zoho(['triage', String(Math.min(Math.max(Number(days) || 3, 1), 30)), String(Math.min(Math.max(Number(limit) || 20, 1), 40))]));
ipcMain.handle('mail:reply', (_e, uid, to, body) => zoho(['reply'], { uid, to, body }));
ipcMain.handle('mail:write', (_e, to, subject, body) => zoho(['write'], { to, subject, body }));
ipcMain.handle('mail:seen', (_e, uid) => zoho(['seen', String(uid || '')]));

// For the nudges (nudges.js): the same reads, called directly.
return {
  calendar: (days) => fetchCalendar(days),
  // Run by claude-tools before the voice gate for calendar.add/move/delete
  // (calendar-assist.js): past times, clashes, which calendar, the reminder,
  // which event Fred means, "this one or the whole series".
  calendarPreflight: assist.createCalendarPreflight({
    events: (days) => fetchCalendar(days),
    account: () => calendarAccount.get(),
    reminders: { forEvent: async (id) => { const lr = linkedReminders(); return lr ? lr.forEvent(id) : []; } },
    env: opts.env || process.env,
    now: nowFn,
  }),
  waitingMail: (hours = 48, days = 7) => zoho(['waiting', String(hours), String(days)]),
};
}

// One VEVENT, times in UTC. Pure, so it can be tested.
function buildEvent({ title, start, minutes, location, notes, now = Date.now(), uid, tz = assist.fredTz() } = {}) {
  const t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!t) return { ok: false, error: 'the event needs a title' };
  const s = String(start || '').trim();
  const esc = (v) => String(v || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const utc = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const id = uid || `hannibal-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let dtStart, dtEnd, when;
  let startMs;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    const day = { y, mo: m, d };
    const today = assist.dayOf(now, tz);
    if (Date.UTC(y, m - 1, d) < Date.UTC(today.y, today.mo - 1, today.d)) return { ok: false, error: `${s} is in the past` };
    const next = assist.addDays(day, 1);
    const ymd8 = (x) => `${x.y}${String(x.mo).padStart(2, '0')}${String(x.d).padStart(2, '0')}`;
    dtStart = `DTSTART;VALUE=DATE:${ymd8(day)}`; dtEnd = `DTEND;VALUE=DATE:${ymd8(next)}`;
    when = assist.fmtDate(assist.addDays(day, 0)) + ' (all day)';
    startMs = assist.wallMs(y, m, d, 0, 0, tz);
  } else {
    // A local time on Fred's clock (Bussum / Ibiza), not the machine's.
    const mt = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    const ms = mt ? assist.wallMs(+mt[1], +mt[2], +mt[3], +mt[4], +mt[5], tz) : NaN;
    if (!mt || !Number.isFinite(ms)) return { ok: false, error: `could not read the time "${s}": use YYYY-MM-DDTHH:MM local time` };
    if (ms < now - 5 * 60000) return { ok: false, error: 'that time is in the past: ask Fred which day he means, never pick one yourself' };
    const mins = Math.min(Math.max(Math.round(Number(minutes) || 60), 5), 24 * 60);
    dtStart = `DTSTART:${utc(ms)}`; dtEnd = `DTEND:${utc(ms + mins * 60000)}`;
    when = `${assist.fmtWhen(ms, tz)} (${mins} min)`;
    startMs = ms;
  }
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Hannibal//EN', 'BEGIN:VEVENT', `UID:${id}`, `DTSTAMP:${utc(now)}`,
    dtStart, dtEnd, `SUMMARY:${esc(t)}`,
    ...(location ? [`LOCATION:${esc(location)}`] : []), ...(notes ? [`DESCRIPTION:${esc(notes)}`] : []),
    'END:VEVENT', 'END:VCALENDAR'];
  return { ok: true, uid: id, title: t, when, startMs, ics: lines.join('\r\n') + '\r\n' };
}

// Event objects in a calendar-query answer: [{ href, etag, ics, uid, title, recurring }].
function parseEventObjects(xml) {
  const unxml = (v) => String(v || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&#13;|&#x0?d;/gi, '\r').replace(/&#10;|&#x0?a;/gi, '\n')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, '&');
  const out = [];
  for (const r of String(xml || '').split(/<(?:[a-z0-9]+:)?response[\s>]/i).slice(1)) {
    const href = (r.match(/<(?:[a-z0-9]+:)?href[^>]*>([\s\S]*?)<\//i) || [])[1];
    const etag = (r.match(/<(?:[a-z0-9]+:)?getetag[^>]*>([\s\S]*?)<\//i) || [])[1];
    const data = (r.match(/<(?:[a-z0-9]+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:[a-z0-9]+:)?calendar-data>/i) || [])[1];
    if (!href || !data) continue;
    out.push({ href: unxml(href).trim(), etag: etag ? unxml(etag).trim() : null, ...describeIcs(unxml(data)) });
  }
  return out;
}

// { ics, uid, title, recurring } of one stored calendar object.
function describeIcs(raw) {
  const ics = String(raw || '').replace(/\r?\n[ \t]/g, '');
  const ev = (ics.split(/BEGIN:VEVENT/)[1] || '').split(/END:VEVENT/)[0];
  const field = (k) => ((ev.match(new RegExp(`(?:^|\\n)${k}[^:\\n]*:(.*)`)) || [])[1] || '').trim();
  return { ics, uid: field('UID'), title: field('SUMMARY').replace(/\\([,;\\])/g, '$1').replace(/\\n/gi, ' '),
    recurring: /(?:^|\n)(RRULE|RDATE|RECURRENCE-ID)[;:]/.test(ics) || (ics.match(/BEGIN:VEVENT/g) || []).length > 1 };
}

// The event's own text with new times. start: local "YYYY-MM-DDTHH:MM" (or
// "YYYY-MM-DD" for all day); minutes: new length, default = the old length.
function moveEvent(ics, { start, minutes, now = Date.now(), tz = assist.fredTz() } = {}) {
  const text = String(ics || '').replace(/\r?\n[ \t]/g, '');
  const a = text.indexOf('BEGIN:VEVENT'); const b = text.indexOf('END:VEVENT', a);
  if (a < 0 || b < 0) return { ok: false, error: 'could not read that event' };
  const lines = text.slice(a, b).split(/\r?\n/);
  const get = (k) => lines.find((l) => new RegExp(`^${k}[;:]`).test(l));
  const when = (line) => {                     // ms of a DTSTART/DTEND line (TZID = Fred's own wall clock)
    const v = (String(line || '').match(/:(\d{8}(T\d{6}Z?)?)\s*$/) || [])[1];
    if (!v) return null;
    if (v.length === 8) return new Date(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8)).getTime();
    const p = [+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8), +v.slice(9, 11), +v.slice(11, 13), +v.slice(13, 15)];
    return v.endsWith('Z') ? Date.UTC(...p) : new Date(...p).getTime();
  };
  const oldStart = when(get('DTSTART'));
  const oldEnd = when(get('DTEND'));
  const dur = (String(get('DURATION') || '').match(/PT?(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/) || []);
  const oldMins = oldStart != null && oldEnd != null ? Math.round((oldEnd - oldStart) / 60000)
    : dur.length ? (+dur[1] || 0) * 1440 + (+dur[2] || 0) * 60 + (+dur[3] || 0) : 60;
  const keep = !(Number(minutes) > 0);         // no new length given → keep the event's own length
  const fresh = buildEvent({ title: 'x', start, minutes: keep ? (oldMins > 0 && oldMins < 1440 ? oldMins : 60) : minutes, now, uid: 'x', tz });
  if (!fresh.ok) return fresh;
  const lines2 = fresh.ics.split('\r\n');
  if (keep && oldMins > 0) {
    // Rebuild DTEND from the original span, so a 2-day trip stays 2 days.
    const ymd = (x) => `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, '0')}${String(x.getDate()).padStart(2, '0')}`;
    const s = String(start).trim();
    const i = lines2.findIndex((l) => /^DTEND[;:]/.test(l));
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const days = Math.max(1, Math.round(oldMins / 1440));
      const [y, m, d] = s.split('-').map(Number);
      lines2[i] = `DTEND;VALUE=DATE:${ymd(new Date(y, m - 1, d + days))}`;
      if (days > 1) fresh.when = fresh.when.replace('(all day)', `(${days} days)`);
    } else if (oldMins >= 1440) {
      const ms = fresh.startMs + oldMins * 60000;
      lines2[i] = `DTEND:${new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`;
      const h = Math.round(oldMins / 60);
      fresh.when = fresh.when.replace(/\(\d+ min\)$/, `(${h} hours)`);
    }
  }
  const pick = (k) => lines2.find((l) => new RegExp(`^${k}[;:]`).test(l));
  const utc = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const seq = Number((String(get('SEQUENCE') || '').match(/:(\d+)/) || [])[1] || 0) + 1;
  // Top-level VEVENT lines only: an alarm inside keeps its own lines.
  const out = []; let depth = 0;
  for (const l of lines) {
    if (/^BEGIN:/.test(l)) depth += 1;
    const top = depth === 1;
    if (top && /^(DTSTART|DTEND|DURATION|SEQUENCE|DTSTAMP)[;:]/.test(l)) continue;
    out.push(l);
    if (/^END:/.test(l)) depth -= 1;
    if (l === 'BEGIN:VEVENT') out.push(pick('DTSTART'), pick('DTEND'), `DTSTAMP:${utc}`, `SEQUENCE:${seq}`);
  }
  const ics2 = (text.slice(0, a) + out.join('\r\n') + '\r\n' + text.slice(b)).replace(/\r?\n/g, '\r\n');
  return { ok: true, ics: ics2, when: fresh.when, startMs: fresh.startMs };
}

// ── REPEATING EVENTS ────────────────────────────────────────────────────────
// One repeat of a repeating event is changed the iCalendar way, inside the same
// calendar object: skipping it adds an EXDATE to the series, moving it adds an
// override VEVENT carrying RECURRENCE-ID (the slot it came from). The series
// itself, its other repeats, alarms and invitees stay exactly as they were.
// `occurrence` is the value calendar.events gave for that repeat
// ("20261124T090000Z", or "20261124" for an all-day one).
function tzOffsetMs(tz, utcMs) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}
const pad2 = (n) => String(n).padStart(2, '0');
const digits = (d) => `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`;
// A DTSTART / RECURRENCE-ID / EXDATE line → { date:true, key:"YYYYMMDD" } or { ms }.
function lineInstant(line) {
  const m = String(line || '').match(/^[A-Z-]+((?:;[^:]*)?):(\d{8})(?:T(\d{6})(Z?))?/);
  if (!m) return null;
  const [, params, d, t, z] = m;
  if (!t) return { date: true, key: d };
  const parts = [+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6)];
  if (z) return { ms: Date.UTC(...parts) };
  const tz = (params.match(/TZID=([^;:]+)/) || [])[1];
  if (!tz) return { ms: new Date(...parts).getTime() };
  try {
    const wall = Date.UTC(...parts);
    let ms = wall - tzOffsetMs(tz, wall);
    ms = wall - tzOffsetMs(tz, ms);
    return { ms };
  } catch (_) { return { ms: new Date(...parts).getTime() }; }
}
const occInstant = (occ) => lineInstant(`X:${String(occ || '').trim()}`);
const sameInstant = (a, b) => !!a && !!b && (a.date || b.date ? (a.key || '') === (b.key || '') : a.ms === b.ms);
// The same moment written the way the series writes its DTSTART (TZID, UTC, date).
function formatLike(dtstartLine, inst, prop) {
  const params = (String(dtstartLine).match(/^DTSTART((?:;[^:]*)?):/) || [])[1] || '';
  if (inst.date || /VALUE=DATE(?!-)/.test(params)) return `${prop};VALUE=DATE:${inst.key || digits(new Date(inst.ms)).slice(0, 8)}`;
  const tz = (params.match(/TZID=([^;:]+)/) || [])[1];
  if (tz) return `${prop};TZID=${tz}:${digits(new Date(inst.ms + tzOffsetMs(tz, inst.ms)))}`;
  if (/Z\s*$/.test(dtstartLine)) return `${prop}:${digits(new Date(inst.ms))}Z`;
  const l = new Date(inst.ms);
  return `${prop}:${l.getFullYear()}${pad2(l.getMonth() + 1)}${pad2(l.getDate())}T${pad2(l.getHours())}${pad2(l.getMinutes())}${pad2(l.getSeconds())}`;
}
// The VEVENT blocks of a calendar object: [{ start, end, text, lines, rid }].
function veventBlocks(text) {
  const out = []; const re = /BEGIN:VEVENT\r?\n[\s\S]*?END:VEVENT/g; let m;
  while ((m = re.exec(text))) {
    const lines = m[0].split(/\r?\n/);
    const top = topLines(lines);
    const ridLine = top.find((l) => /^RECURRENCE-ID[;:]/.test(l));
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0], lines, top, rid: ridLine ? lineInstant(ridLine) : null });
  }
  return out;
}
function topLines(lines) {     // the VEVENT's own properties, not those of a VALARM inside it
  const out = []; let depth = 0;
  for (const l of lines) {
    if (/^BEGIN:/.test(l)) { depth += 1; continue; }
    if (/^END:/.test(l)) { depth -= 1; continue; }
    if (depth === 1) out.push(l);
  }
  return out;
}
function seriesOf(ics) {
  const text = String(ics || '').replace(/\r?\n[ \t]/g, '').replace(/\r?\n/g, '\r\n');
  const blocks = veventBlocks(text);
  const master = blocks.find((b) => !b.rid && b.top.some((l) => /^(RRULE|RDATE)[;:]/.test(l)));
  if (!master) return { error: 'that event does not repeat' };
  const dtstart = master.top.find((l) => /^DTSTART[;:]/.test(l));
  return { text, blocks, master, dtstart };
}
// Is `occ` really one of the slots of this series? Its time of day (in the
// series' own time zone) must be the series' time of day; a date for a date.
function checkSlot(dtstart, inst) {
  const start = lineInstant(dtstart);
  if (!start || !inst) return 'could not read which repeat that is';
  if (!!start.date !== !!inst.date) return 'that is not one of its repeats';
  if (start.date) return inst.key >= start.key ? null : 'that is before the series starts';
  if (inst.ms < start.ms) return 'that is before the series starts';
  const hhmm = (x) => (formatLike(dtstart, x, 'X').match(/T(\d{4})\d{2}Z?$/) || [])[1];
  return hhmm(start) === hhmm(inst) ? null : 'that is not one of its repeats (the time does not match the series)';
}

function skipOccurrence(ics, occurrence) {
  const s = seriesOf(ics); if (s.error) return { ok: false, error: s.error };
  const inst = occInstant(occurrence);
  const bad = checkSlot(s.dtstart, inst); if (bad) return { ok: false, error: bad };
  const ex = formatLike(s.dtstart, inst, 'EXDATE');
  let text = s.text;
  // drop an override of this repeat (it would otherwise keep showing), last first
  for (const b of [...s.blocks].reverse()) if (b.rid && sameInstant(b.rid, inst)) text = text.slice(0, b.start) + text.slice(b.end).replace(/^\r\n/, '');
  const m = seriesOf(text).master;
  const lines = m.lines.slice();
  if (!m.top.some((l) => /^EXDATE[;:]/.test(l) && sameInstant(lineInstant(l), inst))) {
    const i = lines.findIndex((l) => /^DTSTART[;:]/.test(l));
    lines.splice(i + 1, 0, ex);
  }
  text = text.slice(0, m.start) + lines.join('\r\n') + text.slice(m.end);
  return { ok: true, ics: text };
}

function moveOccurrence(ics, occurrence, { start, minutes, now = Date.now(), tz = assist.fredTz() } = {}) {
  const s = seriesOf(ics); if (s.error) return { ok: false, error: s.error };
  const inst = occInstant(occurrence);
  const bad = checkSlot(s.dtstart, inst); if (bad) return { ok: false, error: bad };
  const existing = s.blocks.find((b) => b.rid && sameInstant(b.rid, inst));
  const base = existing || s.master;
  // the new times: reuse the one-event mover on just this block (keeps its length)
  const one = moveEvent(`BEGIN:VCALENDAR\r\n${base.text}\r\nEND:VCALENDAR\r\n`, { start, minutes, now, tz });
  if (!one.ok) return one;
  const moved = veventBlocks(one.ics)[0].lines;
  const drop = /^(RRULE|RDATE|EXDATE|EXRULE|RECURRENCE-ID)[;:]/;
  const out = []; let depth = 0;
  for (const l of moved) {
    if (/^BEGIN:/.test(l)) depth += 1;
    if (l.trim() && !(depth === 1 && drop.test(l))) out.push(l);
    if (l === 'BEGIN:VEVENT') out.push(formatLike(s.dtstart, inst, 'RECURRENCE-ID'));
    if (/^END:/.test(l)) depth -= 1;
  }
  const block = out.join('\r\n');
  const text = existing ? s.text.slice(0, existing.start) + block + s.text.slice(existing.end)
    : s.text.replace(/END:VCALENDAR\s*$/, `${block}\r\nEND:VCALENDAR\r\n`);
  return { ok: true, ics: text, when: one.when };
}

// The WHOLE series to a new time (Fred said "the whole series"). The repeat
// Fred picked (occurrence; the series' first one if none) lands on `start`;
// every other repeat shifts the same way, in the series' own time zone, so
// "every Tuesday 9:00" becomes "every Tuesday 10:00" through summer and winter.
// Skipped repeats (EXDATE) shift with it. Refused, with a plain reason, when
// it cannot be done safely here: repeats already changed one by one, or a
// move to another weekday of a series that repeats on named days.
function moveSeries(ics, occurrence, { start, minutes, now = Date.now(), tz = assist.fredTz() } = {}) {
  const s = seriesOf(ics); if (s.error) return { ok: false, error: s.error };
  if (s.master.top.some((l) => /^RDATE[;:]/.test(l))) return { ok: false, error: 'this series has extra dates added by hand, so moving the whole series is safer in the Calendar app: tell Fred' };
  if (s.blocks.some((b) => b.rid)) return { ok: false, error: 'some repeats of this series were already changed one by one, so moving the whole series is safer in the Calendar app: tell Fred' };
  const first = lineInstant(s.dtstart);
  const inst = occurrence ? occInstant(occurrence) : first;
  if (occurrence) { const bad = checkSlot(s.dtstart, inst); if (bad) return { ok: false, error: bad }; }
  const target = assist.resolveWhen(start, { now, tz });
  if (!target.ok) return { ok: false, error: target.error };
  if (!!first.date !== !!target.allDay) return { ok: false, error: 'a series cannot switch between all-day and timed here: change it in the Calendar app' };
  if (target.hasTime && target.ms < now - 5 * 60000) return { ok: false, error: 'that time is in the past: ask Fred which day he means' };
  const seriesTz = (s.dtstart.match(/TZID=([^;:]+)/) || [])[1] || tz;
  const dayOfInst = (x) => (x.date ? { y: +x.key.slice(0, 4), mo: +x.key.slice(4, 6), d: +x.key.slice(6, 8) } : assist.dayOf(x.ms, seriesTz));
  const shiftDays = Math.round((Date.UTC(target.day.y, target.day.mo - 1, target.day.d) - Date.UTC(...(() => { const d = dayOfInst(inst); return [d.y, d.mo - 1, d.d]; })())) / 864e5);
  const rrule = s.master.top.find((l) => /^RRULE[;:]/.test(l)) || '';
  if (shiftDays && /BY(DAY|MONTHDAY|YEARDAY|WEEKNO|SETPOS)=/.test(rrule)) return { ok: false, error: 'moving this series to another day changes its repeat rule: Fred can do that in the Calendar app, or move one repeat at a time' };
  const tp = target.allDay ? null : assist.partsIn(target.ms, tz);
  // Each instant of the series → the same day shifted, at the new time of day.
  const shift = (x) => {
    if (x.date) { const d = assist.addDays(dayOfInst(x), shiftDays); return { date: true, key: `${d.y}${pad2(d.mo)}${pad2(d.d)}` }; }
    const d = assist.addDays(dayOfInst(x), shiftDays);
    const wallTp = assist.partsIn(assist.wallMs(target.day.y, target.day.mo, target.day.d, tp.h, tp.mi, tz), seriesTz);
    return { ms: assist.wallMs(d.y, d.mo, d.d, wallTp.h, wallTp.mi, seriesTz) };
  };
  const newStart = shift(first);
  const endLine = s.master.top.find((l) => /^DTEND[;:]/.test(l));
  const oldEnd = endLine ? lineInstant(endLine) : null;
  const oldMins = oldEnd && !first.date ? Math.round((oldEnd.ms - first.ms) / 60000) : null;
  const oldDays = oldEnd && first.date ? Math.max(1, Math.round((Date.UTC(+oldEnd.key.slice(0, 4), +oldEnd.key.slice(4, 6) - 1, +oldEnd.key.slice(6, 8)) - Date.UTC(+first.key.slice(0, 4), +first.key.slice(4, 6) - 1, +first.key.slice(6, 8))) / 864e5)) : 1;
  const mins = Number(minutes) > 0 ? Math.round(Number(minutes)) : (oldMins || 60);
  const newEnd = newStart.date ? (() => { const d = assist.addDays({ y: +newStart.key.slice(0, 4), mo: +newStart.key.slice(4, 6), d: +newStart.key.slice(6, 8) }, oldDays); return { date: true, key: `${d.y}${pad2(d.mo)}${pad2(d.d)}` }; })()
    : { ms: newStart.ms + mins * 60000 };
  const seq = Number((String(s.master.top.find((l) => /^SEQUENCE[;:]/.test(l)) || '').match(/:(\d+)/) || [])[1] || 0) + 1;
  const out = []; let depth = 0;
  for (const l of s.master.lines) {
    if (/^BEGIN:/.test(l)) depth += 1;
    const top = depth === 1;
    if (top && /^(DTSTART|DTEND|DURATION|SEQUENCE|DTSTAMP)[;:]/.test(l)) { if (/^END:/.test(l)) depth -= 1; continue; }
    if (top && /^EXDATE[;:]/.test(l)) {
      const [, params, values] = l.match(/^EXDATE((?:;[^:]*)?):(.*)$/) || [];
      out.push(String(values || '').split(',').map((v) => formatLike(s.dtstart, shift(lineInstant(`EXDATE${params || ''}:${v.trim()}`)), 'EXDATE')).join('\r\n'));
    } else out.push(l);
    if (/^END:/.test(l)) depth -= 1;
    if (l === 'BEGIN:VEVENT') {
      out.push(formatLike(s.dtstart, newStart, 'DTSTART'), formatLike(s.dtstart, newEnd, 'DTEND'),
        `DTSTAMP:${digits(new Date(now))}Z`, `SEQUENCE:${seq}`);
    }
  }
  const text = s.text.slice(0, s.master.start) + out.join('\r\n') + s.text.slice(s.master.end);
  const when = newStart.date ? `${assist.fmtDate(target.day)} (all day), every repeat` : `${assist.fmtWhen(target.ms, tz)} (${mins} min), every repeat`;
  return { ok: true, ics: text, when };
}

// After a change, read back: is this repeat skipped / where is it now?
function occurrenceState(ics, occurrence) {
  const s = seriesOf(ics); if (s.error) return { gone: true };
  const inst = occInstant(occurrence);
  const skipped = s.master.top.filter((l) => /^EXDATE[;:]/.test(l)).some((l) => {
    const [, params, values] = l.match(/^EXDATE((?:;[^:]*)?):(.*)$/) || [];
    return String(values || '').split(',').some((v) => sameInstant(lineInstant(`EXDATE${params || ''}:${v.trim()}`), inst));
  });
  const override = s.blocks.find((b) => b.rid && sameInstant(b.rid, inst));
  return { skipped, override: override ? override.top.filter((l) => /^(DTSTART|DTEND|DURATION)[;:]/.test(l)).join('|') : null };
}

module.exports = { registerInfo, buildEvent, moveEvent, parseEventObjects, skipOccurrence, moveOccurrence, moveSeries, occurrenceState };
