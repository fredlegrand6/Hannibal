// ─────────────────────────────────────────────────────────────────────────
// PHONE APP (server side) — Hannibal as an app on Fred's phone.
//
// A small web app served by the always-on server, private to Fred's Tailscale
// network (never on the public internet). Add it to the home screen and it
// opens full-screen like an app:
//   • type, or hold the mic button and talk (ElevenLabs transcribes it);
//   • Hannibal answers in text and, for spoken questions, in his own voice;
//   • anything that changes something shows Yes / No buttons first (same gate
//     as Telegram; no answer in 2 minutes = no);
//   • reminders and the morning brief also appear here while it is open;
//   • the camera button sends a photo and he looks at it (same vision as the desk).
//
// Access: the first visit uses the link with ?k=<PHONE_APP_TOKEN> (deploy.sh
// prints it); that sets a cookie, after which the plain address works.
// Same brain, tools, facts and memory as Telegram and the desk.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATIC = path.join(__dirname, 'phone');
const COOKIE = 'hannibal_k';
const CONFIRM_TIMEOUT_MS = 120000;
const MAX_BODY = 15 * 1024 * 1024;
const MAX_IMAGE_BODY = 8 * 1024 * 1024;
const MAX_MEETING_BODY = 200 * 1024 * 1024;  // ~3 h of meeting at 32 kbps AAC is ~45 MB     // a phone photo after shrinking is ~0.3-1 MB

const PHONE_APP_CONTEXT =
  'Fred is using the Hannibal app on his phone, not speaking at the desk. Your reply is shown as text '
  + '(and read aloud when he spoke): plain text, short paragraphs, no markdown tables. '
  + 'Actions that change something are confirmed with Yes/No buttons in the app.';

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };

// opts: token, hosts [], port, persona, chat(payload, onText, {runTool}), runTool(name, input, {confirmer}),
//       transcribe(buffer, mime) -> text, speak(text) -> mp3 Buffer, memory {recall, store}, log,
//       push (server/apns.js: iPhone notifications while the native app is closed)
function createPhoneApp(opts = {}) {
  const log = opts.log || ((...a) => console.log('[phone]', ...a));
  const token = String(opts.token || '');
  if (token.length < 16) throw new Error('PHONE_APP_TOKEN missing or too short');
  const clients = new Set();                 // open event streams
  const nativeClients = new Set();           // …of those, the native iPhone app (routes, drive times)
  const pending = new Map();                 // confirm id → { resolve, timer }
  let busy = false;

  function push(ev, to = clients) {
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of to) { try { res.write(line); } catch (_) {} }
  }

  // Nobody has the app open, but the native iPhone app can be reached by push.
  const canPush = () => !!(opts.push && opts.push.configured && opts.push.count() > 0);

  function confirmer(_step, summary) {
    return new Promise((resolve) => {
      const viaPush = !clients.size && canPush();
      if (!clients.size && !viaPush) { resolve(false); return; }       // nobody to ask
      const id = crypto.randomBytes(8).toString('hex');
      const timer = setTimeout(() => { pending.delete(id); push({ type: 'confirm-closed', id, ok: false, note: 'No answer in 2 minutes, so I did not do it.' }); resolve(false); }, CONFIRM_TIMEOUT_MS);
      pending.set(id, { resolve, timer });
      push({ type: 'confirm', id, summary: String(summary || 'Shall I go ahead?') });
      if (viaPush) {
        // Yes/No on the lock screen (Yes needs Face ID). If the push can't go out, it's a no.
        opts.push.notify({ title: 'Hannibal asks', body: `${summary || 'Shall I go ahead?'}\n\nShall I go ahead?`, category: 'CONFIRM', data: { confirmId: id } })
          .then((n) => { if (!n && pending.has(id)) { clearTimeout(timer); pending.delete(id); resolve(false); } })
          .catch(() => { if (pending.has(id)) { clearTimeout(timer); pending.delete(id); resolve(false); } });
      }
    });
  }

  let glanceCache = null;

  async function turn(text, { spoken = false, images } = {}) {
    let memories = '';
    if (opts.memory) { try { memories = await opts.memory.recall(text); } catch (_) {} }
    const r = await opts.chat(
      { system: opts.persona, context: [PHONE_APP_CONTEXT, memories].filter(Boolean).join('\n\n'), user: text, ...(images ? { images } : {}) },
      null,
      { runTool: opts.runTool ? (name, input) => opts.runTool(name, input, { confirmer }) : undefined },
    );
    if (r && r.ok && r.text) {
      if (opts.memory) opts.memory.store(`Fred said (phone app${images ? ', with a photo' : ''}): ${text}\nHannibal replied: ${r.text}`, { type: 'conversation', channel: 'phone-app' }).catch(() => {});
      return { ok: true, reply: r.text, spoken };
    }
    if (r && r.toolsUsed && r.toolsUsed.length) return { ok: false, reply: `I ran ${r.toolsUsed.map((t) => t.tool).join(', ')} but then lost the connection to my brain. Check before asking again.` };
    return { ok: false, reply: `I can't think right now: ${(r && r.error) || 'no answer'}.` };
  }

  /** Hannibal thinks about something Fred didn't type (a meeting write-up):
   *  same brain and tools, writes still go through Fred's Yes/No. */
  async function think(prompt) {
    const r = await opts.chat(
      { system: opts.persona, context: PHONE_APP_CONTEXT, user: prompt },
      null,
      { runTool: opts.runTool ? (name, input) => opts.runTool(name, input, { confirmer }) : undefined },
    );
    if (r && r.ok && r.text) return r.text;
    throw new Error((r && r.error) || 'my brain gave no answer');
  }

  const json = (res, code, body, extra = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra }); res.end(JSON.stringify(body)); };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    // First visit with the key: set the cookie and drop the key from the address.
    if (url.searchParams.has('k')) {
      if (!safeEqual(url.searchParams.get('k'), token)) { res.writeHead(403); res.end('Wrong link.'); return; }
      res.writeHead(302, { Location: '/', 'Set-Cookie': `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict${req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : ''}` });
      res.end(); return;
    }
    const authed = safeEqual(cookies(req)[COOKIE], token);
    if (!authed) {
      if (url.pathname === '/manifest.json' || url.pathname === '/icon.svg') { /* harmless, let the home-screen icon load */ }
      else { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('Hannibal is private. Open the link from your setup message once.'); return; }
    }

    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      const name = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
      const file = path.join(STATIC, name);
      if (!file.startsWith(STATIC) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      fs.createReadStream(file).pipe(res); return;
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`data: ${JSON.stringify({ type: 'hello', status: opts.status ? opts.status() : {} })}\n\n`);
      clients.add(res);
      const native = String(req.headers['x-hannibal-client'] || '') === 'ios';
      if (native) nativeClients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); nativeClients.delete(res); });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/say') {
      let text = '';
      try { text = String(JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')).text || '').trim(); } catch (_) {}
      if (!text) { json(res, 400, { ok: false, reply: 'Say something first.' }); return; }
      if (busy) { json(res, 429, { ok: false, reply: 'One moment, still on the last one.' }); return; }
      busy = true;
      try { json(res, 200, await turn(text)); } catch (e) { json(res, 500, { ok: false, reply: `Something broke: ${e.message}` }); } finally { busy = false; }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/voice') {
      if (!opts.transcribe) { json(res, 501, { ok: false, reply: "I can't listen right now. Type it instead?" }); return; }
      if (busy) { json(res, 429, { ok: false, reply: 'One moment, still on the last one.' }); return; }
      busy = true;
      try {
        const audio = await readBody(req);
        const heard = String(await opts.transcribe(audio, req.headers['content-type'] || 'audio/webm') || '').trim();
        if (!heard) { json(res, 200, { ok: false, heard: '', reply: "I couldn't make that out. Try again?" }); return; }
        json(res, 200, { heard, ...(await turn(heard, { spoken: true })) });
      } catch (e) { log('voice failed:', e.message); json(res, 500, { ok: false, reply: "Something went wrong with that recording. Type it instead?" }); }
      finally { busy = false; }
      return;
    }

    // A photo from the phone's camera or library (the phone shrinks it to a JPEG
    // first). He looks at it with the same vision as the desk.
    if (req.method === 'POST' && url.pathname === '/api/look') {
      let body = {};
      try { body = JSON.parse((await readBody(req, MAX_IMAGE_BODY)).toString('utf8')); } catch (_) {}
      const image = String(body.image || '').replace(/^data:[^,]*,/, '');
      if (!image || !/^[A-Za-z0-9+/=]+$/.test(image.slice(0, 4096))) { json(res, 400, { ok: false, reply: "That photo didn't come through. Try again?" }); return; }
      if (busy) { json(res, 429, { ok: false, reply: 'One moment, still on the last one.' }); return; }
      const text = String(body.text || '').trim().slice(0, 4000) || 'What do you see in this photo?';
      busy = true;
      try { json(res, 200, await turn(text, { images: [image] })); }
      catch (e) { log('look failed:', e.message); json(res, 500, { ok: false, reply: `Something broke: ${e.message}` }); }
      finally { busy = false; }
      return;
    }

    // Live talk with the camera on (iPhone app): what Fred said + what the
    // camera sees right now, in one turn. { audio: base64, mime, image: base64 jpeg }
    if (req.method === 'POST' && url.pathname === '/api/voice-look') {
      if (!opts.transcribe) { json(res, 501, { ok: false, reply: "I can't listen right now. Type it instead?" }); return; }
      let body = {};
      try { body = JSON.parse((await readBody(req, MAX_IMAGE_BODY)).toString('utf8')); } catch (_) {}
      const image = String(body.image || '').replace(/^data:[^,]*,/, '');
      const audio = String(body.audio || '');
      if (!audio || !image || !/^[A-Za-z0-9+/=]+$/.test(image.slice(0, 4096))) { json(res, 400, { ok: false, reply: "That didn't come through. Try again?" }); return; }
      if (busy) { json(res, 429, { ok: false, reply: 'One moment, still on the last one.' }); return; }
      busy = true;
      try {
        const heard = String(await opts.transcribe(Buffer.from(audio, 'base64'), String(body.mime || 'audio/wav')) || '').trim();
        if (!heard) { json(res, 200, { ok: false, heard: '', reply: "I couldn't make that out. Try again?" }); return; }
        json(res, 200, { heard, ...(await turn(heard, { spoken: true, images: [image] })) });
      } catch (e) { log('voice-look failed:', e.message); json(res, 500, { ok: false, reply: 'Something went wrong with that. Try again?' }); }
      finally { busy = false; }
      return;
    }

    // At a glance (iPhone home/lock screen widget): next appointments,
    // reminders and how many Yes/No questions wait. Cached for a minute.
    if (req.method === 'GET' && url.pathname === '/api/glance') {
      try {
        if (!glanceCache || Date.now() - glanceCache.at > 60000) {
          const g = opts.glance ? await opts.glance() : {};
          const now = Date.now();
          const events = (Array.isArray(g.events) ? g.events : [])
            .filter((e) => e && Number(e.endTs || e.ts) >= now)
            .sort((a, b) => a.ts - b.ts).slice(0, 6)
            .map((e) => ({ title: String(e.title || '').slice(0, 120), ts: Number(e.ts), ...(e.endTs ? { endTs: Number(e.endTs) } : {}), allDay: !!e.allDay }));
          const reminders = (Array.isArray(g.reminders) ? g.reminders : [])
            .filter((r) => r && Number(r.triggerTs) >= now)
            .sort((a, b) => a.triggerTs - b.triggerTs).slice(0, 6)
            .map((r) => ({ message: String(r.message || '').slice(0, 160), ts: Number(r.triggerTs) }));
          glanceCache = { at: Date.now(), body: { ok: true, events, reminders } };
        }
        json(res, 200, { ...glanceCache.body, waiting: pending.size, at: glanceCache.at });
      } catch (e) { log('glance failed:', e.message); json(res, 200, { ok: false, events: [], reminders: [], waiting: pending.size }); }
      return;
    }

    // Place reminders: the iPhone app turns these into geofences, then says
    // when one fired or a place couldn't be found (opts.places, see place-reminders.js).
    if (url.pathname === '/api/places' && req.method === 'GET') {
      json(res, 200, opts.places ? opts.places.upcoming() : { ok: true, reminders: [] });
      return;
    }
    if ((url.pathname === '/api/places/fired' || url.pathname === '/api/places/failed') && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse((await readBody(req, 4096)).toString('utf8')); } catch (_) {}
      if (!opts.places || !body.id) { json(res, 400, { ok: false }); return; }
      const fired = url.pathname.endsWith('fired');
      const r = fired ? opts.places.fired(body.id) : opts.places.failed(body.id, body.error);
      if (r && opts.onPlace) { try { opts.onPlace(fired ? 'fired' : 'failed', r, body.error); } catch (_) {} }
      json(res, 200, { ok: !!r });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/speak') {
      if (!opts.speak) { res.writeHead(501); res.end(); return; }
      try {
        const text = String(JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')).text || '').slice(0, 1500);
        const mp3 = await opts.speak(text);
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': mp3.length, 'Cache-Control': 'no-store' });
        res.end(mp3);
      } catch (e) { log('speak failed:', e.message); res.writeHead(500); res.end(); }
      return;
    }

    // The phone tells us when his voice failed there (fetch / play / blocked by
    // the phone), so it lands in the same dropout log Hannibal can be asked about.
    if (req.method === 'POST' && url.pathname === '/api/voice-drop') {
      let body = {};
      try { body = JSON.parse((await readBody(req, 4096)).toString('utf8')); } catch (_) {}
      try { if (opts.onVoiceDrop) opts.onVoiceDrop({ ...body, where: 'phone' }); } catch (e) { log('voice-drop failed:', e.message); }
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/confirm') {
      let body = {};
      try { body = JSON.parse((await readBody(req, 4096)).toString('utf8')); } catch (_) {}
      const p = pending.get(String(body.id || ''));
      if (!p) { json(res, 410, { ok: false, note: 'That question has expired.' }); return; }
      pending.delete(String(body.id)); clearTimeout(p.timer);
      const yes = body.yes === true;
      push({ type: 'confirm-closed', id: body.id, ok: yes, note: yes ? 'Going ahead.' : 'Not done.' });
      p.resolve(yes);
      json(res, 200, { ok: true });
      return;
    }

    // The native iPhone app registers for push notifications.
    if (req.method === 'POST' && url.pathname === '/api/push-token') {
      let body = {};
      try { body = JSON.parse((await readBody(req, 4096)).toString('utf8')); } catch (_) {}
      if (!opts.push) { json(res, 501, { ok: false, note: 'Push is not set up on the server.' }); return; }
      const ok = opts.push.register(body.token, body.env);
      json(res, ok ? 200 : 400, { ok, configured: !!opts.push.configured });
      return;
    }

    // A recorded meeting (raw audio). Answered at once; the write-up comes as a message.
    if (req.method === 'POST' && url.pathname === '/api/meeting') {
      if (!opts.meetings) { json(res, 501, { ok: false, note: 'Meeting memory is not set up on the server.' }); return; }
      let audio;
      try { audio = await readBody(req, MAX_MEETING_BODY); } catch (e) { json(res, 413, { ok: false, note: 'That recording is too long (over about 3 hours).' }); return; }
      if (!audio.length) { json(res, 400, { ok: false, note: 'The recording was empty.' }); return; }
      const h = (k) => { try { return decodeURIComponent(String(req.headers[k] || '')); } catch (_) { return ''; } };
      const { id } = opts.meetings.accept(audio, { mime: req.headers['content-type'] || 'audio/mp4', title: h('x-meeting-title'), startedAt: Number(h('x-meeting-started')) || undefined, seconds: Number(h('x-meeting-seconds')) || 0 });
      json(res, 202, { ok: true, id, note: 'Got it. I\'m writing it up and will send it in a few minutes.' });
      return;
    }

    // The phone's answer to ask() (e.g. { id, ok, minutes, km, place }).
    if (req.method === 'POST' && url.pathname === '/api/answer') {
      let body = {};
      try { body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8')); } catch (_) {}
      const a = asks.get(String(body.id || ''));
      if (!a) { json(res, 410, { ok: false, note: 'Too late, that question expired.' }); return; }
      asks.delete(String(body.id)); clearTimeout(a.timer);
      const { id: _id, ...answer } = body;
      a.resolve(answer);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/reset') { opts.onReset && opts.onReset(); json(res, 200, { ok: true }); return; }

    res.writeHead(404); res.end();
  }

  const servers = [];
  function start() {
    for (const host of opts.hosts || ['127.0.0.1']) {
      const s = http.createServer((req, res) => { handle(req, res).catch((e) => { log('request failed:', e.message); try { res.writeHead(500); res.end(); } catch (_) {} }); });
      s.on('error', (e) => log(`cannot listen on ${host}:${opts.port}: ${e.message}`));
      s.listen(opts.port, host, () => log(`app on http://${host}:${opts.port}`));
      servers.push(s);
    }
  }
  function stop() { for (const s of servers) { try { s.close(); } catch (_) {} } for (const c of clients) { try { c.end(); } catch (_) {} } }

  // Hannibal starts the conversation (reminders, brief) — shown if the app is open,
  // otherwise sent to the iPhone as a push notification.
  // extra.url: tapping it (notification or chat line) opens that link, e.g. a Google Maps route.
  function notify(text, extra = {}) {
    if (!text) return clients.size;
    const url = extra && extra.url ? String(extra.url) : undefined;
    push({ type: 'notify', text: String(text), ...(url ? { url } : {}) });
    if (!clients.size && canPush()) opts.push.notify({ body: String(text), ...(url ? { data: { navigate: url } } : {}) }).catch((e) => log('push failed:', e.message));
    return clients.size;
  }

  /** Start a Google Maps route on the phone. The app opens it when it is on
   *  screen, else shows a tap-to-start notification. */
  function navigate(dest, url) {
    const text = `🚗 Route to ${dest}. Tap to start it in Google Maps.`;
    // Only the native app can open Google Maps; the web app in a browser can't.
    if (nativeClients.size) { push({ type: 'navigate', dest: String(dest), url: String(url), text }, nativeClients); return 'opened'; }
    if (canPush()) { opts.push.notify({ body: text, data: { navigate: String(url) } }).catch((e) => log('push failed:', e.message)); return 'notified'; }
    return 'none';
  }

  /** Ask the phone something only it knows (drive time from where Fred is).
   *  Open app: over the live stream; closed: a silent push wakes it. Resolves
   *  with the phone's answer, or null when it doesn't answer in time. */
  const asks = new Map();
  function ask(kind, params = {}, timeoutMs = 20000) {
    return new Promise((resolve) => {
      // Only the native iPhone app can answer; the web app in a browser can't.
      const viaPush = !nativeClients.size && canPush() && opts.push.wake;
      if (!nativeClients.size && !viaPush) { resolve(null); return; }
      const id = crypto.randomBytes(8).toString('hex');
      const timer = setTimeout(() => { asks.delete(id); resolve(null); }, timeoutMs);
      asks.set(id, { resolve, timer });
      const q = { id, kind: String(kind), ...params };
      if (nativeClients.size) push({ type: 'ask', ...q }, nativeClients);
      else opts.push.wake({ ask: q }).catch((e) => { log('silent push failed:', e.message); });
    });
  }

  /** Place reminders changed: tell an open app now, wake a closed one quietly. */
  function placesChanged() {
    push({ type: 'places' });
    if (!clients.size && canPush() && opts.push.wake) opts.push.wake({ sync: 'places' }).catch((e) => log('silent push failed:', e.message));
  }

  return { start, stop, notify, navigate, ask, think, placesChanged, handle, _confirmer: confirmer, _pending: pending, _places: opts.places };
}

module.exports = { createPhoneApp, PHONE_APP_CONTEXT };
