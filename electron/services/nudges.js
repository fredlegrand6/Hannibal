// ─────────────────────────────────────────────────────────────────────────
// NUDGES: Hannibal speaks first when something needs Fred.
//
// Every 20 minutes during the day, cheap checks (no AI) look for:
//   • a meeting starting in 2-40 minutes (under 5 minutes it is urgent);
//   • a trip coming up (a flight, Ibiza...): once a few days ahead, once the
//     day before;
//   • mail from a real person, sent to Fred directly, unanswered for 2+ days
//     (no reply flag and nothing in Sent to that address since).
// The most urgent one becomes a short prompt that Claude says in its own
// words, offering the next step ("want me to draft a reply?"). Nudges are
// read-only: replying or booking still goes through Fred's yes.
//
// WHEN TO STAY QUIET (Hannibal's own rule): only things that are
// time-sensitive (a meeting, a trip) or involve Fred's people (mail from
// someone in his saved facts after 2 days; from anyone else, only after 4),
// and never while Fred is in the zone: on a call, or deep in work (busy at
// the keyboard in a work app for the last 10 minutes). Then he holds it; only
// a meeting about to start goes to the phone as a quiet text instead.
//
// Each thing is brought up once (data/nudges.json), at most HANNIBAL_NUDGE_MAX
// a day (default 5), between HANNIBAL_NUDGE_FROM and _UNTIL (08:00-21:00).
// Not said yet (Fred mid-topic, see src/nudge-gate.js): it stays in line, most
// urgent first, and is tried again every 2 minutes. The desk speaks them; the
// always-on server sends them to the phone while the Mac is away, and the two
// share which ones were already said.
// Off: HANNIBAL_NUDGES=0.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');

const TRIP_WORDS = /\b(flight|flug|vlucht|vol|vuelo|flying|ibiza|airport|luchthaven|schiphol|aeropuerto|boarding|klm|transavia|vueling|ryanair|easyjet|iberia|lufthansa)\b|✈/i;
const FLIGHT_NO = /\b(?:HV|KL|VY|FR|U2|IB|LH|BA|AF|TO|UX|EW)\s?\d{2,4}\b/;   // airline codes, upper case only
const TRIP = { test: (t) => TRIP_WORDS.test(t) || FLIGHT_NO.test(t) };
const NO_REPLY = /(no-?reply|do-?not-?reply|notifications?@|mailer-daemon|newsletter|news@|info@|support@|billing@|invoice)/i;
const MIN = 60 * 1000;
const H = 60 * MIN;

function parseHHMM(s, fallback) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : fallback;
}
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
const fmtWhen = (ts) => new Date(ts).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

const LEAD = '[Proactive: Fred did not ask; you are bringing this up yourself, like a good PA leaning in.]';
const TAIL = 'Say it in one or two natural sentences and offer the obvious next step. Do not act yet: anything that sends or books waits for his yes.';

// What is worth bringing up now, most urgent first. Pure: easy to test.
function findNudges({ events = [], mail = [], now, said = new Set(), isKnown = () => false }) {
  const out = [];
  for (const e of events) {
    if (!e || !Number.isFinite(e.ts)) continue;
    const until = e.ts - now;
    const title = String(e.title || '').trim();
    if (!e.allDay && until >= 2 * MIN && until <= 40 * MIN) {
      out.push({ key: `soon:${e.ts}:${norm(title)}`, rank: 0, urgent: until <= 5 * MIN,
        text: `"${title}" starts at ${e.time || fmtWhen(e.ts)}, in ${Math.round(until / MIN)} minutes.`,
        prompt: `${LEAD} Fred has "${title}" at ${e.time || fmtWhen(e.ts)} (in ${Math.round(until / MIN)} minutes). Give him a heads-up. ${TAIL}` });
    }
    if (TRIP.test(title)) {
      if (until > 0 && until <= 36 * H) {
        out.push({ key: `trip1:${e.ts}:${norm(title)}`, rank: 1,
          text: `Tomorrow-ish: "${title}" (${fmtWhen(e.ts)}).`,
          prompt: `${LEAD} Fred's trip is close: "${title}" on ${fmtWhen(e.ts)}. Remind him and offer to check what he needs (check-in, time to leave, anything to wrap up first). ${TAIL}` });
      } else if (until > 36 * H && until <= 7 * 24 * H) {
        out.push({ key: `trip7:${e.ts}:${norm(title)}`, rank: 3,
          text: `Coming up: "${title}" on ${fmtWhen(e.ts)}.`,
          prompt: `${LEAD} Fred has a trip coming up: "${title}" on ${fmtWhen(e.ts)}. Mention it and offer to help him get things ready before he goes. ${TAIL}` });
      }
    }
  }
  for (const m of mail) {
    if (!m || NO_REPLY.test(m.from_email || '') || m.newsletter || m.to_me_directly === false) continue;
    const known = !!isKnown(m);
    if (!known && (Number(m.age_hours) || 0) < 96) continue;      // not one of Fred's people: give it 4 days
    const days = Math.max(2, Math.floor((Number(m.age_hours) || 48) / 24));
    out.push({ key: `mail:${norm(m.from_email)}:${norm(m.subject).slice(0, 60)}`, rank: known ? 2 : 4,
      text: `${m.from}'s mail "${m.subject}" has been waiting ${days} days for an answer.`,
      prompt: `${LEAD} ${m.from} <${m.from_email}> wrote to Fred ${days} days ago and has no answer yet. Subject: "${m.subject}". `
        + `It says: "${String(m.preview || '').slice(0, 300)}". Mention it briefly and offer to draft a reply (mail.reply, uid ${m.uid}, to ${m.from_email}). ${TAIL}` });
  }
  return out.filter((n) => !said.has(n.key)).sort((a, b) => a.rank - b.rank);
}

// Is this sender one of Fred's people? Their name or address is in his saved facts.
function knownPeople(factsText) {
  const hay = norm(factsText);
  const words = new Set(hay.split(' '));
  return (m) => {
    const email = String(m.from_email || '').toLowerCase();
    if (email && String(factsText || '').toLowerCase().includes(email)) return true;
    const names = norm(m.from).split(' ').filter((w) => w.length > 2);
    if (!names.length) return false;
    // full name, or a first name that appears in the facts
    return hay.includes(names.join(' ')) || words.has(names[0]);
  };
}

// IN THE ZONE: on a call, or busy in a work app for the last 10 minutes.
const CALL_APPS = /\b(zoom\.us|zoom|microsoft teams|teams|facetime|webex|whereby|skype|discord)\b/i;
const CALL_TITLES = /(meet\.google\.com|google meet|zoom meeting|teams meeting|huddle)/i;
const WORK_APPS = /\b(cursor|code|visual studio code|xcode|terminal|iterm2?|warp|claude|figma|pages|microsoft word|word|excel|numbers|keynote|powerpoint|final cut pro|logic pro|davinci resolve|notion|sublime text|android studio)\b/i;
function createZoneWatcher({ sample, windowSamples = 10 } = {}) {
  const recent = [];      // [{ app, title, idle }] one per minute
  let last = null;
  async function poll() {
    try { last = await sample(); } catch (_) { last = null; }
    if (last) { recent.push(last); while (recent.length > windowSamples) recent.shift(); }
    return last;
  }
  function status() {
    if (last && (CALL_APPS.test(last.app || '') || CALL_TITLES.test(last.title || ''))) return { zone: true, why: 'on a call' };
    if (recent.length >= windowSamples) {
      const busy = recent.filter((r) => Number(r.idle) < 90 && WORK_APPS.test(r.app || '')).length;
      if (busy >= windowSamples - 2) return { zone: true, why: `deep in ${last ? last.app : 'work'}` };
    }
    return { zone: false };
  }
  return { poll, status };
}

function createNudger({ getEvents, getMail, deliver, statePath, now = () => new Date(), env = process.env, onSaid = null, everyMs = 20 * MIN,
  isKnown = () => false, zone = () => ({ zone: false }), quietText = null } = {}) {
  const file = statePath || path.join(__dirname, '..', '..', 'data', 'nudges.json');
  let state = { said: {}, days: {} };
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); state = { said: j.said || {}, days: j.days || {} }; } catch (_) {}
  const save = () => {
    // Forget what was said more than 30 days ago.
    const cut = now().getTime() - 30 * 24 * H;
    for (const [k, t] of Object.entries(state.said)) if (t < cut) delete state.said[k];
    for (const d of Object.keys(state.days)) if (d < dayKey(new Date(cut))) delete state.days[d];
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(state, null, 1)); } catch (_) {}
  };
  let lastRun = 0;
  let busy = false;
  const enabled = () => !/^(0|false|off|no)$/i.test(env.HANNIBAL_NUDGES || '');
  const maxPerDay = () => parseInt(env.HANNIBAL_NUDGE_MAX || '5', 10);

  function markSaid(keys, at = now().getTime()) {
    let n = 0;
    for (const k of Array.isArray(keys) ? keys : []) if (k && !state.said[k]) { state.said[k] = at; n += 1; }
    if (n) save();
    return n;
  }

  // Called every minute; does real work every `everyMs`. Returns what it did.
  async function tick({ force = false } = {}) {
    if (!enabled()) return 'disabled';
    const d = now();
    const mins = d.getHours() * 60 + d.getMinutes();
    if (mins < parseHHMM(env.HANNIBAL_NUDGE_FROM, 8 * 60) || mins >= parseHHMM(env.HANNIBAL_NUDGE_UNTIL, 21 * 60)) return 'outside-hours';
    if (busy) return 'busy';
    if (!force && d.getTime() - lastRun < everyMs) return 'not-yet';
    if ((state.days[dayKey(d)] || 0) >= maxPerDay()) return 'enough-today';
    busy = true; lastRun = d.getTime();
    try {
      const [ev, ml] = await Promise.all([
        Promise.resolve().then(getEvents).catch(() => null),
        Promise.resolve().then(getMail).catch(() => null),
      ]);
      const list = findNudges({ events: (ev && ev.events) || [], mail: (ml && ml.messages) || [], now: d.getTime(),
        said: new Set(Object.keys(state.said)), isKnown });
      if (!list.length) return 'nothing';
      const n = list[0];
      const z = zone() || {};
      let ok;
      if (z.zone) {
        // Fred is in the zone: hold it. Only a meeting about to start gets through, as a quiet text.
        if (n.rank !== 0 || !quietText) { console.log(`[nudge] holding "${n.text}" (Fred is ${z.why})`); lastRun = d.getTime() - everyMs + 5 * MIN; return 'held'; }
        console.log(`[nudge] Fred is ${z.why}: quiet text instead: ${n.text}`);
        ok = await quietText(n);
      } else {
        console.log(`[nudge] bringing up: ${n.text}`);
        ok = await deliver(n);
        // Not at the desk (or never a quiet moment): time-sensitive ones still reach the phone.
        if (!ok && n.rank <= 1 && quietText) ok = await quietText(n);
      }
      if (ok) {
        markSaid([n.key]);
        state.days[dayKey(d)] = (state.days[dayKey(d)] || 0) + 1; save();
        try { onSaid && onSaid([n.key]); } catch (_) {}
        return 'said';
      }
      // Not said (no gap between topics yet): it stays first in line and is
      // tried again in 2 minutes, not dropped until the next 20-minute round.
      lastRun = d.getTime() - everyMs + 2 * MIN;
      return 'not-delivered';
    } finally { busy = false; }
  }

  return { tick, markSaid, said: () => Object.keys(state.said), get state() { return state; } };
}

module.exports = { createNudger, createZoneWatcher, findNudges, knownPeople, TRIP };
