// ─────────────────────────────────────────────────────────────────────────
// NAVIGATION — Hannibal + Google Maps on Fred's iPhone.
//   • "take me to Ibiza airport"  → the phone opens Google Maps turn-by-turn
//     (or, when the app isn't on screen, a notification: tap = start route);
//   • "how long to get home?"      → the phone works out the drive time with
//     live traffic (Apple Maps routing on the phone, from where Fred is);
//   • "leave now" warning          → for appointments with an address in the
//     next 3 hours, the server asks the phone for the drive time now and then,
//     and tells Fred once when it is time to leave (10 min spare).
// Sharing the ETA with someone goes through the normal WhatsApp tool, so it
// still needs Fred's yes.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');

const LOOKAHEAD_MS = 3 * 3600e3;     // appointments starting within 3 hours
const SPARE_MS = 10 * 60e3;          // leave 10 minutes early
const TICK_MS = 5 * 60e3;

function mapsUrl(destination) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(String(destination || '').trim())}&travelmode=driving&dir_action=navigate`;
}

function fmtMinutes(m) {
  const n = Math.max(1, Math.round(Number(m) || 0));
  if (n < 60) return `${n} min`;
  const h = Math.floor(n / 60), r = n % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

// phone: { navigate(dest, url) -> 'opened'|'notified'|'none', ask(kind, params, ms) -> answer|null }
// events(days) -> { ok, events:[{ ts, title, time, location, allDay, uid }] }
// notify(text, { url }) — tell Fred (app/push + Telegram)
function createNav({ phone, events, notify, statePath, now = () => Date.now(), log = (...a) => console.log('[nav]', ...a), tz } = {}) {
  let state = { warned: {} };
  try { if (statePath && fs.existsSync(statePath)) state = { warned: {}, ...JSON.parse(fs.readFileSync(statePath, 'utf8')) }; } catch (_) {}
  const save = () => { if (!statePath) return; try { fs.writeFileSync(statePath, JSON.stringify(state, null, 2)); } catch (e) { log('save failed:', e.message); } };
  const nextCheck = new Map();      // event key → when to ask the phone again

  function go(destination) {
    const dest = String(destination || '').trim();
    if (!dest) return { ok: false, error: 'Where to? I need a place or address.' };
    const url = mapsUrl(dest);
    const where = phone ? phone.navigate(dest, url) : 'none';
    if (where === 'opened') return { ok: true, url, note: 'Google Maps is opening the route on his iPhone.' };
    if (where === 'notified') return { ok: true, url, note: 'Sent to his iPhone: tapping the notification starts the route in Google Maps.' };
    return { ok: true, url, note: 'His iPhone app is not reachable right now; give Fred this link to tap.' };
  }

  async function eta(destination) {
    const dest = String(destination || '').trim();
    if (!dest) return { ok: false, error: 'Drive time to where?' };
    if (!phone) return { ok: false, error: 'The drive time comes from Fred\'s iPhone, and the iPhone app is not set up.' };
    const a = await phone.ask('eta', { destination: dest }, 25000);
    if (!a) return { ok: false, error: 'I could not reach the Hannibal app on his iPhone to work out the drive time (it needs to have been opened once since the phone restarted).' };
    if (!a.ok) return { ok: false, error: a.error || 'The iPhone could not work out a route.' };
    const minutes = Math.round(Number(a.minutes));
    const arrive = new Date(now() + minutes * 60e3);
    const at = arrive.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', ...(tz ? { timeZone: tz() } : {}) });
    return { ok: true, destination: a.place || dest, minutes, drive: fmtMinutes(minutes), km: a.km != null ? Math.round(Number(a.km) * 10) / 10 : undefined, arriveAt: at, traffic: 'live traffic, by car, from where his iPhone is now', url: mapsUrl(dest) };
  }

  const keyOf = (e) => `${e.uid || e.title}|${e.ts}`;

  // One pass of the "time to leave" watch.
  async function tick() {
    if (!phone || !events) return;
    let list = [];
    try { const r = await events(2); list = (r && r.ok && r.events) || []; } catch (_) { return; }
    const t = now();
    // Forget warnings for appointments that are over.
    for (const [k, ts] of Object.entries(state.warned)) if (ts < t - 3600e3) delete state.warned[k];
    for (const e of list) {
      if (e.allDay || !e.location || !(e.ts > t) || e.ts - t > LOOKAHEAD_MS) continue;
      const k = keyOf(e);
      if (state.warned[k] || (nextCheck.get(k) || 0) > t) continue;
      const r = await eta(e.location);
      if (!r.ok) { nextCheck.set(k, t + 15 * 60e3); continue; }
      // He's there now: no warning, but look again (he may leave before it starts).
      if (r.minutes <= 3) { nextCheck.set(k, t + 15 * 60e3); continue; }
      const leaveAt = e.ts - r.minutes * 60e3 - SPARE_MS;
      if (t >= leaveAt) {
        const late = t + r.minutes * 60e3 > e.ts;
        const text = late
          ? `🚗 You'll be late for "${e.title}" (${e.time}): it's ${r.drive} to ${e.location} with traffic right now, so you'd arrive around ${r.arriveAt}. Leave now, or shall I let them know?`
          : `🚗 Time to leave for "${e.title}" at ${e.time}: ${r.drive} to ${e.location} with traffic. Tap to start the route.`;
        state.warned[k] = e.ts; save();
        try { await notify(text, { url: r.url }); } catch (err) { log('notify failed:', err.message); }
      } else {
        // Ask again halfway to the moment to leave (between 3 and 30 minutes).
        nextCheck.set(k, t + Math.min(Math.max((leaveAt - t) / 2, 3 * 60e3), 30 * 60e3));
      }
    }
  }

  let timer = null;
  function start() {
    if (timer) return;
    timer = setInterval(() => { tick().catch((e) => log('tick failed:', e.message)); }, TICK_MS);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { go, eta, tick, start, stop, _state: () => state };
}

module.exports = { createNav, mapsUrl, fmtMinutes };
