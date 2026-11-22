// ─────────────────────────────────────────────────────────────────────────
// PHOTO MEMORY — "remember where I parked", "remember this wine".
// Hannibal keeps: what it is (his own description, also of the photo), where
// Fred's iPhone was at that moment (GPS + street), the photo when there was
// one in the last few minutes, and when. Later: "where did I park?" → the
// spot, how long ago, and the route back (nav.go with the coordinates).
// Stored in data/spots.json (+ data/spots/<id>.jpg). At most 300 kept.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX = 300;
const PHOTO_FRESH_MS = 5 * 60e3;

function ago(ms) {
  const m = Math.round(ms / 60e3);
  if (m < 60) return `${Math.max(1, m)} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

// here() → { ok, lat, lon, accuracy, address } from the phone (or null).
// lastPhoto() → { b64, at } | null (the latest photo Fred sent).
function createSpots({ filePath, photoDir, here, lastPhoto, remember, now = () => Date.now() } = {}) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(filePath, 'utf8')).spots || []; } catch (_) {}
  const save = () => { try { fs.writeFileSync(filePath, JSON.stringify({ spots: list }, null, 2)); } catch (_) {} };
  if (photoDir) { try { fs.mkdirSync(photoDir, { recursive: true }); } catch (_) {} }
  const pub = (s) => ({
    id: s.id, label: s.label, note: s.note, when: ago(now() - s.ts), at: new Date(s.ts).toISOString().slice(0, 16).replace('T', ' '),
    ...(s.lat != null ? { place: s.address || `${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}`, destination: `${s.lat},${s.lon}` } : {}), photo: !!s.photo,
  });

  async function add(label, note, withPhoto) {
    const l = String(label || '').trim().slice(0, 120);
    if (!l) return { ok: false, error: 'What should I remember? (e.g. "where I parked", "this wine")' };
    const s = { id: crypto.randomBytes(5).toString('hex'), label: l, note: String(note || '').trim().slice(0, 1500), ts: now() };
    let where = null;
    try { where = here ? await here() : null; } catch (_) {}
    if (where && where.ok && Number.isFinite(Number(where.lat))) {
      s.lat = Number(where.lat); s.lon = Number(where.lon); s.accuracy = Math.round(Number(where.accuracy) || 0); s.address = String(where.address || '').slice(0, 200);
    }
    const p = withPhoto !== false && lastPhoto ? lastPhoto() : null;
    if (p && p.b64 && now() - p.at < PHOTO_FRESH_MS && photoDir) {
      try { fs.writeFileSync(path.join(photoDir, `${s.id}.jpg`), Buffer.from(p.b64, 'base64')); s.photo = true; } catch (_) {}
    }
    list.push(s);
    while (list.length > MAX) {
      const old = list.shift();
      if (old.photo) { try { fs.unlinkSync(path.join(photoDir, `${old.id}.jpg`)); } catch (_) {} }
    }
    save();
    if (remember) remember(`Fred asked me to remember ${s.label}${s.note ? `: ${s.note}` : ''}${s.address ? ` (at ${s.address})` : ''}.`).catch(() => {});
    const out = pub(s);
    if (s.lat == null) out.note2 = 'I could not get the location from his iPhone, so only the description is kept.';
    return { ok: true, ...out };
  }

  /** Best matches for words like "parked", "car", "wine"; newest first among equals. */
  function find(query) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter((w) => w.length > 2)
      .map((w) => (w === 'park' || w === 'parking' || w === 'car' ? 'park' : w));
    const scored = list.map((s) => {
      const hay = `${s.label} ${s.note} ${s.address || ''}`.toLowerCase().replace(/\b(car|parking)\b/g, 'park');
      return { s, score: words.filter((w) => hay.includes(w)).length };
    }).filter((x) => !words.length || x.score > 0);
    scored.sort((a, b) => b.score - a.score || b.s.ts - a.s.ts);
    return { ok: true, spots: scored.slice(0, 5).map((x) => pub(x.s)), note: 'Use destination with nav.go for the route there.' };
  }

  function forget(query) {
    const q = String(query || '').toLowerCase().trim();
    const i = list.map((s, k) => [s, k]).reverse().find(([s]) => s.id === q || `${s.label} ${s.note}`.toLowerCase().includes(q));
    if (!q || !i) return { ok: false, error: 'Nothing like that is remembered.' };
    const [s] = list.splice(i[1], 1);
    if (s.photo) { try { fs.unlinkSync(path.join(photoDir, `${s.id}.jpg`)); } catch (_) {} }
    save();
    return { ok: true, forgot: s.label };
  }

  function photo(id) {
    const s = list.find((x) => x.id === id && x.photo);
    if (!s) return null;
    try { return fs.readFileSync(path.join(photoDir, `${s.id}.jpg`)); } catch (_) { return null; }
  }

  return { add, find, forget, photo, _list: () => list };
}

module.exports = { createSpots, ago };
