// ── CC INGEST ─────────────────────────────────────────────────────────────
// Inbound HTTP listener for Claude Code session events, pushed here by the n8n
// "CC Session Stream" workflow over Tailscale. Runs in Hannibal's MAIN process
// (required + started from main.js — never the renderer).
//
// On three signal events → a macOS notification (title "Claude Code · <project>")
// AND Daniel speaks: session_start, idle, stop. All other events (prompt,
// pre_tool, tool_complete) are silent here — no banner, no voice — but still
// update the live Agents panel via broadcast.
// Speech uses OFFLINE macOS `say` (NOT Kim, NOT the ElevenLabs/nova-tts path —
// that one is renderer-bound and reserved for real Hannibal content).
//
// Fail-safe contract: this module must NEVER throw into Hannibal and a listener
// error must NEVER crash the app. Every side-effect is wrapped; the HTTP handler
// ACKs immediately and does notify/speak work after responding.
// ───────────────────────────────────────────────────────────────────────────

const http = require('http');
const { spawn } = require('child_process');

function clip(s, n) {
  s = (s == null) ? '' : String(s);
  return s.length > n ? s.slice(0, n) : s;
}

// Fire a macOS notification. Strings are passed as `osascript` argv (via `on run
// argv`) so nothing is interpolated into the AppleScript source — injection-safe
// even though body text originates from the network.
function notify(title, body) {
  try {
    const p = spawn('osascript', [
      '-e', 'on run argv',
      '-e', 'display notification (item 1 of argv) with title (item 2 of argv)',
      '-e', 'end run',
      clip(body, 240) || ' ',
      clip(title, 120) || 'Claude Code',
    ]);
    p.on('error', () => {});
    console.log('[cc-ingest] notify:', title, '—', body);
  } catch (_) { /* never throw */ }
}

// Pinned voice so alerts don't use the (female) macOS system default. Alert text
// is English, so Daniel (en_GB, male) fits — and matches Hannibal's voice name.
// Override with CC_INGEST_VOICE; default at module load, refreshed in startCcIngest.
let sayVoice = process.env.CC_INGEST_VOICE || 'Daniel';

// Speak via macOS `say` (offline). Args array → no shell → injection-safe.
function say(text) {
  try {
    const p = spawn('say', ['-v', sayVoice, clip(text, 240)]);
    p.on('error', () => {});
    console.log('[cc-ingest] SPEAK:', `(${sayVoice})`, text);
  } catch (_) { /* never throw */ }
}

// Short notification body per event type.
function summarize(e) {
  const tool = e.tool_name || '';
  switch (e.event) {
    case 'session_start': return 'Session started';
    case 'prompt':        return e.query ? ('New prompt: ' + clip(e.query, 80)) : 'New prompt';
    case 'pre_tool':      return 'About to run ' + (tool || 'a tool');
    case 'tool_complete': return (tool || 'Tool') + ' complete';
    case 'idle':          return 'Waiting for you';
    case 'stop':          return 'Finished';
    default:              return e.event || 'event';
  }
}

// Returns the sentence to speak, or null for silent events. Speech only on the
// three session-lifecycle moments; pre_tool/tool_complete/prompt stay silent.
function speechFor(e) {
  const project = e.project || 'a project';
  switch (e.event) {
    case 'session_start': return `started on ${project}`;
    case 'idle':          return `${project} needs you`;
    case 'stop':          return `${project} done`;
    default:              return null;
  }
}

// Notifications match the speak set: only session_start, idle, stop get a banner.
// prompt / pre_tool / tool_complete are silent here (still shown in Agents panel).
function shouldNotify(e) {
  return e.event === 'session_start' || e.event === 'idle' || e.event === 'stop';
}

// ── LIVE SESSION STATE (Agents panel) ───────────────────────────────────────
// In-memory map of Claude Code sessions, keyed by session_id. Additive: feeds the
// renderer's live Agents view; does not affect notify/say/fail-safe behavior.
const sessions = new Map();
let broadcastFn = null; // set by startCcIngest({ broadcast }) — main pushes to windows

// event -> session status (state machine)
const STATUS = {
  session_start: 'active',
  prompt:        'working',
  pre_tool:      'running',
  tool_complete: 'working',
  idle:          'waiting',
  stop:          'done',
};

function actionLabel(e) {
  switch (e.event) {
    case 'session_start': return 'session started';
    case 'prompt':        return 'thinking';
    case 'pre_tool':      return 'running ' + (e.tool_name || 'tool');
    case 'tool_complete': return (e.tool_name || 'tool') + ' done';
    case 'idle':          return 'waiting for input';
    case 'stop':          return 'finished';
    default:              return e.event || '';
  }
}

// Drop long-finished sessions so the map can't grow unbounded.
function pruneSessions(now) {
  for (const [id, s] of sessions) {
    if (s.status === 'done' && (now - s.updatedAt) > 15 * 60 * 1000) sessions.delete(id);
  }
}

// Apply one event to the session map; returns the updated entry.
function applyEvent(e) {
  const id = e.session_id || 'unknown';
  const now = Date.now();
  let s = sessions.get(id);
  if (!s) {
    s = { session_id: id, project: e.project || 'unknown', hostname: e.hostname || 'unknown',
          status: 'active', lastAction: '', lastTool: '', startedAt: now, updatedAt: now };
    sessions.set(id, s);
  }
  if (e.project) s.project = e.project;       // backfill if first event lacked it
  if (e.hostname) s.hostname = e.hostname;
  s.status = STATUS[e.event] || s.status;
  s.lastAction = actionLabel(e);
  if (e.event === 'pre_tool') s.lastTool = e.tool_name || '';
  else if (e.event === 'tool_complete') s.lastTool = '';
  s.updatedAt = now;
  pruneSessions(now);
  return s;
}

// Snapshot for a freshly-opened panel to hydrate from.
function getSessions() {
  return [...sessions.values()];
}

// Update live state + broadcast, then notify/speak (gated, unchanged). Never throws.
function handleEvent(e) {
  try {
    const s = applyEvent(e);                                    // live state (Agents panel)
    if (broadcastFn) { try { broadcastFn({ event: e.event, sessionState: s }); } catch (_) {} }
    if (shouldNotify(e)) {
      notify(`Claude Code · ${e.project || 'unknown'}`, summarize(e));
    }
    const line = speechFor(e);
    if (line) say(line);
  } catch (_) { /* swallow — listener must never crash Hannibal */ }
}

// Start the listener. Binds to 0.0.0.0 by default so the n8n server can reach it
// over Tailscale (Hannibal's other services bind localhost; this one is remote by
// design). Optional shared secret via CC_INGEST_TOKEN (enforced only if set).
function startCcIngest(opts = {}) {
  const port  = opts.port  || Number(process.env.CC_INGEST_PORT) || 8787;
  const host  = opts.host  || process.env.CC_INGEST_HOST || '0.0.0.0';
  const token = opts.token || process.env.CC_INGEST_TOKEN || '';
  sayVoice = opts.voice || process.env.CC_INGEST_VOICE || 'Daniel'; // refresh after main.js loadEnv
  if (opts.broadcast) broadcastFn = opts.broadcast;               // main wires window push here

  const server = http.createServer((req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end('{"status":"ok"}');
      }
      if (req.method === 'POST' && (req.url === '/cc-event' || req.url.startsWith('/cc-event?'))) {
        if (token && req.headers['x-cc-token'] !== token) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end('{"ok":false,"error":"unauthorized"}');
        }
        let body = '';
        let aborted = false;
        req.on('data', (c) => {
          body += c;
          if (body.length > 1e6) { aborted = true; req.destroy(); } // cap payload
        });
        req.on('end', () => {
          // ACK first — the n8n branch is fire-and-forget; side-effects come after.
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
          if (aborted) return;
          let e = {};
          try { e = JSON.parse(body || '{}'); } catch (_) { e = {}; }
          handleEvent(e);
        });
        req.on('error', () => {});
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"ok":false}');
    } catch (_) {
      try { res.writeHead(500); res.end('{"ok":false}'); } catch (__) {}
    }
  });

  // A listener error (e.g. port in use) must not take down Hannibal — just log.
  server.on('error', (err) => console.log('[cc-ingest] server error:', err && err.message));
  server.listen(port, host, () => console.log(`[cc-ingest] listening on ${host}:${port}`));
  return server;
}

module.exports = { startCcIngest, handleEvent, getSessions };
