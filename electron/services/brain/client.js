// ─────────────────────────────────────────────────────────────────────────
// BODY CLIENT — the Mac side of the brain↔body link. Stage 1.
//
// The body keeps everything that must be where Fred is: mic, screen, camera,
// speakers, the command center, the confirmation GATE, and local actions. This
// client is how the body reaches the brain: it opens the authenticated
// WebSocket, completes the handshake, and lets the body call UP (health,
// memory.query, later agent.run) with per-request timeouts.
//
// Two hard rules baked in here:
//   1. NEVER HANG. If the brain is down or a request stalls, calls reject fast
//      with a clear error — the app must degrade gracefully, not freeze. (The
//      step-5 fallback to in-process mode rides on this.)
//   2. The brain may call DOWN (body.invoke / body.confirm / emit). Those are
//      dispatched to handlers the body registers (step 3). Until registered, a
//      down-RPC is answered with a clean rpc_error, never a silent drop.
//
// Standalone proof (no Electron needed):
//   node electron/services/brain/client.js                  # health + a memory.query
//   node electron/services/brain/client.js "your query"     # memory.query for that text
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const P = require('./protocol');

(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '..', '..', '..', '.env');
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch (_) { /* fine */ }
})();

const DEFAULTS = {
  url: process.env.BRAIN_URL
    || `ws://${process.env.BRAIN_HOST || '127.0.0.1'}:${process.env.BRAIN_PORT || '8788'}`,
  token: process.env.BRAIN_TOKEN || '',
  bodyId: process.env.BRAIN_BODY_ID || 'mac-primary',
  // Per-method ceilings. Slow model work gets room so a real plan never trips
  // the timeout (the protocol's "detached" generosity).
  timeouts: { default: 15000, 'agent.run': 300000 },
  reconnect: true,
};

class BrainClient {
  constructor(opts = {}) {
    this.cfg = Object.assign({}, DEFAULTS, opts);
    this.cfg.timeouts = Object.assign({}, DEFAULTS.timeouts, opts.timeouts);
    this.ws = null;
    this.ready = false;          // authed + welcomed
    this.brain = null;           // brain identity from welcome
    this.pending = new Map();    // rpc id → {resolve, reject, timer}
    this.handlers = {};          // DOWN method → async fn (registered by the body in step 3)
    this.listeners = {};         // simple event bus: 'ready'|'close'|'event'|'error'
    this._seq = 0;
    this._backoff = 500;
    this._closedByUs = false;
  }

  on(ev, fn) { (this.listeners[ev] || (this.listeners[ev] = [])).push(fn); return this; }
  _emit(ev, ...a) { (this.listeners[ev] || []).forEach((f) => { try { f(...a); } catch (_) {} }); }

  // Register a handler for a DOWN method (body.invoke / body.confirm / emit).
  setHandler(method, fn) { this.handlers[method] = fn; return this; }

  _nextId() { this._seq += 1; return `b${this._seq}`; }

  connect() {
    if (this.ws) return this;
    this._closedByUs = false;
    const ws = new WebSocket(this.cfg.url);
    this.ws = ws;

    ws.on('open', () => {
      try {
        ws.send(P.encode(P.hello(this.cfg.token, {
          id: this.cfg.bodyId, platform: process.platform, app: 'hannibal',
        })));
      } catch (e) { this._emit('error', e); }
    });

    ws.on('message', (raw) => this._onMessage(raw));

    ws.on('close', (code, reason) => {
      this.ready = false;
      const wasReady = !!this.brain;
      this.ws = null;
      // Fail every in-flight request so nothing waits forever.
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('brain connection closed')); }
      this.pending.clear();
      this._emit('close', { code, reason: String(reason || ''), wasReady });
      if (this.cfg.reconnect && !this._closedByUs) {
        const wait = this._backoff;
        this._backoff = Math.min(this._backoff * 2, 15000);
        setTimeout(() => { if (!this._closedByUs) this.connect(); }, wait);
      }
    });

    ws.on('error', (e) => this._emit('error', e));
    return this;
  }

  _onMessage(raw) {
    const msg = P.parse(raw);
    if (!msg) return;

    if (msg.type === P.T.WELCOME) {
      this.ready = true;
      this.brain = msg.brain || {};
      this._backoff = 500;
      this._emit('ready', this.brain);
      return;
    }
    if (msg.type === P.T.ERROR) {
      // Connection/auth-level error (e.g. bad token). Surface it; the socket
      // will typically close right after.
      this._emit('error', new Error(`brain: ${msg.code} — ${msg.message}`));
      return;
    }
    if (msg.type === P.T.PING) { try { this.ws.send(P.encode({ v: P.PROTOCOL_VERSION, type: P.T.PONG })); } catch (_) {} return; }

    // Replies to OUR up-RPCs.
    if (msg.type === P.T.RPC_RESULT || msg.type === P.T.RPC_ERROR) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer); this.pending.delete(msg.id);
      if (msg.type === P.T.RPC_RESULT) p.resolve(msg.result);
      else p.reject(new Error(msg.error || 'rpc failed'));
      return;
    }
    if (msg.type === P.T.RPC_PROGRESS) {
      const p = this.pending.get(msg.id);
      if (p && p.onProgress) { try { p.onProgress(msg.progress); } catch (_) {} }
      return;
    }

    // The brain calling DOWN on us (body.invoke / body.confirm / emit).
    if (msg.type === P.T.RPC) { this._handleDown(msg); return; }

    if (msg.type === P.T.EVENT) { this._emit('event', msg.event, msg.data); return; }
  }

  async _handleDown(msg) {
    const fn = this.handlers[msg.method];
    if (!fn) {
      try { this.ws.send(P.encode(P.rpcError(msg.id, `body has no handler for "${msg.method}"`))); } catch (_) {}
      return;
    }
    try {
      const result = await fn(msg.params || {}, msg.id);
      try { this.ws.send(P.encode(P.rpcResult(msg.id, result))); } catch (_) {}
    } catch (e) {
      try { this.ws.send(P.encode(P.rpcError(msg.id, e.message))); } catch (_) {}
    }
  }

  // Call a method UP on the brain. Rejects fast if not connected; rejects on
  // timeout. opts: {timeout, onProgress}.
  request(method, params = {}, opts = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('brain not connected'));
        return;
      }
      const id = this._nextId();
      const ms = opts.timeout || this.cfg.timeouts[method] || this.cfg.timeouts.default;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`brain rpc "${method}" timed out after ${ms}ms`));
      }, ms);
      this.pending.set(id, { resolve, reject, timer, onProgress: opts.onProgress });
      try { this.ws.send(P.encode(P.rpc(id, method, params))); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  // Convenience wrappers.
  health() { return this.request(P.UP.HEALTH); }
  queryMemory(text, limit = 5) { return this.request(P.UP.MEMORY_QUERY, { text, limit }); }
  runAgent(goal, onProgress) { return this.request(P.UP.AGENT_RUN, { goal }, { onProgress }); }

  // Resolve once the brain has welcomed us; reject fast on close/auth-failure,
  // or after `ms` if the handshake simply stalls. Failing fast is what lets the
  // body fall back to in-process mode without a visible pause.
  waitReady(ms = 8000) {
    if (this.ready) return Promise.resolve(this.brain);
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, x) => { if (settled) return; settled = true; clearTimeout(timer); fn(x); };
      const timer = setTimeout(() => done(reject, new Error('brain handshake timed out')), ms);
      this.on('ready', (b) => done(resolve, b));
      this.on('close', (info) => done(reject, new Error(`brain connection closed before ready (${info.code})`)));
    });
  }

  close() { this._closedByUs = true; try { this.ws && this.ws.close(1000, 'bye'); } catch (_) {} }
}

module.exports = { BrainClient, DEFAULTS };

// ── Standalone proof ──
if (require.main === module) {
  (async () => {
    const arg = process.argv.slice(2).join(' ').trim();
    const c = new BrainClient({ reconnect: false });
    c.on('error', (e) => console.error('[body] error:', e.message));
    c.connect();
    try {
      const brain = await c.waitReady(8000);
      console.log('[body] ✓ handshake — connected to brain:', JSON.stringify(brain));
      const h = await c.health();
      console.log('[body] ✓ health:', JSON.stringify(h));
      const q = arg || 'what do I need to know about the voice pipeline';
      const t0 = Date.now();
      const mem = await c.queryMemory(q, 3);
      console.log(`[body] ✓ memory.query "${q}" (${Date.now() - t0}ms):`);
      if (mem.ok) (mem.results || []).forEach((m, i) =>
        console.log(`        ${i + 1}. [${m.score.toFixed(3)}] ${m.text.slice(0, 90).replace(/\s+/g, ' ')}…`));
      else console.log('        (no results / error:', mem.error, ')');
      c.close();
      process.exit(0);
    } catch (e) {
      console.error('[body] ✗ proof failed:', e.message);
      c.close();
      process.exit(1);
    }
  })();
}
