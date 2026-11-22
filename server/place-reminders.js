// ─────────────────────────────────────────────────────────────────────────
// PLACE REMINDERS — "remind me to buy milk when I get home", "when I land
// in Ibiza", "when I leave the office". Stored here (data/place-reminders.json);
// the iPhone app fetches them, turns each place into a geofence, and when
// Fred arrives / leaves it shows the reminder and reports back (fired).
// If the phone can't find the place it reports that too (failed) and Fred
// is told, so a reminder never silently goes nowhere.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const crypto = require('crypto');

function createPlaceReminders({ filePath, onChange = () => {}, now = () => Date.now() } = {}) {
  let list = [];
  try { if (filePath) list = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) {}
  if (!Array.isArray(list)) list = [];
  const save = () => { try { if (filePath) fs.writeFileSync(filePath, JSON.stringify(list, null, 2)); } catch (_) {} };
  const active = () => list.filter((r) => r.status === 'waiting');
  const pub = (r) => ({ id: r.id, message: r.message, place: r.place, on: r.on });
  const changed = () => { save(); try { onChange(); } catch (_) {} };

  function add(message, place, on) {
    const m = String(message || '').trim();
    const p = String(place || '').trim();
    if (!m || !p) return { ok: false, error: 'Need both what to remind him about and the place.' };
    const when = String(on || 'arrive').toLowerCase().startsWith('l') ? 'leave' : 'arrive';
    if (active().length >= 18) return { ok: false, error: 'The phone can watch at most 18 places at once. Cancel one first.' };
    const r = { id: crypto.randomBytes(6).toString('hex'), message: m.slice(0, 300), place: p.slice(0, 200), on: when, status: 'waiting', createdAt: now() };
    list.push(r);
    changed();
    const back = list.find((x) => x.id === r.id);
    return back ? { ok: true, ...pub(back), note: 'Fred\'s iPhone app watches for this place (it needs location access "Always").' } : { ok: false, error: 'Could not save it.' };
  }

  function upcoming() { return { ok: true, reminders: active().map(pub) }; }

  function cancel(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return { ok: false, error: 'Which one?' };
    const hit = active().filter((r) => r.id === q || r.message.toLowerCase().includes(q) || r.place.toLowerCase().includes(q));
    if (!hit.length) return { ok: false, error: `No place reminder matches "${query}".`, reminders: active().map(pub) };
    if (hit.length > 1 && !hit.some((r) => r.id === q)) return { ok: false, error: 'More than one matches; say which.', matches: hit.map(pub) };
    const target = hit.find((r) => r.id === q) || hit[0];
    target.status = 'cancelled'; target.endedAt = now();
    changed();
    return { ok: true, cancelled: pub(target) };
  }

  /** The phone saw Fred arrive/leave. Returns the reminder, or null if unknown/already done. */
  function fired(id) {
    const r = list.find((x) => x.id === String(id) && x.status === 'waiting');
    if (!r) return null;
    r.status = 'fired'; r.endedAt = now();
    changed();
    return pub(r);
  }

  /** The phone could not turn the place into a location. */
  function failed(id, why) {
    const r = list.find((x) => x.id === String(id) && x.status === 'waiting');
    if (!r) return null;
    r.status = 'failed'; r.error = String(why || '').slice(0, 200); r.endedAt = now();
    changed();
    return pub(r);
  }

  return { add, upcoming, cancel, fired, failed };
}

module.exports = { createPlaceReminders };
