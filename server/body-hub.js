// ─────────────────────────────────────────────────────────────────────────
// BODY HUB (server side) — where Fred's Mac plugs in when it is awake.
//
// The Mac (electron/main.js, startBodyLink) opens an authenticated WebSocket
// to this hub over Tailscale (the brain↔body protocol in
// electron/services/brain/protocol.js). While it is linked:
//   • the server can run the Mac's own tools (apps, camera, screen, WhatsApp…)
//     through body.invoke. The confirmation gate stays HERE: a write is asked
//     on Fred's phone first, and only then sent down to the Mac to run;
//   • the Mac tells the hub which tool channels it has (body.register);
//   • saved facts stay in sync: the server's copy is the master (facts.*);
//   • the desk can push a message to Fred's phone (phone.notify), e.g. a
//     reminder that fired at the desk.
// Only one Mac at a time; a new link replaces the old one.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const crypto = require('crypto');
const P = require('../electron/services/brain/protocol');

function createBodyHub({ host, port, token, WebSocketServer, onLink = () => {}, onUnlink = () => {}, methods = {}, log = (...a) => console.log('[body]', ...a) }) {
  if (!token || String(token).length < 16) throw new Error('BODY_LINK_TOKEN missing or too short');
  let body = null;            // { ws, id, channels:Set }
  let seq = 0;
  const pending = new Map();  // id → { resolve, reject, timer }

  const safeEqual = (a, b) => {
    const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  const send = (ws, frame) => { try { ws.send(P.encode(frame)); } catch (_) {} };

  const wss = new WebSocketServer({ host, port, maxPayload: 64 * 1024 * 1024 });
  wss.on('listening', () => log(`waiting for the Mac on ws://${host}:${port}`));
  wss.on('error', (e) => log('hub error:', e.message));

  wss.on('connection', (ws) => {
    let authed = false;
    let me = null;
    const authTimer = setTimeout(() => { if (!authed) ws.close(4001, 'no hello'); }, 10000);

    ws.on('message', async (raw) => {
      const msg = P.parse(raw);
      if (!msg) return;
      if (!authed) {
        if (msg.type !== P.T.HELLO || !safeEqual(msg.token, token)) {
          send(ws, P.error('auth', 'bad token'));
          ws.close(4003, 'bad token');
          return;
        }
        authed = true; clearTimeout(authTimer);
        if (body && body.ws !== ws) { try { body.ws.close(4000, 'replaced'); } catch (_) {} }
        me = { ws, id: (msg.body && msg.body.id) || 'mac', channels: new Set() };
        body = me;
        send(ws, P.welcome({ id: 'hannibal-server', role: 'always-on' }));
        log(`Mac linked (${me.id})`);
        return;
      }
      if (msg.type === P.T.PING) { send(ws, { v: P.PROTOCOL_VERSION, type: P.T.PONG }); return; }
      if (msg.type === P.T.RPC_RESULT || msg.type === P.T.RPC_ERROR) {
        const p = pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer); pending.delete(msg.id);
        if (msg.type === P.T.RPC_RESULT) p.resolve(msg.result); else p.reject(new Error(msg.error || 'Mac action failed'));
        return;
      }
      if (msg.type === P.T.RPC) {
        if (msg.method === 'body.register') {
          me.channels = new Set((msg.params && msg.params.channels) || []);
          send(ws, P.rpcResult(msg.id, { ok: true }));
          try { onLink(me); } catch (e) { log('onLink failed:', e.message); }
          return;
        }
        const fn = methods[msg.method];
        if (!fn) { send(ws, P.rpcError(msg.id, `unknown method ${msg.method}`)); return; }
        try { send(ws, P.rpcResult(msg.id, await fn(msg.params || {}))); }
        catch (e) { send(ws, P.rpcError(msg.id, e.message)); }
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (body && body.ws === ws) {
        body = null;
        for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('the Mac went offline')); }
        pending.clear();
        log('Mac unlinked');
        try { onUnlink(); } catch (_) {}
      }
    });
    ws.on('error', () => {});
  });

  // Keep the link honest: a Mac that went to sleep without closing is dropped.
  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws._hbDead) { ws.terminate(); continue; }
      ws._hbDead = true;
      ws.once('pong', () => { ws._hbDead = false; });
      try { ws.ping(); } catch (_) {}
    }
  }, 30000);

  // Run a tool on the Mac (by catalog tool name). Rejects if the Mac is offline.
  function invoke(tool, params, timeoutMs = 120000) {
    return call(P.DOWN.INVOKE, { tool, params }, timeoutMs);
  }
  function call(method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!body) { reject(new Error('the Mac is offline (asleep or off)')); return; }
      const id = `s${++seq}`;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('the Mac did not answer in time')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      send(body.ws, P.rpc(id, method, params));
    });
  }
  // Tell the Mac something, no answer needed (e.g. the new facts list).
  function notify(name, data) { if (body) send(body.ws, P.event(name, data)); }

  function close() { clearInterval(pinger); try { wss.close(); } catch (_) {} }

  return {
    invoke, call, notify, close,
    linked: () => !!body,
    channels: () => (body ? [...body.channels] : []),
    _wss: wss,
  };
}

module.exports = { createBodyHub };
