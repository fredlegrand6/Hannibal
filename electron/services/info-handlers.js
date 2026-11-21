// ─────────────────────────────────────────────────────────────────────────
// INFO HANDLERS — the read tools that need no Mac: GEX131 health, calendar
// (Nextcloud CalDAV), mail (Zoho IMAP via the Python scripts next to this file)
// and the web (SearXNG search + page fetch). Registered by the desk app
// (electron/main.js) and by the always-on server (server/hannibal-server.js).
//   opts: { python, searxngUrl, metricsLocal }
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const { spawn } = require('child_process');
const path = require('path');

function registerInfo(ipcMain, opts = {}) {
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

// ── CALENDAR: fetch today+tomorrow's events from Nextcloud over CalDAV. One
// REPORT (calendar-query) with a time-range filter returns matching VEVENTs as
// raw iCalendar, which we unfold + parse minimally (DTSTART/SUMMARY). Creds live
// in .env as an app password (never the main account password). ──
function parseICalEvents(xml, now) {
  const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const events = [];
  // pull each <...calendar-data>…</…calendar-data> block regardless of ns prefix
  const blocks = xml.match(/<[^>]*calendar-data[^>]*>([\s\S]*?)<\/[^>]*calendar-data>/g) || [];
  for (let raw of blocks) {
    const ics = unesc(raw.replace(/<[^>]*calendar-data[^>]*>/, '').replace(/<\/[^>]*calendar-data>/, ''))
      .replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');  // unfold continuation lines
    for (const vevent of ics.split('BEGIN:VEVENT').slice(1)) {
      const body = vevent.split('END:VEVENT')[0];
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
      events.push({ ts: when.getTime(), time, allDay, title: (summary || '(no title)').trim() });
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

// Nextcloud calendar settings (.env): an app password, never the main one.
function caldav() {
  const base = (process.env.NEXTCLOUD_URL || '').replace(/\/$/, '');
  const user = process.env.NEXTCLOUD_USER, pw = process.env.NEXTCLOUD_APP_PW;
  const cal = process.env.NEXTCLOUD_CALENDAR || 'personal';
  if (!base || !user || !pw) return null;
  return { url: `${base}/remote.php/dav/calendars/${encodeURIComponent(user)}/${cal}/`,
    auth: 'Basic ' + Buffer.from(`${user}:${pw}`).toString('base64') };
}

// Events from today through `days` days ahead (default 2 = today + tomorrow, max 31).
async function fetchCalendar(days) {
  const dav = caldav();
  if (!dav) return { ok: false, error: 'nextcloud creds missing' };
  const n = Math.min(Math.max(Math.round(Number(days) || 2), 1), 31);
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + n);
  const body = `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${fmt(start)}" end="${fmt(end)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  try {
    const res = await fetch(dav.url, {
      method: 'REPORT',
      headers: { Authorization: dav.auth, Depth: '1', 'Content-Type': 'application/xml' },
      body, signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, error: `caldav ${res.status}` };
    return { ok: true, events: parseICalEvents(await res.text(), now) };
  } catch (e) {
    console.log('[calendar] caldav failed', e.message);
    return { ok: false, error: e.message };
  }
}
ipcMain.handle('calendar:events', (_e, days) => fetchCalendar(days));

// Book an event. Only ever reached after Fred's yes (catalog: confirm, ceiling 'never').
// start: local "YYYY-MM-DDTHH:MM" (or "YYYY-MM-DD" for all day).
ipcMain.handle('calendar:add', async (_e, title, start, minutes, location, notes) => {
  const dav = caldav();
  if (!dav) return { ok: false, error: 'nextcloud creds missing' };
  const ev = buildEvent({ title, start, minutes, location, notes });
  if (!ev.ok) return ev;
  try {
    const res = await fetch(`${dav.url}${ev.uid}.ics`, {
      method: 'PUT',
      headers: { Authorization: dav.auth, 'Content-Type': 'text/calendar; charset=utf-8', 'If-None-Match': '*' },
      body: ev.ics, signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, error: `caldav ${res.status}` };
    console.log(`[calendar] booked "${ev.title}" ${ev.when}`);
    return { ok: true, title: ev.title, when: ev.when };
  } catch (e) {
    return { ok: false, error: e.message };
  }
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

module.exports = { registerInfo, buildEvent };
