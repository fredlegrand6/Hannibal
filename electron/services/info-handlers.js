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

function registerInfo(ipcMain, opts = {}) {
  const calendarAccount = opts.calendarAccount || createCalendarAccount();
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
function parseICalEvents(xml, now) {
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
      let when, time;
      if (allDay) {
        when = new Date(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8));
        time = 'All day';
      } else if (/Z$/.test(v)) {                       // UTC → local
        when = new Date(Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8), +v.slice(9, 11), +v.slice(11, 13)));
        time = when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      } else {                                          // floating / TZID → treat as wall-clock
        when = new Date(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8), +v.slice(9, 11), +v.slice(11, 13));
        time = `${v.slice(9, 11)}:${v.slice(11, 13)}`;
      }
      events.push({ ts: when.getTime(), time, allDay, title: (summary || '(no title)').trim(), ...(uid ? { uid } : {}) });
    }
  }
  const todayKey = new Date(now); todayKey.setHours(0, 0, 0, 0);
  const dayMs = 864e5;
  return events
    .filter((e) => e.allDay || e.ts >= now.getTime() - 30 * 60 * 1000)   // drop past timed events (30m grace)
    .sort((a, b) => a.ts - b.ts)
    .map((e) => {
      const n = Math.floor((e.ts - todayKey.getTime()) / dayMs);
      const day = n <= 0 ? 'today' : n === 1 ? 'tomorrow'
        : new Date(e.ts).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
      return { ...e, day };
    });
}

// Events from today through `days` days ahead (default 2 = today + tomorrow, max 31),
// from every calendar of the account (Apple Calendar: Home, Work, shared...).
// <c:expand> makes the server hand back each repeat of a recurring event.
async function fetchCalendar(days) {
  const a = await calendarAccount.get();
  if (a.error) return { ok: false, error: a.error };
  const n = Math.min(Math.max(Math.round(Number(days) || 2), 1), 31);
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + n);
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
      return parseICalEvents(block, now).map((e) => ({ ...e, calendar: cal.name, ...(href ? { href } : {}) }));
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
  }).map(({ uid, href, ...e }) => (href ? { ...e, id: href } : e));
  if (failed.length) console.log('[calendar] skipped:', failed.join('; '));
  return { ok: true, events: list };
}
ipcMain.handle('calendar:events', (_e, days) => fetchCalendar(days));

// Book an event. Only ever reached after Fred's yes (catalog: confirm, ceiling 'never').
// start: local "YYYY-MM-DDTHH:MM" (or "YYYY-MM-DD" for all day).
ipcMain.handle('calendar:add', async (_e, title, start, minutes, location, notes) => {
  const a = await calendarAccount.get();
  if (a.error) return { ok: false, error: a.error };
  const ev = buildEvent({ title, start, minutes, location, notes });
  if (!ev.ok) return ev;
  try {
    const res = await fetch(`${a.write.url.replace(/\/?$/, '/')}${ev.uid}.ics`, {
      method: 'PUT',
      headers: { Authorization: a.auth, 'Content-Type': 'text/calendar; charset=utf-8', 'If-None-Match': '*' },
      body: ev.ics, signal: AbortSignal.timeout(10000),
    });
    if (res.status === 401) calendarAccount.forget();
    if (!res.ok) return { ok: false, error: `caldav ${res.status}` };
    const back = await readBack(a, `${a.write.url.replace(/\/?$/, '/')}${ev.uid}.ics`);
    if (back === null || (back && back.uid !== ev.uid)) return { ok: false, verified: false, error: 'the calendar accepted the booking but it is not there when I look again' };
    console.log(`[calendar] booked "${ev.title}" ${ev.when} in ${a.write.name}${back ? ' (checked)' : ' (could not check)'}`);
    return { ok: true, verified: !!back, title: ev.title, when: ev.when, calendar: a.write.name };
  } catch (e) {
    return { ok: false, error: e.message };
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
async function locate(id, title) {
  const a = await calendarAccount.get();
  if (a.error) return { error: a.error };
  const ev = await findEvent(a, String(id || '').trim());
  if (!ev) return { error: 'that event is not in the calendar any more (check calendar.events for its id)' };
  if (title && !sameTitle(ev.title, title)) return { error: `that id belongs to "${ev.title}", not "${title}": nothing changed` };
  if (ev.recurring) return { error: `"${ev.title}" repeats; Hannibal does not change repeating events yet, so Fred should change it in the Calendar app` };
  if (ev.cal.writable === false) return { error: `"${ev.title}" is in ${ev.cal.name}, a calendar Fred can only read` };
  return { a, ev };
}

ipcMain.handle('calendar:delete', async (_e, id, title) => {
  const { a, ev, error } = await locate(id, title);
  if (error) return { ok: false, error };
  try {
    const res = await fetch(ev.url, { method: 'DELETE', headers: { Authorization: a.auth, ...(ev.etag ? { 'If-Match': ev.etag } : {}) }, signal: AbortSignal.timeout(10000) });
    if (!res.ok && res.status !== 404) return { ok: false, error: `caldav ${res.status}` };
    const back = await readBack(a, ev.url);
    if (back) return { ok: false, verified: false, error: `"${ev.title}" is still in the calendar after deleting it` };
    console.log(`[calendar] deleted "${ev.title}" (${ev.cal.name})${back === null ? ' (checked)' : ' (could not check)'}`);
    return { ok: true, verified: back === null, deleted: ev.title, calendar: ev.cal.name };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('calendar:move', async (_e, id, start, minutes, title) => {
  const { a, ev, error } = await locate(id, title);
  if (error) return { ok: false, error };
  const moved = moveEvent(ev.ics, { start, minutes });
  if (!moved.ok) return moved;
  try {
    const res = await fetch(ev.url, { method: 'PUT', headers: { Authorization: a.auth, 'Content-Type': 'text/calendar; charset=utf-8', ...(ev.etag ? { 'If-Match': ev.etag } : {}) }, body: moved.ics, signal: AbortSignal.timeout(10000) });
    if (res.status === 412) return { ok: false, error: 'the event changed in the meantime: look it up again' };
    if (!res.ok) return { ok: false, error: `caldav ${res.status}` };
    const back = await readBack(a, ev.url);
    if (back === null) return { ok: false, verified: false, error: `"${ev.title}" is gone from the calendar after moving it` };
    if (back && timesOf(back.ics) !== timesOf(moved.ics)) return { ok: false, verified: false, error: `"${ev.title}" still shows its old time or length after moving it` };
    console.log(`[calendar] moved "${ev.title}" to ${moved.when}${back ? ' (checked)' : ' (could not check)'}`);
    return { ok: true, verified: !!back, title: ev.title, when: moved.when, calendar: ev.cal.name };
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
  waitingMail: (hours = 48, days = 7) => zoho(['waiting', String(hours), String(days)]),
};
}

// One VEVENT, times in UTC. Pure, so it can be tested.
function buildEvent({ title, start, minutes, location, notes, now = Date.now(), uid } = {}) {
  const t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!t) return { ok: false, error: 'the event needs a title' };
  const s = String(start || '').trim();
  const esc = (v) => String(v || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const utc = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const id = uid || `hannibal-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let dtStart, dtEnd, when;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    const day = new Date(y, m - 1, d);
    if (day.getTime() < new Date(now).setHours(0, 0, 0, 0)) return { ok: false, error: `${s} is in the past` };
    const next = new Date(y, m - 1, d + 1);
    const ymd = (x) => `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, '0')}${String(x.getDate()).padStart(2, '0')}`;
    dtStart = `DTSTART;VALUE=DATE:${ymd(day)}`; dtEnd = `DTEND;VALUE=DATE:${ymd(next)}`;
    when = day.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) + ' (all day)';
  } else {
    const ms = Date.parse(s);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) || !Number.isFinite(ms)) return { ok: false, error: `could not read the time "${s}": use YYYY-MM-DDTHH:MM local time` };
    if (ms < now - 5 * 60000) return { ok: false, error: 'that time is in the past' };
    const mins = Math.min(Math.max(Math.round(Number(minutes) || 60), 5), 24 * 60);
    dtStart = `DTSTART:${utc(ms)}`; dtEnd = `DTEND:${utc(ms + mins * 60000)}`;
    when = new Date(ms).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) + ` (${mins} min)`;
  }
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Hannibal//EN', 'BEGIN:VEVENT', `UID:${id}`, `DTSTAMP:${utc(now)}`,
    dtStart, dtEnd, `SUMMARY:${esc(t)}`,
    ...(location ? [`LOCATION:${esc(location)}`] : []), ...(notes ? [`DESCRIPTION:${esc(notes)}`] : []),
    'END:VEVENT', 'END:VCALENDAR'];
  return { ok: true, uid: id, title: t, when, ics: lines.join('\r\n') + '\r\n' };
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
function moveEvent(ics, { start, minutes, now = Date.now() } = {}) {
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
  const fresh = buildEvent({ title: 'x', start, minutes: keep ? (oldMins > 0 && oldMins < 1440 ? oldMins : 60) : minutes, now, uid: 'x' });
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
      const ms = Date.parse(s) + oldMins * 60000;
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
  return { ok: true, ics: ics2, when: fresh.when };
}

module.exports = { registerInfo, buildEvent, moveEvent, parseEventObjects };
