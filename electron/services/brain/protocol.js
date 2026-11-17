// ─────────────────────────────────────────────────────────────────────────
// BRAIN ⇄ BODY PROTOCOL — the single source of truth for the wire format.
//
// Stage 1 of "Hannibal across machines": the brain (planner + executor +
// memory, eventually always-on on GEX131) and a body (this Mac: mic, screen,
// gate UI, local actions) talk over an authenticated WebSocket on Tailscale.
//
// Design (the shape we took from studying the JARVIS daemon/sidecar split, our
// own code — no external code copied):
//   • Body → Brain : `hello` (auth), then `rpc` requests (memory.query,
//                    agent.run, …) and `rpc_result`/`rpc_error` replies to the
//                    brain's down-RPCs.
//   • Brain → Body : `welcome`, `rpc` requests DOWN (body.invoke / body.confirm
//                    / emit — the local hands, the gate, progress) plus
//                    `rpc_result`/`rpc_error`/`rpc_progress` replies to the
//                    body's up-RPCs, and unprompted `sidecar_event`.
//   • Large payloads (audio, screenshots) travel by REFERENCE, not inline, so a
//     2 MB screen capture never rides inside a control frame. (REF helpers
//     below; fetch transport lands with screen/voice in a later stage.)
//   • Slow model work (70B plan ~12s, vision ~30s) must not trip RPC timeouts;
//     callers pass generous per-method timeouts and may DETACH (see client).
//
// Wire encoding: one JSON object per WebSocket text frame. Every frame carries
// `v` (protocol version) and `type`. Requests carry a string `id`.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const PROTOCOL_VERSION = 1;

// Frame types.
const T = Object.freeze({
  HELLO: 'hello',           // body → brain: first frame, carries auth token
  WELCOME: 'welcome',       // brain → body: auth accepted, brain identity
  ERROR: 'error',           // either way: connection/auth-level error (not an RPC reply)
  RPC: 'rpc',               // either way: a request {id, method, params}
  RPC_RESULT: 'rpc_result', // reply: {id, ok:true, result}
  RPC_ERROR: 'rpc_error',   // reply: {id, error}
  RPC_PROGRESS: 'rpc_progress', // partial: {id, progress}
  EVENT: 'sidecar_event',   // unprompted: {event, data} (e.g. "user spoke")
  PING: 'ping',
  PONG: 'pong',
});

// Methods the BODY may call UP on the brain.
const UP = Object.freeze({
  HEALTH: 'health',         // liveness + brain identity/model status
  MEMORY_QUERY: 'memory.query', // {text, limit} → relevant hannibal_memory hits
  AGENT_RUN: 'agent.run',   // {goal} → gated plan→execute (wired in step 3)
});

// Methods the BRAIN may call DOWN on the body (wired fully in step 3; declared
// now so both ends share the vocabulary).
const DOWN = Object.freeze({
  INVOKE: 'body.invoke',    // {tool, params} → run a LOCAL action (mail, mac-control…)
  CONFIRM: 'body.confirm',  // {step, summary} → the confirmation GATE, on the Mac, in front of Fred
  EMIT: 'emit',             // {event} → stream agent progress to the renderer
});

// Payload-by-reference marker. A frame field set to {__ref__:id, bytes, mime}
// means "the actual blob lives out of band; fetch it by id". Inline (small)
// payloads are sent as-is. Transport for refs arrives with screen/voice.
function ref(id, bytes, mime) {
  return { __ref__: id, bytes: bytes || 0, mime: mime || 'application/octet-stream' };
}
function isRef(v) {
  return !!v && typeof v === 'object' && typeof v.__ref__ === 'string';
}

// ── frame builders (keep construction in one place so the shape can't drift) ──
const base = (type, extra) => Object.assign({ v: PROTOCOL_VERSION, type }, extra);

const hello = (token, body) => base(T.HELLO, { token, body: body || {} });
const welcome = (brain) => base(T.WELCOME, { brain: brain || {} });
const error = (code, message, id) => base(T.ERROR, id ? { code, message, id } : { code, message });
const rpc = (id, method, params) => base(T.RPC, { id, method, params: params || {} });
const rpcResult = (id, result) => base(T.RPC_RESULT, { id, ok: true, result });
const rpcError = (id, errMsg) => base(T.RPC_ERROR, { id, ok: false, error: String(errMsg) });
const rpcProgress = (id, progress) => base(T.RPC_PROGRESS, { id, progress });
const event = (name, data) => base(T.EVENT, { event: name, data: data || {} });

// Safe parse — never throw on a malformed frame; the caller decides what to do
// with null. (A garbage frame must never crash the brain or the body.)
function parse(raw) {
  try {
    const o = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    if (!o || typeof o !== 'object' || typeof o.type !== 'string') return null;
    return o;
  } catch (_) { return null; }
}

const encode = (frame) => JSON.stringify(frame);

module.exports = {
  PROTOCOL_VERSION, T, UP, DOWN,
  ref, isRef,
  hello, welcome, error, rpc, rpcResult, rpcError, rpcProgress, event,
  parse, encode,
};
