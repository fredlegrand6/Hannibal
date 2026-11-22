// ─────────────────────────────────────────────────────────────────────────
// CALENDAR ASSIST: the thinking Hannibal does BEFORE he asks Fred "book it?".
//
// Fred's brief (22 Nov 2026), after real use went wrong:
//   1. a time that already passed today is never moved by itself: ask
//      ("2pm has passed: tomorrow at 2, or later today?");
//   2. every add and move is checked for clashes: name the clash, offer the
//      next free slot;
//   3. bookings go to "Werk" unless Fred names another calendar, and the
//      question says which;
//   4. the question reads back title, weekday + date, time, length, calendar;
//   5. "cancel my call with Jay tomorrow" finds the event by person/title/day;
//      several matches → ask which;
//   6. a booking offers a reminder (e.g. 15 min before) that is LINKED to the
//      event (moving/deleting the event moves/cancels it);
//   7. a repeating event: always ask "just this one or the whole series";
//   9. "tomorrow", "next Friday", "Sunday at 11" resolve in Fred's own time
//      zone (Bussum and Ibiza are both Central European Time).
// (8, reading every write back, lives in info-handlers.js.)
//
// Everything here is plain functions (no network), so each rule is tested on
// its own (test-calendar-assist.js). createCalendarPreflight() glues them into
// the preflight claude-tools runs before the voice yes/no gate: it can ask
// Fred a question first (nothing is booked), or hand the gate the exact
// question with every detail filled in.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

// ── Fred's time zone ────────────────────────────────────────────────────────
// HANNIBAL_TZ wins; otherwise the machine's own zone (the Mac follows Fred;
// the server's Docker image is set to Europe/Amsterdam); then Amsterdam.
function fredTz(env = process.env) {
  const own = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return null; } })();
  return String(env.HANNIBAL_TZ || '').trim() || own || 'Europe/Amsterdam';
}

function tzOffsetMs(tz, utcMs) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - utcMs;
}
// Wall-clock parts of a moment in `tz`: { y, mo (1-12), d, h, mi, wd (0 = Sunday) }.
function partsIn(ms, tz) {
  const l = new Date(ms + tzOffsetMs(tz, ms));
  return { y: l.getUTCFullYear(), mo: l.getUTCMonth() + 1, d: l.getUTCDate(), h: l.getUTCHours(), mi: l.getUTCMinutes(), wd: l.getUTCDay() };
}
// The moment a wall clock in `tz` shows y-mo-d h:mi.
function wallMs(y, mo, d, h, mi, tz) {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let ms = wall - tzOffsetMs(tz, wall);
  ms = wall - tzOffsetMs(tz, ms);       // second pass settles the DST edge
  return ms;
}
const addDays = (day, n) => { const x = new Date(Date.UTC(day.y, day.mo - 1, day.d + n)); return { y: x.getUTCFullYear(), mo: x.getUTCMonth() + 1, d: x.getUTCDate(), wd: x.getUTCDay() }; };
const dayOf = (ms, tz) => { const p = partsIn(ms, tz); return { y: p.y, mo: p.mo, d: p.d, wd: p.wd }; };
const sameDay = (a, b) => a.y === b.y && a.mo === b.mo && a.d === b.d;
const dayDiff = (a, b) => Math.round((Date.UTC(b.y, b.mo - 1, b.d) - Date.UTC(a.y, a.mo - 1, a.d)) / 864e5);
const pad = (n) => String(n).padStart(2, '0');
const isoDay = (day) => `${day.y}-${pad(day.mo)}-${pad(day.d)}`;
function isoLocal(ms, tz) { const p = partsIn(ms, tz); return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`; }

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const fmtDate = (day) => `${WEEKDAYS[day.wd != null ? day.wd : addDays(day, 0).wd]} ${day.d} ${MONTHS[day.mo - 1]}`;
const fmtTime = (ms, tz) => { const p = partsIn(ms, tz); return `${pad(p.h)}:${pad(p.mi)}`; };
// "Monday 23 November at 14:00"
const fmtWhen = (ms, tz) => `${fmtDate(dayOf(ms, tz))} at ${fmtTime(ms, tz)}`;
const fmtLength = (mins) => {
  const m = Math.round(Number(mins) || 0);
  if (m >= 60 && m % 60 === 0) return m === 60 ? '1 hour' : `${m / 60} hours`;
  if (m > 60) return `${Math.floor(m / 60)} hour${m >= 120 ? 's' : ''} ${m % 60} minutes`;
  return `${m} minutes`;
};

// ── 9. relative dates ───────────────────────────────────────────────────────
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const DAY_WORDS = {
  sunday: 0, sun: 0, zondag: 0, dimanche: 0, domingo: 0,
  monday: 1, mon: 1, maandag: 1, lundi: 1, lunes: 1,
  tuesday: 2, tue: 2, tues: 2, dinsdag: 2, mardi: 2, martes: 2,
  wednesday: 3, wed: 3, woensdag: 3, mercredi: 3, miercoles: 3,
  thursday: 4, thu: 4, thurs: 4, donderdag: 4, jeudi: 4, jueves: 4,
  friday: 5, fri: 5, vrijdag: 5, vendredi: 5, viernes: 5,
  saturday: 6, sat: 6, zaterdag: 6, samedi: 6, sabado: 6,
};
const MONTH_WORDS = { jan: 1, january: 1, januari: 1, feb: 2, february: 2, februari: 2, mar: 3, march: 3, maart: 3, apr: 4, april: 4, may: 5, mei: 5, jun: 6, june: 6, juni: 6, jul: 7, july: 7, juli: 7, aug: 8, august: 8, augustus: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, okt: 10, oktober: 10, nov: 11, november: 11, dec: 12, december: 12 };

// Fred's words (or an ISO time) → a moment in his time zone.
//   { ok, ms, day, allDay, hasDay, hasTime, iso, relative }   or   { ok:false, error }
// Rules, so "next Friday" never surprises (the read-back names the date anyway):
//   • "Friday" / "this Friday" / "next Friday" = the first Friday after today;
//     "Friday next week" = the Friday of next week (weeks start Monday);
//   • a weekday that is today means today ("Sunday at 11" said on Sunday);
//   • a bare hour 1-7 with no am/pm is the afternoon ("at 2" = 14:00), 8-12 as said.
function resolveWhen(text, { now = Date.now(), tz = fredTz() } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, error: 'no day or time given' };
  const today = dayOf(now, tz);
  let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/);
  if (m) {
    const day = { y: +m[1], mo: +m[2], d: +m[3] }; day.wd = addDays(day, 0).wd;
    if (m[4] == null) return { ok: true, day, allDay: true, hasDay: true, hasTime: false, ms: wallMs(day.y, day.mo, day.d, 0, 0, tz), iso: isoDay(day) };
    const ms = wallMs(day.y, day.mo, day.d, +m[4], +m[5], tz);
    return { ok: true, day, allDay: false, hasDay: true, hasTime: true, ms, iso: isoLocal(ms, tz) };
  }
  const s = ` ${fold(raw).replace(/[,!?]/g, ' ').replace(/\s+/g, ' ')} `;

  // "in 2 hours", "in 30 minutes", "over een uur"
  m = s.match(/\b(?:in|over) (\d+|an|a|een|one|half an?) ?(hours?|hrs?|uur|minutes?|mins?|minuten)\b/);
  if (m) {
    const n = /^\d+$/.test(m[1]) ? +m[1] : /half/.test(m[1]) ? 0.5 : 1;
    const ms = now + n * (/^(h|uur)/.test(m[2]) ? 3600000 : 60000);
    return { ok: true, ms, day: dayOf(ms, tz), allDay: false, hasDay: true, hasTime: true, relative: true, iso: isoLocal(ms, tz) };
  }

  // ── the day
  let day = null; let hasDay = true;
  if (/\b(day after tomorrow|overmorgen|apres-demain|pasado manana)\b/.test(s)) day = addDays(today, 2);
  else if (/\b(tomorrow|tmrw|morgen|demain|manana)\b/.test(s)) day = addDays(today, 1);
  else if (/\b(today|tonight|vandaag|vanavond|aujourd'hui|ce soir|hoy|this (morning|afternoon|evening))\b/.test(s)) day = today;
  if (!day) {
    m = s.match(/\bin (\d+) (days?|dagen)\b/);
    if (m) day = addDays(today, +m[1]);
  }
  if (!day) {
    // "23 November", "November 23", "23 nov", "23/11", "23-11"
    let dd = null, mm = null;
    m = s.match(/\b(\d{1,2})(?:st|nd|rd|th|e)? (?:of )?([a-z]{3,9})\b/);
    if (m && MONTH_WORDS[m[2]]) { dd = +m[1]; mm = MONTH_WORDS[m[2]]; }
    if (dd == null) { m = s.match(/\b([a-z]{3,9}) (\d{1,2})(?:st|nd|rd|th)?\b/); if (m && MONTH_WORDS[m[1]]) { dd = +m[2]; mm = MONTH_WORDS[m[1]]; } }
    if (dd == null) { m = s.match(/\b(\d{1,2})[/-](\d{1,2})\b/); if (m && +m[2] >= 1 && +m[2] <= 12) { dd = +m[1]; mm = +m[2]; } }
    if (dd != null) {
      let y = today.y;
      if (mm < today.mo || (mm === today.mo && dd < today.d)) y += 1;   // "3 January" said in November = next year
      day = { y, mo: mm, d: dd }; day.wd = addDays(day, 0).wd;
    }
  }
  let byWeekday = false;
  if (!day) {
    const words = s.trim().split(' ');
    const at = words.findIndex((w) => DAY_WORDS[w] != null);
    if (at >= 0) {
      const wd = DAY_WORDS[words[at]];
      byWeekday = true;
      const nextWeek = /\b(next week|volgende week|la semaine prochaine|la semana que viene)\b/.test(s);
      if (nextWeek) {
        const monday = addDays(today, ((8 - today.wd) % 7) || 7);       // Monday of next week
        day = addDays(monday, (wd + 6) % 7);
      } else {
        let ahead = (wd - today.wd + 7) % 7;
        if (ahead === 0 && /\b(next|volgende|prochain|proximo)\b/.test(s)) ahead = 7;   // "next Sunday" said on Sunday
        day = addDays(today, ahead);
      }
    }
  }
  if (!day) { day = today; hasDay = false; }
  if (day.wd == null) day.wd = addDays(day, 0).wd;

  // ── the time
  let h = null, mi = 0;
  if (/\b(noon|midday|middag|midi|mediodia)\b/.test(s)) h = 12;
  else if (/\bmidnight\b/.test(s)) h = 0;
  m = h == null && s.match(/\b(\d{1,2})[:.h](\d{2}) ?(am|pm|a\.m\.|p\.m\.)?/);
  if (m) { h = +m[1]; mi = +m[2]; if (m[3]) h = ampm(h, m[3]); }
  m = h == null && s.match(/\b(\d{1,2}) ?(am|pm|a\.m\.|p\.m\.|uur|u)\b/);
  if (m) h = /uur|^u$/.test(m[2]) ? bareHour(+m[1]) : ampm(+m[1], m[2]);
  // "at 11", "om 3", "a las 5", "Sunday at 11"
  m = h == null && s.match(/\b(?:at|om|a las|a la|vers|a|à) (\d{1,2})\b(?! ?(?:days?|dagen|hours?|minutes?|november|december|january|[a-z]{3,9}\b))/);
  if (m) h = bareHour(+m[1]);
  if (h == null && hasDay) {
    m = s.trim().match(/^(?:[a-z]+ )*?(\d{1,2})$/);          // "tomorrow 11"
    if (m && !/\b\d{1,2} ?[a-z]/.test(s)) h = bareHour(+m[1]);
  }
  if (h == null) {
    if (!hasDay) return { ok: false, error: `could not tell the day or time in "${raw}"` };
    return { ok: true, day, allDay: true, hasDay, hasTime: false, ms: wallMs(day.y, day.mo, day.d, 0, 0, tz), iso: isoDay(day) };
  }
  if (h > 23 || mi > 59) return { ok: false, error: `"${raw}" is not a time of day` };
  const ms = wallMs(day.y, day.mo, day.d, h, mi, tz);
  return { ok: true, ms, day, allDay: false, hasDay, hasTime: true, iso: isoLocal(ms, tz), ...(byWeekday ? { byWeekday } : {}) };
}
function ampm(h, tag) { const pm = /p/.test(tag); if (h === 12) return pm ? 12 : 0; return pm ? h + 12 : h; }
function bareHour(h) { return h >= 1 && h <= 7 ? h + 12 : h; }

// ── 1. a time that has already passed ───────────────────────────────────────
// start: the resolved start Claude passes; said: Fred's own words, if given.
// Returns null (fine) or { ask } — a question for Fred; nothing is booked.
// The silent next-day move is caught too: Fred said "2pm" (no day), 14:00
// today has passed, and the start handed in is tomorrow 14:00.
function pastTimeQuestion({ start, said, now = Date.now(), tz = fredTz(), what = 'it' } = {}) {
  const r = resolveWhen(start, { now, tz });
  if (!r.ok) return null;
  const today = dayOf(now, tz);
  const s = said ? resolveWhen(said, { now, tz }) : null;
  const sameClock = s && s.ok && s.hasTime && r.hasTime && fmtTime(s.ms, tz) === fmtTime(r.ms, tz);
  const silentlyTomorrow = s && s.ok && !s.hasDay && s.hasTime && s.ms < now && sameClock
    && dayDiff(today, r.day) === 1;
  const passedToday = (r.hasTime && r.ms < now - 60000 && sameDay(r.day, today))
    || (s && s.ok && s.hasTime && !s.relative && s.ms < now - 60000 && sameDay(s.day, today) && sameClock);
  const clock = fmtTime((s && s.ok && s.hasTime ? s : r).ms, tz);
  if (passedToday || silentlyTomorrow) {
    const t = partsIn(r.ms, tz);
    // "Sunday at 11" said on Sunday afternoon: the other choice is next Sunday.
    const weekly = (s && s.ok && s.byWeekday) || (!s && r.byWeekday);
    const alt = addDays(today, weekly ? 7 : 1);
    const altMs = wallMs(alt.y, alt.mo, alt.d, t.h, t.mi, tz);
    return {
      ask: `${clock} today has already passed. Do you mean ${weekly ? 'next week' : 'tomorrow'}, ${fmtDate(alt)}, at ${clock}, or later today?`,
      reason: 'past-time',
      options: { [weekly ? 'next_week' : 'tomorrow']: isoLocal(altMs, tz) },
    };
  }
  if (r.hasTime ? r.ms < now - 60000 : dayDiff(today, r.day) < 0) {
    return { ask: `${r.hasTime ? fmtWhen(r.ms, tz) : fmtDate(r.day)} is in the past. Which day did you mean for ${what}?`, reason: 'past-day' };
  }
  return null;
}

// ── 2. clashes and the next free slot ───────────────────────────────────────
// events: calendar.events entries ({ ts, endTs?, allDay, title, id, occurrence }).
// All-day entries (birthdays, "Ibiza") never count as a clash.
const endOf = (e) => (Number(e.endTs) > Number(e.ts) ? Number(e.endTs) : Number(e.ts) + 60 * 60000);
function findClashes(events, startMs, endMs, { ignore } = {}) {
  return (events || []).filter((e) => !e.allDay && Number.isFinite(Number(e.ts))
    && !(ignore && e.id && e.id === ignore.id && (!ignore.occurrence || !e.occurrence || e.occurrence === ignore.occurrence))
    && Number(e.ts) < endMs && endOf(e) > startMs);
}
// The first slot of `minutes` from `fromMs` (on a quarter hour) that clashes
// with nothing, inside Fred's day (08:00-21:00 unless the wanted time is
// outside that already), looking up to `days` days ahead.
function nextFreeSlot(events, fromMs, minutes, { tz = fredTz(), now = Date.now(), days = 14, ignore, dayStart = 8, dayEnd = 21 } = {}) {
  const len = Math.max(5, Number(minutes) || 60) * 60000;
  const q = 15 * 60000;
  let t = Math.ceil(Math.max(fromMs, now) / q) * q;
  const stop = fromMs + days * 864e5;
  const want = partsIn(fromMs, tz);
  const open = Math.min(dayStart, want.h);
  const close = Math.max(dayEnd, want.h + 1);
  while (t < stop) {
    const p = partsIn(t, tz);
    const endP = partsIn(t + len, tz);
    const endsLate = endP.h > close || (endP.h === close && endP.mi > 0) || endP.d !== p.d;
    if (p.h < open) { t = wallMs(p.y, p.mo, p.d, open, 0, tz); continue; }
    if (endsLate) { const nd = addDays(p, 1); t = wallMs(nd.y, nd.mo, nd.d, open, 0, tz); continue; }
    const hit = findClashes(events, t, t + len, { ignore });
    if (!hit.length) return t;
    t = Math.ceil(Math.max(...hit.map(endOf)) / q) * q;
  }
  return null;
}
function clashQuestion({ events, startMs, minutes, tz = fredTz(), now = Date.now(), ignore, verb = 'Book' } = {}) {
  const endMs = startMs + Math.max(5, Number(minutes) || 60) * 60000;
  const hit = findClashes(events, startMs, endMs, { ignore });
  if (!hit.length) return null;
  const names = hit.slice(0, 3).map((e) => `“${e.title}” (${fmtTime(e.ts, tz)} to ${fmtTime(endOf(e), tz)})`);
  const free = nextFreeSlot(events, startMs, minutes, { tz, now, ignore });
  const freeTxt = free == null ? '' : (sameDay(dayOf(free, tz), dayOf(startMs, tz)) ? `at ${fmtTime(free, tz)}` : `on ${fmtWhen(free, tz)}`);
  return {
    ask: `That clashes with ${names.join(' and ')} on ${fmtDate(dayOf(startMs, tz))}. `
      + (free == null ? 'I see no free slot in the next two weeks. Keep it anyway, or pick another time?'
        : `The next free slot is ${freeTxt}. ${verb === 'Move' ? 'Move it there' : 'Book that'} instead, or keep ${fmtTime(startMs, tz)} anyway?`),
    reason: 'clash',
    clashes: hit.map((e) => ({ title: e.title, when: fmtWhen(e.ts, tz), calendar: e.calendar })),
    ...(free != null ? { next_free: isoLocal(free, tz) } : {}),
  };
}

// ── 3. which calendar ───────────────────────────────────────────────────────
const SYNONYMS = [
  ['werk', 'work', 'business', 'zakelijk', 'office', 'kantoor', 'revalis'],
  ['prive', 'private', 'personal', 'persoonlijk', 'home', 'thuis', 'family', 'familie'],
];
const groupOf = (n) => SYNONYMS.findIndex((g) => g.includes(n));
const calKey = (s) => fold(s).replace(/[^a-z0-9]+/g, ' ').trim();
// account: caldav.js { read:[{url,name,writable}], write }. Default: "Werk"
// (HANNIBAL_DEFAULT_CALENDAR), else the account's own booking calendar.
function pickCalendar(account, name, { env = process.env } = {}) {
  const cals = (account && account.read) || [];
  const mine = cals.filter((c) => c.writable !== false);
  const find = (want) => {
    const k = calKey(want); if (!k) return null;
    const g = groupOf(k);
    // "private" → Privé before Home: the closer word of the same group wins.
    const inGroup = g < 0 ? [] : cals.filter((c) => SYNONYMS[g].includes(calKey(c.name)))
      .sort((x, y) => SYNONYMS[g].indexOf(calKey(x.name)) - SYNONYMS[g].indexOf(calKey(y.name)));
    return cals.find((c) => calKey(c.name) === k)
      || inGroup[0]
      || cals.find((c) => calKey(c.name).startsWith(k) || k.startsWith(calKey(c.name)))
      || null;
  };
  if (String(name || '').trim()) {
    const c = find(name);
    if (!c) return { error: `there is no calendar called "${name}". Fred's calendars: ${mine.map((x) => x.name).join(', ') || 'none found'}` };
    if (c.writable === false) return { error: `${c.name} is a calendar Fred can only read: pick another (${mine.map((x) => x.name).join(', ')})` };
    return { calendar: c, named: true };
  }
  const def = find(env.HANNIBAL_DEFAULT_CALENDAR || 'Werk');
  if (def && def.writable !== false) return { calendar: def, named: false };
  const fallback = (account && account.write) || mine[0];
  return fallback ? { calendar: fallback, named: false } : { error: 'no calendar Fred can write to was found' };
}

// ── 4. the question Fred hears ──────────────────────────────────────────────
function bookingQuestion({ title, startMs, allDay, day, minutes, calendar, remindMinutes, location, tz = fredTz() } = {}) {
  const where = location ? `, at ${location}` : '';
  const when = allDay ? `on ${fmtDate(day || dayOf(startMs, tz))}, all day` : `on ${fmtWhen(startMs, tz)} for ${fmtLength(minutes || 60)}`;
  const rem = !allDay && Number(remindMinutes) > 0
    ? `, with a reminder at ${fmtTime(startMs - remindMinutes * 60000, tz)} (${remindMinutes} minutes before)` : '';
  return `Book “${title}” ${when}${where} in your ${calendar} calendar${rem} — book it?`;
}

// ── 5. find an event from Fred's description ────────────────────────────────
const GENERIC = new Set(['my', 'the', 'a', 'an', 'with', 'met', 'de', 'het', 'een', 'van', 'mijn', 'to', 'for', 'and', 'en', 'of', 'on', 'at', 'om', 'op', 'in',
  'call', 'calls', 'meeting', 'meet', 'appointment', 'afspraak', 'bellen', 'belafspraak', 'gesprek', 'event', 'thing', 'session', 'sessie', 'avec', 'rdv', 'reunion', 'llamada', 'cita']);
const DAYISH = /^(today|tomorrow|tonight|vandaag|morgen|overmorgen|next|this|coming|week|am|pm|uur|\d+(:\d+)?|\d+(am|pm))$/;
const words = (s) => fold(s).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
function matchEvents(events, query, { tz = fredTz(), timeMs } = {}) {
  const q = words(query).filter((w) => !DAYISH.test(w) && DAY_WORDS[w] == null && !MONTH_WORDS[w]);
  const key = q.filter((w) => !GENERIC.has(w));
  const extra = q.filter((w) => GENERIC.has(w) && !['my', 'the', 'a', 'an', 'with', 'met', 'de', 'het', 'een', 'van', 'mijn', 'to', 'for', 'and', 'en', 'of', 'on', 'at', 'om', 'op', 'in'].includes(w));
  const need = key.length ? key : extra;
  if (!need.length) return [];
  const has = (title, w) => words(title).some((t) => t.startsWith(w) || (w.length >= 4 && w.startsWith(t) && t.length >= 4));
  let hits = (events || []).filter((e) => need.every((w) => has(e.title, w)));
  if (timeMs != null) {
    const at = hits.filter((e) => !e.allDay && fmtTime(e.ts, tz) === fmtTime(timeMs, tz));
    if (at.length) hits = at;
  }
  if (hits.length > 1 && key.length && extra.length) {   // "call with Jay": the one that also says "call" wins
    const score = (e) => extra.filter((w) => has(e.title, w)).length;
    const best = Math.max(...hits.map(score));
    const top = hits.filter((e) => score(e) === best);
    if (best > 0) hits = top;
  }
  return hits;
}

// ── 7. repeating events ─────────────────────────────────────────────────────
function seriesQuestion(ev, { tz = fredTz(), verb = 'delete' } = {}) {
  const when = ev && Number.isFinite(Number(ev.ts)) ? (ev.allDay ? fmtDate(dayOf(ev.ts, tz)) : fmtWhen(ev.ts, tz)) : 'this one';
  return {
    ask: `“${ev.title}” repeats. Should I ${verb} just this one (${when}) or the whole series?`,
    reason: 'repeating',
    instruction: 'Ask Fred exactly this. Then call again with scope "this" (and the occurrence) or scope "all".',
  };
}

// ── the preflight claude-tools runs before the voice gate ───────────────────
// deps: { events(days) → calendar.events answer, account() → caldav account,
//         reminders: linked reminders { forEvent(id) }, env, now, tz }
// Returns one of:
//   { result: { ok:true, ask, ... } }   a question for Fred, nothing changed;
//   { result: { ok:false, error } }     cannot be done as asked;
//   { confirm, extra }                  the exact question for the yes/no
//                                       gate, and the resolved details.
function createCalendarPreflight({ events, account, reminders = null, env = process.env, now = () => Date.now(), tz = () => fredTz(env) } = {}) {
  const asked = (q) => ({ result: { ok: true, done: false, ...q, instruction: q.instruction || 'Nothing was changed yet. Ask Fred exactly this, then call this tool again with his answer.' } });
  const daysTo = (ms) => Math.min(31, Math.max(2, dayDiff(dayOf(now(), tz()), dayOf(ms, tz())) + 2));
  const listFor = async (ms) => {
    try { const r = await events(daysTo(ms)); return r && r.ok ? r.events || [] : null; } catch (_) { return null; }
  };
  const remindersFor = async (id) => {
    if (!reminders || !id) return [];
    try { return (await reminders.forEvent(id)) || []; } catch (_) { return []; }
  };

  // Turn a description ("call with Jay", day "tomorrow at 11") into one event.
  async function resolveTarget(p) {
    if (p.id) {
      // Known id: look it up anyway, so the question can say when and where it is now.
      try {
        const got = await events(31);
        const hit = got && got.ok ? (got.events || []).filter((e) => e.id === p.id) : [];
        const one = hit.find((e) => p.occurrence && e.occurrence === p.occurrence) || (hit.length === 1 ? hit[0] : null);
        return { ev: one ? { ...one, ...(hit.length > 1 ? { repeats: true } : {}) } : (hit.length ? { ...hit[0], ts: null, repeats: true } : null) };
      } catch (_) { return { ev: null }; }
    }
    const query = String(p.find || p.title || '').trim();
    if (!query) return { error: 'which event? Give its id, or describe it with find (who or what) and day' };
    const t = tz(); const n = now();
    const when = p.day ? resolveWhen(p.day, { now: n, tz: t }) : null;
    if (p.day && !when.ok) return { error: when.error };
    const span = when ? Math.min(31, Math.max(1, dayDiff(dayOf(n, t), when.day) + 1)) : 14;
    let got;
    try { got = await events(span); } catch (e) { return { error: e.message }; }
    if (!got || !got.ok) return { error: (got && got.error) || 'could not read the calendar' };
    let list = got.events || [];
    if (when) list = list.filter((e) => sameDay(dayOf(e.ts, t), when.day));
    const hits = matchEvents(list, query, { tz: t, timeMs: when && when.hasTime ? when.ms : null });
    const show = (e) => ({ id: e.id, title: e.title, when: e.allDay ? `${fmtDate(dayOf(e.ts, t))}, all day` : fmtWhen(e.ts, t), calendar: e.calendar, ...(e.occurrence ? { occurrence: e.occurrence, repeats: true } : {}) });
    const dayTxt = when ? ` on ${fmtDate(when.day)}` : ' in the next two weeks';
    if (!hits.length) {
      return { result: { ok: false, error: `nothing in the calendar matches “${query}”${dayTxt}. Ask Fred which event he means.`, ...(when ? { that_day: list.map(show) } : {}) } };
    }
    if (hits.length > 1) {
      const opts = hits.slice(0, 5).map((e) => `“${e.title}” ${e.allDay ? 'all day' : `at ${fmtTime(e.ts, t)}`}${when ? '' : ` on ${fmtDate(dayOf(e.ts, t))}`}`);
      return asked({ ask: `I found ${hits.length}${dayTxt}: ${opts.join(', or ')}. Which one?`, reason: 'several-match', matches: hits.map(show),
        instruction: 'Nothing was changed. Ask Fred which one, then call again with that event\'s id.' });
    }
    return { ev: hits[0] };
  }

  async function add(p) {
    const t = tz(); const n = now();
    const title = String(p.title || '').replace(/\s+/g, ' ').trim();
    if (!title) return { result: { ok: false, error: 'the event needs a title' } };
    const r = resolveWhen(p.start || p.said, { now: n, tz: t });
    if (!r.ok) return { result: { ok: false, error: r.error } };
    // Fred's own words win over a start Claude worked out, when they name a day.
    const said = p.said ? resolveWhen(p.said, { now: n, tz: t }) : null;
    const use = said && said.ok && said.hasDay && !said.relative && said.hasTime === r.hasTime && !sameDay(said.day, r.day) ? said : r;
    const past = pastTimeQuestion({ start: use.iso, said: p.said, now: n, tz: t, what: `“${title}”` });
    if (past) return asked(past);
    const a = await account();
    if (!a || a.error) return { result: { ok: false, error: (a && a.error) || 'no calendar' } };
    const cal = pickCalendar(a, p.calendar, { env });
    if (cal.error) return { result: { ok: false, error: cal.error } };
    const minutes = use.allDay ? null : Math.min(Math.max(Math.round(Number(p.minutes) || 60), 5), 24 * 60);
    let clashNote = '';
    if (!use.allDay && p.allow_clash !== true) {
      const list = await listFor(use.ms);
      if (list) { const c = clashQuestion({ events: list, startMs: use.ms, minutes, tz: t, now: n }); if (c) return asked(c); }
      else clashNote = ' (I could not check your calendar for clashes)';
    }
    if (p.remind_minutes === undefined || p.remind_minutes === null || p.remind_minutes === '') {
      if (!use.allDay) {
        return asked({ ask: `Do you want a reminder before “${title}”, say 15 minutes before?`, reason: 'reminder-offer',
          instruction: 'Nothing was booked yet. Ask Fred this (keep it short). Then call again with remind_minutes (e.g. 15, or 0 for no reminder).' });
      }
    }
    const remind = use.allDay ? 0 : Math.max(0, Math.round(Number(p.remind_minutes) || 0));
    if (remind && use.ms - remind * 60000 < n) return asked({ ask: `A reminder ${remind} minutes before would already be in the past. Book it without a reminder?`, reason: 'reminder-too-late' });
    const confirm = bookingQuestion({ title, startMs: use.ms, allDay: use.allDay, day: use.day, minutes, calendar: cal.calendar.name, remindMinutes: remind, location: p.location, tz: t }).replace(' — book it?', `${clashNote} — book it?`);
    return { confirm, extra: { title, start: use.iso, minutes: minutes || undefined, calendar: cal.calendar.name, remind_minutes: remind } };
  }

  async function move(p) {
    const t = tz(); const n = now();
    const target = await resolveTarget(p);
    if (target.error) return { result: { ok: false, error: target.error } };
    if (target.result) return { result: target.result };
    const ev = target.ev;
    const id = p.id || ev.id;
    const title = (ev && ev.title) || p.title;
    const occurrence = p.occurrence || (ev && ev.occurrence);
    const repeats = !!occurrence || (ev && ev.repeats);
    if (repeats && p.scope !== 'this' && p.scope !== 'all') return asked(seriesQuestion(ev || { title, ts: null }, { tz: t, verb: 'move' }));
    const r = resolveWhen(p.start || p.said, { now: n, tz: t });
    if (!r.ok) return { result: { ok: false, error: r.error } };
    const past = pastTimeQuestion({ start: r.iso, said: p.said, now: n, tz: t, what: `“${title}”` });
    if (past) return asked(past);
    const oldLen = ev && Number(ev.endTs) > Number(ev.ts) ? Math.round((ev.endTs - ev.ts) / 60000) : null;
    const minutes = r.allDay ? null : (Number(p.minutes) > 0 ? Math.round(Number(p.minutes)) : (oldLen || 60));
    if (!r.allDay && p.allow_clash !== true && p.scope !== 'all') {
      const list = await listFor(r.ms);
      if (list) { const c = clashQuestion({ events: list, startMs: r.ms, minutes, tz: t, now: n, ignore: { id, occurrence }, verb: 'Move' }); if (c) return asked(c); }
    }
    const linked = await remindersFor(id);
    const from = ev ? ` from ${ev.allDay ? fmtDate(dayOf(ev.ts, t)) : fmtWhen(ev.ts, t)}` : '';
    const to = r.allDay ? `${fmtDate(r.day)}, all day` : `${fmtWhen(r.ms, t)} for ${fmtLength(minutes)}`;
    const only = p.scope === 'this' ? ' (only this one; the other repeats stay)' : p.scope === 'all' ? ' (the whole series, every repeat)' : '';
    const rem = linked.length && !r.allDay
      ? `; its reminder moves to ${fmtTime(r.ms - (linked[0].offsetMin || 0) * 60000, t)}` : '';
    const calTxt = ev && ev.calendar ? ` in your ${ev.calendar} calendar` : '';
    return { confirm: `Move “${title}”${only}${calTxt}${from} to ${to}${rem} — move it?`,
      extra: { id, title, start: r.iso, ...(minutes ? { minutes } : {}), ...(occurrence ? { occurrence } : {}) } };
  }

  async function del(p) {
    const t = tz();
    const target = await resolveTarget(p);
    if (target.error) return { result: { ok: false, error: target.error } };
    if (target.result) return { result: target.result };
    const ev = target.ev;
    const id = p.id || ev.id;
    const title = (ev && ev.title) || p.title;
    const occurrence = p.occurrence || (ev && ev.occurrence);
    const repeats = !!occurrence || (ev && ev.repeats);
    if (repeats && p.scope !== 'this' && p.scope !== 'all') return asked(seriesQuestion(ev || { title, ts: null }, { tz: t, verb: 'delete' }));
    const linked = await remindersFor(id);
    const when = ev ? (ev.allDay ? `${fmtDate(dayOf(ev.ts, t))}, all day` : fmtWhen(ev.ts, t)) : (p.when || '');
    const calTxt = ev && ev.calendar ? `your ${ev.calendar} calendar` : 'your calendar';
    const rem = linked.length ? `, and its reminder at ${linked.map((x) => fmtTime(x.triggerTs, t)).join(' and ')}` : '';
    let confirm;
    if (p.scope === 'all') confirm = `Delete the whole repeating “${title}”, every time it happens, from ${calTxt}${rem} — delete it?`;
    else if (p.scope === 'this') confirm = `Delete only this one “${title}”${when ? ` (${when})` : ''}; the other repeats stay — delete it?`;
    else confirm = `Delete “${title}”${when ? ` on ${when}` : ''} from ${calTxt}${rem} — delete it?`;
    return { confirm, extra: { id, title, ...(when ? { when } : {}), ...(occurrence ? { occurrence } : {}) } };
  }

  return async function preflight(name, params = {}) {
    const tool = String(name).replace(/^calendar\./, '');
    const p = { ...params };
    if (tool === 'add') return add(p);
    if (tool === 'move') return move(p);
    if (tool === 'delete') return del(p);
    return {};
  };
}

module.exports = {
  fredTz, tzOffsetMs, partsIn, wallMs, addDays, dayOf, isoLocal, fmtWhen, fmtDate, fmtTime, fmtLength,
  resolveWhen, pastTimeQuestion, findClashes, nextFreeSlot, clashQuestion, pickCalendar, bookingQuestion,
  matchEvents, seriesQuestion, createCalendarPreflight,
};
