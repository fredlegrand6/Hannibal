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
//   • reminders and the morning brief also appear here while it is open.
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
//       transcribe(buffer, mime) -> text, speak(text) -> mp3 Buffer, memory {recall, store}, log
function createPhoneApp(opts = {}) {
  const log = opts.log || ((...a) => console.log('[phone]', ...a));
  const token = String(opts.token || '');
  if (token.length < 16) throw new Error('PHONE_APP_TOKEN missing or too short');
  const clients = new Set();                 // open event streams
  const pending = new Map();                 // confirm id → { resolve, timer }
  let busy = false;

  function push(ev) {
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of clients) { try { res.write(line); } catch (_) {} }
  }

  function confirmer(_step, summary) {
    return new Promise((resolve) => {
      if (!clients.size) { resolve(false); return; }       // nobody to ask
      const id = crypto.randomBytes(8).toString('hex');
      const timer = setTimeout(() => { pending.delete(id); push({ type: 'confirm-closed', id, ok: false, note: 'No answer in 2 minutes, so I did not do it.' }); resolve(false); }, CONFIRM_TIMEOUT_MS);
      pending.set(id, { resolve, timer });
      push({ type: 'confirm', id, summary: String(summary || 'Shall I go ahead?') });
    });
  }

  async function turn(text, { spoken = false } = {}) {
    let memories = '';
    if (opts.memory) { try { memories = await opts.memory.recall(text); } catch (_) {} }
    const r = await opts.chat(
      { system: opts.persona, context: [PHONE_APP_CONTEXT, memories].filter(Boolean).join('\n\n'), user: text },
      null,
      { runTool: opts.runTool ? (name, input) => opts.runTool(name, input, { confirmer }) : undefined },
    );
    if (r && r.ok && r.text) {
      if (opts.memory) opts.memory.store(`Fred said (phone app): ${text}\nHannibal replied: ${r.text.slice(0, 500)}`, { type: 'conversation', channel: 'phone-app' }).catch(() => {});
      return { ok: true, reply: r.text, spoken };
    }
    if (r && r.toolsUsed && r.toolsUsed.length) return { ok: false, reply: `I ran ${r.toolsUsed.map((t) => t.tool).join(', ')} but then lost the connection to my brain. Check before asking again.` };
    return { ok: false, reply: `I can't think right now: ${(r && r.error) || 'no answer'}.` };
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
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
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

  // Hannibal starts the conversation (reminders, brief) — shown if the app is open.
  function notify(text) { if (text) push({ type: 'notify', text: String(text) }); return clients.size; }

  return { start, stop, notify, handle, _confirmer: confirmer, _pending: pending };
}

module.exports = { createPhoneApp, PHONE_APP_CONTEXT };
