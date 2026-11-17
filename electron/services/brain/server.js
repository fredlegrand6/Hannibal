// ─────────────────────────────────────────────────────────────────────────
// BRAIN SERVER — the always-on core of Hannibal.
//
// Stage 1 step 3: the AGENT LOOP now lives here. The brain plans (70B, local),
// executes, classifies failures, and replans — all next to the models. The only
// things it does NOT do itself are the things that must happen where Fred is:
//   • body.invoke  — run a LOCAL action (mail, mac-control, whatsapp, screen…)
//   • body.confirm — THE CONFIRMATION GATE. The brain decides an action needs a
//                    yes; the MAC speaks it and waits for Fred. The brain never
//                    self-approves. If the body can't be reached, nothing sends.
//   • emit         — stream progress to the Mac's renderer (brain pulse + voice)
// Those three are RPC'd DOWN the same WebSocket the body opened.
//
// WHERE IT RUNS: machine-agnostic. On GEX131 it binds the Tailscale IP only and
// Ollama/Qdrant are local. The agent modules are resolved from either the Mac
// repo layout (../agent) or the box deploy layout (./agent).
//
// Run it:  node server.js        (box)   |   node electron/services/brain/server.js  (Mac)
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const P = require('./protocol');

// Resolve the agent loop from whichever layout we're deployed in.
function requireAgent(name) {
  try { return require('./agent/' + name); }        // box: ~/hannibal-brain/agent/
  catch (_) { return require('../agent/' + name); }  // Mac repo: electron/services/agent/
}
const planner = requireAgent('planner');
const executor = requireAgent('executor');

// ── minimal .env loader (config also comes from systemd EnvironmentFile) ──
(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '..', '..', '..', '.env');
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch (_) { /* defaults below */ }
})();

const CFG = {
  host: process.env.BRAIN_HOST || '127.0.0.1',
  port: parseInt(process.env.BRAIN_PORT || '8788', 10),
  token: process.env.BRAIN_TOKEN || '',
  ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  qdrantUrl: process.env.QDRANT_URL || 'http://gex131-1:6333',
  qdrantCollection: process.env.QDRANT_COLLECTION || 'hannibal_memory',
  embedModel: process.env.EMBED_MODEL || 'nomic-embed-text',
  heavyModel: process.env.OLLAMA_MODEL_HEAVY || process.env.OLLAMA_MODEL || 'llama3.3:70b',
  version: '0.2.0-stage3',
};

const log = (...a) => console.log('[brain]', ...a);
let downSeq = 0;

// ── brain-local memory read (Qdrant local on the box) ──
async function memoryQuery({ text, limit = 5 } = {}) {
  if (!text || !String(text).trim()) return { ok: false, error: 'memory.query needs text' };
  let vec;
  try {
    // The box is a shared GPU: when another tenant loads a giant model it can
    // evict this tiny embed, forcing a cold reload that queues behind that load
    // (seen as high as ~56s). keep_alive holds it warm; the generous timeout lets
    // a cold reload finish slowly rather than failing the query outright.
    const r = await fetch(`${CFG.ollamaUrl}/api/embeddings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: CFG.embedModel, prompt: String(text), keep_alive: '30m' }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) return { ok: false, error: `embed HTTP ${r.status}` };
    vec = (await r.json()).embedding;
  } catch (e) { return { ok: false, error: `embed failed: ${e.message}` }; }
  if (!vec) return { ok: false, error: 'embed returned no vector' };
  try {
    const r = await fetch(`${CFG.qdrantUrl}/collections/${CFG.qdrantCollection}/points/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(process.env.QDRANT_API_KEY ? { 'api-key': process.env.QDRANT_API_KEY } : {}) },
      body: JSON.stringify({ vector: vec, limit, with_payload: true, score_threshold: 0.35 }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return { ok: false, error: `qdrant HTTP ${r.status}` };
    const j = await r.json();
    const results = (j.result || [])
      .map((p) => ({ text: p.payload?.text || p.payload?.content || '', score: p.score }))
      .filter((m) => m.text);
    return { ok: true, results };
  } catch (e) { return { ok: false, error: `qdrant query failed: ${e.message}` }; }
}

function brainIdentity() {
  return {
    id: 'hannibal-brain',
    version: CFG.version,
    models: { heavy: CFG.heavyModel, embed: CFG.embedModel },
    memory: { url: CFG.qdrantUrl, collection: CFG.qdrantCollection },
  };
}

// ── the agent loop, run ON THE BRAIN, with hands/gate/progress wired DOWN ──
// ctx.callDown(method, params, timeout) → Promise of the body's reply.
// ctx.notifyDown(method, params)        → fire-and-forget (progress).
async function agentRun(params, ctx) {
  // Accept {plan} | {steps} | {goal}, mirroring the Mac's agent:run.
  let plan = params && params.plan;
  if (!plan && params && Array.isArray(params.steps)) {
    const { steps } = planner.validateAndEnrich(params.steps);
    plan = { goal: params.goal || '[manual plan]', steps };
  }
  if (!plan && params && params.goal) {
    const p = await planner.plan(params.goal);
    if (!p.ok) return { ok: false, error: p.error || 'planning failed' };
    plan = p;
  }
  if (!plan || !Array.isArray(plan.steps)) return { ok: false, error: 'no plan/goal/steps provided' };

  log(`agent.run "${plan.goal}" — ${plan.steps.length} step(s); gate + hands route DOWN to body`);

  // The body is the hands. Every action runs on the Mac.
  const invoke = (tool, p) => ctx.callDown(P.DOWN.INVOKE, { tool, params: p }, 120000);

  // THE GATE — non-negotiable. The brain asks; the MAC speaks and waits for Fred.
  // 130s ceiling > the Mac's 120s voice-confirm window. A confirmer that can't be
  // reached REJECTS (executor treats that as a clean abort — nothing sends).
  const confirmer = (step, summary) => ctx.callDown(P.DOWN.CONFIRM, {
    step: { step: step.step, tool: step.tool, description: step.description, critical: !!step.critical },
    summary,
  }, 130000);

  // Progress streams down to the renderer (brain pulse + spoken progress).
  const emit = (ev) => { try { ctx.notifyDown(P.DOWN.EMIT, { event: ev }); } catch (_) {} };

  const res = await executor.execute(plan, { invoke, confirmer, emit });
  return {
    ok: res.ok, halted: res.halted, haltReason: res.haltReason,
    replans: res.replans, record: res.record, goal: plan.goal,
  };
}

// ── UP-method dispatch ──
async function dispatch(method, params, ctx) {
  switch (method) {
    case P.UP.HEALTH:
      return { ok: true, brain: brainIdentity(), uptimeSec: Math.round(process.uptime()) };
    case P.UP.MEMORY_QUERY:
      return memoryQuery(params || {});
    case P.UP.AGENT_RUN:
      return agentRun(params || {}, ctx);
    default:
      return { ok: false, error: `unknown method "${method}"` };
  }
}

function start() {
  if (!CFG.token) {
    console.error('[brain] FATAL: BRAIN_TOKEN is not set — refusing to start unauthenticated.');
    process.exit(1);
  }
  const wss = new WebSocketServer({ host: CFG.host, port: CFG.port });

  wss.on('listening', () => {
    log(`listening ws://${CFG.host}:${CFG.port}  (brain ${CFG.version})`);
    log(`models: heavy=${CFG.heavyModel} embed=${CFG.embedModel}  memory=${CFG.qdrantCollection}`);
  });
  wss.on('error', (e) => console.error('[brain] server error:', e.message));

  wss.on('connection', (ws, req) => {
    const peer = (req.socket && req.socket.remoteAddress) || '?';
    let authed = false;
    let bodyId = '?';
    const downPending = new Map(); // id → {resolve, reject, timer} for brain→body RPCs

    // Call DOWN on this body and await its reply.
    const callDown = (method, params, timeoutMs = 60000) => new Promise((resolve, reject) => {
      if (ws.readyState !== ws.OPEN) { reject(new Error('body not connected')); return; }
      downSeq += 1; const id = `d${downSeq}`;
      const timer = setTimeout(() => { downPending.delete(id); reject(new Error(`body rpc "${method}" timed out after ${timeoutMs}ms`)); }, timeoutMs);
      downPending.set(id, { resolve, reject, timer });
      try { ws.send(P.encode(P.rpc(id, method, params))); }
      catch (e) { clearTimeout(timer); downPending.delete(id); reject(e); }
    });
    // Fire-and-forget DOWN (progress). Body replies; we ignore it.
    const notifyDown = (method, params) => {
      if (ws.readyState !== ws.OPEN) return;
      downSeq += 1;
      try { ws.send(P.encode(P.rpc(`n${downSeq}`, method, params))); } catch (_) {}
    };
    const ctx = { callDown, notifyDown, get bodyId() { return bodyId; } };

    log(`connection from ${peer} — awaiting hello`);
    const helloTimer = setTimeout(() => { if (!authed) { try { ws.close(4001, 'hello timeout'); } catch (_) {} } }, 5000);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (raw) => {
      const msg = P.parse(raw);
      if (!msg) return;

      if (!authed) {
        if (msg.type !== P.T.HELLO) { try { ws.send(P.encode(P.error('not_authed', 'send hello first'))); ws.close(4002, 'not authed'); } catch (_) {} return; }
        if (msg.token !== CFG.token) { log(`AUTH FAIL from ${peer}`); try { ws.send(P.encode(P.error('bad_token', 'invalid token'))); ws.close(4003, 'bad token'); } catch (_) {} return; }
        authed = true; clearTimeout(helloTimer);
        bodyId = (msg.body && msg.body.id) || peer;
        log(`AUTH OK — body "${bodyId}" (${(msg.body && msg.body.platform) || '?'})`);
        try { ws.send(P.encode(P.welcome(brainIdentity()))); } catch (_) {}
        return;
      }

      if (msg.type === P.T.PING) { try { ws.send(P.encode({ v: P.PROTOCOL_VERSION, type: P.T.PONG })); } catch (_) {} return; }

      // Replies to OUR down-RPCs (body.invoke / body.confirm results).
      if (msg.type === P.T.RPC_RESULT || msg.type === P.T.RPC_ERROR) {
        const p = downPending.get(msg.id);
        if (!p) return; // unmatched (e.g. emit ack) — ignore
        clearTimeout(p.timer); downPending.delete(msg.id);
        if (msg.type === P.T.RPC_RESULT) p.resolve(msg.result);
        else p.reject(new Error(msg.error || 'body rpc failed'));
        return;
      }

      // Up-requests from the body.
      if (msg.type === P.T.RPC) {
        const t0 = Date.now();
        let out;
        try { out = await dispatch(msg.method, msg.params, ctx); }
        catch (e) { out = { ok: false, error: e.message }; }
        const ms = Date.now() - t0;
        const okFlag = out && out.ok !== false;
        log(`rpc ${msg.method} [${bodyId}] → ${okFlag ? 'ok' : 'ERR'} ${ms}ms${out && out.error ? ' :: ' + out.error : ''}`);
        try { ws.send(P.encode(okFlag ? P.rpcResult(msg.id, out) : P.rpcError(msg.id, out.error || 'failed'))); } catch (_) {}
        return;
      }
    });

    ws.on('close', (code) => {
      clearTimeout(helloTimer);
      for (const [, p] of downPending) { clearTimeout(p.timer); p.reject(new Error('body disconnected')); }
      downPending.clear();
      log(`body "${bodyId}" disconnected (${code})`);
    });
    ws.on('error', (e) => log(`socket error [${bodyId}]: ${e.message}`));
  });

  const sweep = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) { try { ws.terminate(); } catch (_) {} return; }
      ws.isAlive = false; try { ws.ping(); } catch (_) {}
    });
  }, 30000);
  wss.on('close', () => clearInterval(sweep));

  const shutdown = () => { log('shutting down'); try { wss.close(); } catch (_) {} process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return wss;
}

module.exports = { start, memoryQuery, brainIdentity, agentRun, CFG };

if (require.main === module) start();
