// ─────────────────────────────────────────────────────────────────────────
// PRESENCE LOOP — Hannibal's first AUTONOMOUS layer. A light, continuous
// "heartbeat" that makes him feel alive: he looks around on his own, notices
// things through the vision model, and speaks up (in English) unprompted.
//
// Runs in the Electron MAIN process (mirrors the Stage-7 awareness engine): it
// owns the loop + state and emits events to the renderer, which owns the SPEAK
// gate (overlap guards + TTS + brain), exactly like awareness. Default OFF —
// nothing autonomous happens until Fred starts it (env or a spoken/typed "wake
// up"); a restart alone does NOT make Hannibal start talking.
//
// ╔═══════════════════════════════════════════════════════════════════════╗
// ║ HARD SAFETY BOUNDARY (non-negotiable):                                 ║
// ║   The loop may ONLY autonomously fire READ tools. Every WRITE tool —   ║
// ║   anything catalog.isWrite() or catalog.confirmRequired() (mail.send,  ║
// ║   whatsapp.send, imessage.send, file.trash, mac.shell, …) — is BLOCKED ║
// ║   here by safeInvoke() before it can run. The loop can at most PROPOSE ║
// ║   such an action to Fred; it never executes one. Defense in depth: an  ║
// ║   explicit read allow-list PLUS the isWrite/confirmRequired filter.    ║
// ╚═══════════════════════════════════════════════════════════════════════╝
//
// STATES: sleeping (fully reactive — no proactive vision/speech), muted (still
// watches + steers, says nothing), awake (watches, steers, speaks). mute/sleep
// persist to data/presence.json so a restart respects them.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const catalog = require('./catalog');
const { installToolTap, makeIpcInvoker } = require('./executor');
// Reuse the SAME dependency-free perceptual-hash the screen-awareness engine uses
// (8x8 average-hash → 64-bit BigInt + Hamming distance). This is what makes the
// camera loop grounded: the vision model only runs when the scene MATERIALLY
// changed, so a static room can never provoke an invented remark.
let awarenessHash = null;
try { awarenessHash = require('../awareness'); } catch (_) { /* hash gate degrades to always-assess */ }

const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// Run a child process to a file; resolve only if the output landed on disk
// (sips exits non-zero on benign warnings). Mirrors awareness.js's helper.
function runToFile(cmd, args, out) {
  return new Promise((resolve, reject) => {
    try { fs.existsSync(out) && fs.unlinkSync(out); } catch (_) {}
    const p = spawn(cmd, args);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', () => (fs.existsSync(out) ? resolve() : reject(new Error(err.trim() || 'no output'))));
  });
}

// Perceptual hash of a base64 (JPEG) camera frame: write → sips to an 8x8 BMP →
// average-hash via the awareness helper. Returns a 64-bit BigInt, or null if the
// pipeline is unavailable (in which case the caller does NOT suppress — it falls
// back to assessing, exactly like awareness degrades). Files are deleted after.
async function frameHash(b64) {
  if (!awarenessHash || !b64) return null;
  const jpg = path.join(os.tmpdir(), 'hannibal-presence-frame.jpg');
  const bmp = path.join(os.tmpdir(), 'hannibal-presence-hash.bmp');
  try {
    fs.writeFileSync(jpg, Buffer.from(b64, 'base64'));
    await runToFile('/usr/bin/sips', ['-s', 'format', 'bmp', '-z', '8', '8', jpg, '--out', bmp], bmp);
    return awarenessHash.aHashFromBmp(bmp);
  } catch (_) {
    return null;
  } finally {
    fs.unlink(jpg, () => {}); fs.unlink(bmp, () => {});
  }
}
function frameDistance(a, b) { return (awarenessHash && a != null && b != null) ? awarenessHash.hamming(a, b) : null; }

const CONFIG = {
  enabled: /^(1|true|yes|on)$/i.test(String(process.env.HANNIBAL_PRESENCE_ENABLED || '')),
  visionIntervalMs: int(process.env.HANNIBAL_PRESENCE_VISION_INTERVAL_MS, 6000),  // how often it looks
  speakMinGapMs:    int(process.env.HANNIBAL_PRESENCE_SPEAK_MIN_GAP_MS, 45000),   // min gap between remarks
  curiosity:        clamp01(num(process.env.HANNIBAL_PRESENCE_CURIOSITY, 0.5)),   // 0 calm .. 1 lively
  visionTimeoutMs:  int(process.env.HANNIBAL_PRESENCE_VISION_TIMEOUT_MS, 90000),
  // ── GROUNDING (the anti-hallucination knobs) ──
  // Change-gate: a RESTING camera frame within this many differing hash bits of the
  // previous resting frame = "nothing meaningfully changed" → the vision model does
  // NOT run and nothing is said. Webcam sensor grain is noisier than a screen, so
  // this is a touch looser than awareness's screen default (8). Tune live.
  changeHammingThreshold: int(process.env.HANNIBAL_PRESENCE_CHANGE_BITS, 10),
  // The vision model presence reasons with. Grounded perception uses the bigger VL
  // model on GEX131 (Blackwell) — it confabulates far less than the 7b. Independent
  // of the screen-awareness model on purpose. Override with the env if needed.
  visionModel: process.env.HANNIBAL_PRESENCE_VISION_MODEL || 'qwen2.5vl:72b',
  // Low temperature — we want faithful description of what's actually in frame, not
  // creative variety (which is exactly what produced invented remarks before).
  visionTemp: clamp01(num(process.env.HANNIBAL_PRESENCE_VISION_TEMP, 0.25)),
  // Deliberate look-around cadence scales with curiosity (lively = wanders more).
  // A curiosity of 0.5 → ~35% of ticks include a physical look-around.
};

// The ONLY tools the loop may ever autonomously call. Read-only by construction;
// safeInvoke re-checks isWrite/confirmRequired as a second, catalog-driven gate.
const READ_ALLOW = new Set([
  'camera.track', 'camera.look', 'camera.aim', 'camera.zoom', 'camera.reset', 'camera.status',
  'vision.capture', 'world.read', 'world.crypto', 'memory.query',
]);

const STORE = path.join(__dirname, '..', '..', '..', 'data', 'presence.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch (_) { return {}; }
}
function saveState(s) {
  try { fs.mkdirSync(path.dirname(STORE), { recursive: true }); fs.writeFileSync(STORE, JSON.stringify(s, null, 2)); }
  catch (e) { console.warn('[presence] state save failed:', e.message); }
}

// ── the engine ───────────────────────────────────────────────────────────────
function createPresence({ ollamaUrl, visionModel, textModel, emit, now = () => Date.now(),
  invoke: injInvoke, assess: injAssess } = {}) {
  const cfg = { ...CONFIG };
  const persisted = loadState();
  let running = false;
  let muted = !!persisted.muted;
  let sleeping = persisted.sleeping !== undefined ? !!persisted.sleeping : false;
  let inCycle = false;
  let timer = null;
  let lastRemarkTs = 0;
  let lastHeard = null;      // { text, ts } — most recent user utterance (from renderer)
  let lastFrameHash = null;  // perceptual hash of the last RESTING camera frame (change-gate)
  const actionLog = [];      // ring of autonomous actions, for Fred to review

  const send = (channel, payload) => { try { emit && emit(channel, payload); } catch (_) {} };
  const log = (msg) => console.log(`[presence] ${msg}`);

  let invoker = null;
  function invoke(tool, params) {
    if (injInvoke) return injInvoke(tool, params); // test seam — filter still applies (safeInvoke wraps this)
    if (!invoker) invoker = makeIpcInvoker(installToolTap._registry || {});
    return invoker(tool, params);
  }

  // ── THE HARD WRITE-FILTER — every autonomous tool call goes through here ──
  async function safeInvoke(tool, params) {
    const record = { ts: now(), tool, params, ok: null, refused: false };
    // 1) catalog-driven boundary: never a write, never a confirm-gated tool.
    if (catalog.isWrite(tool) || catalog.confirmRequired(tool)) {
      record.refused = true; record.reason = 'write/confirm tool — blocked in autonomous loop';
      actionLog.push(record); if (actionLog.length > 200) actionLog.shift();
      log(`REFUSED autonomous write "${tool}" — the loop never executes writes. (Propose to Fred instead.)`);
      send('presence:action', record);
      return { ok: false, refused: true, error: record.reason };
    }
    // 2) allow-list: only the sanctioned read tools, even among reads.
    if (!READ_ALLOW.has(tool)) {
      record.refused = true; record.reason = `tool "${tool}" not in the presence read allow-list`;
      actionLog.push(record); if (actionLog.length > 200) actionLog.shift();
      log(`REFUSED "${tool}" — not in allow-list.`);
      send('presence:action', record);
      return { ok: false, refused: true, error: record.reason };
    }
    try {
      const out = await invoke(tool, params);
      record.ok = !!(out && out.ok !== false);
      actionLog.push(record); if (actionLog.length > 200) actionLog.shift();
      send('presence:action', record);
      return out;
    } catch (e) {
      record.ok = false; record.error = e.message;
      actionLog.push(record); if (actionLog.length > 200) actionLog.shift();
      send('presence:action', record);
      return { ok: false, error: e.message };
    }
  }

  // ── vision: look at a frame and decide if it's worth reacting to ──
  // Returns { notable, interest(0..1), say, referent } — `say` is a short ENGLISH
  // remark, `referent` is the SPECIFIC visible thing it's reacting to. The remark
  // is only ever voiced if it names a concrete referent actually in the frame; this
  // is what keeps Hannibal from inventing (no "Nice plan, Fred" with no plan).
  async function visionAssess(b64) {
    if (injAssess) return injAssess(b64, lastHeard);
    const heardCtx = lastHeard && (now() - lastHeard.ts < 30000)
      ? `\nFred just spoke to you: "${lastHeard.text}". You may answer him, but ONLY about what you can actually see.` : '';
    const sys = 'You are Hannibal, Fred\'s ever-present AI companion in the room, seeing him through a camera. '
      + 'The person is almost always FRED — your user and friend. Talk STRAIGHT to him: second person ("you", "your"), '
      + 'his name naturally, casual spoken English, contractions, short — often just a few words. '
      + 'No "I can see" / "I observe" / "it appears" — just react like a friend beside him.\n\n'
      + 'CRITICAL GROUNDING RULE — this is the whole job:\n'
      + 'Only remark on something you can ACTUALLY SEE and point to in THIS exact frame: a concrete, specific, '
      + 'visible detail — what he is wearing, doing, holding, his expression right now, or someone/something that '
      + 'has appeared or changed in the scene. You MUST name that specific referent. '
      + 'If you cannot point to a concrete visible thing, or you are not sure what you are seeing, set notable=false '
      + 'and say nothing. NEVER invent anything you cannot see — do NOT mention plans, work, projects, code, files, '
      + 'meetings, or any context that is not physically visible in the frame. Do not guess what he is doing on a '
      + 'screen you cannot read. When in doubt, stay silent — silence is the correct, safe answer. Do not repeat '
      + 'a remark you might have made before. If someone who is clearly NOT Fred is in frame, you may note that.\n\n'
      + 'Reply ONLY with JSON: {"referent": "<the specific visible thing you are reacting to, or empty if none>", '
      + '"notable": <bool>, "interest": <0..1>, "say": "<one short casual English sentence to Fred, grounded in that '
      + 'referent, or empty>"}. If referent is empty, notable MUST be false and say MUST be empty.';
    try {
      const r = await fetch(`${ollamaUrl}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.visionModel, stream: false, format: 'json',
          options: { temperature: cfg.visionTemp }, keep_alive: '30m',
          messages: [
            { role: 'system', content: sys + heardCtx },
            { role: 'user', content: 'Look at this camera frame. If — and only if — there is a concrete, specific thing you can actually see and point to, name it and say ONE short natural thing directly to Fred about it. Otherwise set notable=false and stay quiet.', images: [b64] },
          ],
        }),
        signal: AbortSignal.timeout(cfg.visionTimeoutMs),
      });
      const j = await r.json();
      let parsed = {};
      try { parsed = JSON.parse(j.message?.content || '{}'); } catch (_) {}
      const referent = String(parsed.referent || '').trim();
      const say = String(parsed.say || '').trim();
      // Hard grounding gate: no concrete referent → not notable, whatever the model claimed.
      const grounded = referent.length > 0 && say.length > 0;
      return {
        notable: grounded && !!parsed.notable,
        interest: grounded ? clamp01(num(parsed.interest, 0.6)) : 0,
        say,
        referent,
      };
    } catch (e) {
      log(`vision assess failed: ${e.message}`);
      return { notable: false, interest: 0, say: '', referent: '' };
    }
  }

  // ── one heartbeat ──
  async function runCycle() {
    if (sleeping) return;

    // HANDS-OFF: Hannibal NEVER steers the gimbal. Moving it breaks OBSBOT's native
    // tracking, which OSC can't restore on the Tiny 3 (see camera-coordinator.js).
    // The camera keeps ITSELF on Fred and turns to whoever speaks (hardware Voice
    // Locator), so we just LOOK at whatever it is currently showing and comment only
    // when something has clearly changed. No wander, no gimbal moves.
    const cap = await safeInvoke('vision.capture', { kind: 'camera' });
    const b64 = cap && cap.ok ? (cap.b64 || (cap.images && cap.images[0])) : null;
    if (!b64) { log('no frame this cycle (camera not ready?)'); return; }

    // CHANGE-GATE (grounding, step 1): skip the vision model entirely unless the
    // scene MATERIALLY changed since the last frame — a static room can then never
    // provoke a remark. If hashing is unavailable we do NOT suppress (assess anyway)
    // — the same graceful degradation the screen-awareness engine uses.
    {
      const h = await frameHash(b64);
      if (h !== null) {
        if (lastFrameHash === null) { lastFrameHash = h; log('cycle: baseline frame captured — staying quiet'); return; }
        const dist = frameDistance(lastFrameHash, h);
        lastFrameHash = h;
        if (dist !== null && dist <= cfg.changeHammingThreshold) {
          log(`cycle: no meaningful change (dist=${dist}≤${cfg.changeHammingThreshold}) — vision model skipped, staying quiet`);
          return;
        }
        log(`cycle: scene changed (dist=${dist}) — assessing`);
      }
    }

    // ASSESS + DECIDE (grounding, step 2): the model must name a concrete visible
    // referent (visionAssess forces notable=false otherwise). Then apply the
    // interest threshold + rate-limit + mute.
    const look = await visionAssess(b64);
    const threshold = 0.75 - cfg.curiosity * 0.35; // lively → speaks at lower interest
    const gapOk = now() - lastRemarkTs >= cfg.speakMinGapMs;
    const wantSpeak = look.notable && !!look.say && !!look.referent && look.interest >= threshold;

    log(`cycle: notable=${look.notable} interest=${look.interest.toFixed(2)} thr=${threshold.toFixed(2)} `
      + `gapOk=${gapOk} muted=${muted} referent=${JSON.stringify(look.referent).slice(0, 40)} say=${JSON.stringify(look.say).slice(0, 60)}`);

    if (wantSpeak && gapOk && !muted) {
      lastRemarkTs = now();
      send('presence:remark', { text: look.say, interest: look.interest, referent: look.referent, ts: now() });
      log(`REMARK → "${look.say}"  (grounded in: ${look.referent})`);
    } else if (wantSpeak && muted) {
      log(`muted — withheld: "${look.say}"`);
    }
  }

  async function loop() {
    if (!running) return;
    if (!inCycle) { inCycle = true; try { await runCycle(); } catch (e) { log(`loop error ${e.message}`); } inCycle = false; }
    if (running) timer = setTimeout(loop, cfg.visionIntervalMs);
  }

  function persist() { saveState({ muted, sleeping }); }

  return {
    isRunning: () => running,
    config: () => ({ ...cfg }),
    setConfig: (patch) => {
      if (patch && typeof patch === 'object') for (const k of Object.keys(patch)) if (k in cfg) cfg[k] = patch[k];
      return { ...cfg };
    },
    status: () => ({ running, muted, sleeping, lastRemarkTs, recentActions: actionLog.slice(-10) }),
    heard: (text) => { lastHeard = { text: String(text || ''), ts: now() }; },
    tick: () => runCycle(), // run exactly one heartbeat (used by the dry-run harness)

    async start(patch) {
      if (patch) this.setConfig(patch);
      if (running) return { ok: true, running: true, already: true };
      running = true; sleeping = false; persist();
      log(`START — interval=${cfg.visionIntervalMs}ms curiosity=${cfg.curiosity} speakGap=${cfg.speakMinGapMs}ms muted=${muted}`);
      // Assert the resting behavior: track Fred (read tool, safe).
      safeInvoke('camera.track', { mode: 'auto', frame: 'upper' }).catch(() => {});
      send('presence:state', { running: true, muted, sleeping });
      loop();
      return { ok: true, running: true, muted, sleeping };
    },
    stop() {
      if (timer) { clearTimeout(timer); timer = null; }
      running = false;
      log('STOP');
      send('presence:state', { running: false, muted, sleeping });
      return { ok: true, running: false };
    },
    // STAP 3 — mute/sleep controls (persisted).
    mute()   { muted = true;  persist(); log('MUTE — watching, silent'); send('presence:state', { running, muted, sleeping }); return { ok: true, muted }; },
    unmute() { muted = false; persist(); log('UNMUTE — talking again');  send('presence:state', { running, muted, sleeping }); return { ok: true, muted }; },
    sleep()  { sleeping = true;  persist(); log('SLEEP — fully reactive'); send('presence:state', { running, muted, sleeping }); return { ok: true, sleeping }; },
    wake()   {
      sleeping = false; muted = false; persist();
      log('WAKE — proactive again');
      if (running) safeInvoke('camera.track', { mode: 'auto', frame: 'upper' }).catch(() => {});
      send('presence:state', { running, muted, sleeping });
      return { ok: true, sleeping, muted };
    },
    // Central control entry the renderer calls for spoken/typed commands.
    control(cmd) {
      switch (cmd) {
        case 'mute': return this.mute();
        case 'unmute': return this.unmute();
        case 'sleep': return this.sleep();
        case 'wake': return running ? this.wake() : this.start();
        case 'start': return this.start();
        case 'stop': return this.stop();
        default: return { ok: false, error: `unknown presence control "${cmd}"` };
      }
    },
    _safeInvoke: safeInvoke, // exported for the STAP-5 write-filter test
  };
}

module.exports = { createPresence, CONFIG, READ_ALLOW, frameHash, frameDistance };
