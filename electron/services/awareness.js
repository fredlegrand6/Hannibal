// ═══════════════════════════════════════════════════════════════════════════
// HANNIBAL · STAGE 7 — CONTINUOUS AWARENESS (main process)
// ═══════════════════════════════════════════════════════════════════════════
// Opt-in background loop that watches the screen and, RARELY, offers help when
// Fred is genuinely stuck. The expensive vision model is the LAST resort — almost
// all of the "is he struggling?" judgment is cheap local math on OCR text.
//
//   Pipeline (per cycle):
//     Capture (perceptual hash)
//       └─ Change gate     — frame barely changed? STOP. No OCR, no LLM.
//            └─ OCR        — macOS Vision, .fast, on-device (only changed frames)
//                 └─ StruggleDetector — pure math, 4 weighted signals, no LLM
//                      └─ Vision model — Qwen2.5-VL on GEX131 (ONLY when struggle
//                           crosses threshold past grace + cooldown)
//                           └─ Speak gate (in renderer, behind overlap guards)
//
// Everything is local: screencapture + OCR on the Mac, Qwen over Tailscale.
// Frames are deleted after processing — never stored. Default OFF; the renderer
// shows a persistent "watching" indicator whenever this is live.
//
// This module owns the loop + the cheap gates and emits events to the renderer,
// which owns the speak gate (it holds the overlap guards), TTS, brain, and the
// Qdrant memory write. See voice-controller.js handleAwareness*.
// ═══════════════════════════════════════════════════════════════════════════

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── ONE PLACE to tune everything. Env-overridable; also live-settable via
//    setConfig() (awareness:config IPC) so Fred can dial it without a restart. ──
const CONFIG = {
  // ── cadence / capture ──
  captureIntervalMs: int(process.env.HANNIBAL_AWARE_INTERVAL_MS, 10000), // every N seconds
  display: int(process.env.HANNIBAL_AWARE_DISPLAY, 1),                   // screencapture -D index (1-based)
  visionMaxPx: int(process.env.HANNIBAL_VISION_MAX_PX, 1024),           // long-edge of the frame sent to Qwen

  // ── change gate (perceptual hash) ──
  // 8x8 average-hash → 64-bit. Hamming distance between consecutive frames; at or
  // below this many differing bits = "no meaningful change" → skip (no OCR/LLM).
  changeHammingThreshold: int(process.env.HANNIBAL_AWARE_CHANGE_BITS, 8),

  // ── struggle window ──
  windowMs: int(process.env.HANNIBAL_AWARE_WINDOW_MS, 210000), // ~3.5 min rolling window
  minSnapshots: int(process.env.HANNIBAL_AWARE_MIN_SNAPS, 8),  // ~1 min of change before we analyze

  // ── struggle signal weights (sum = 1.0) ──
  weights: {
    trialError: 0.30,     // lots of unique, non-converging states
    undo: 0.25,           // text returned to a recent previous state (tried → backed out)
    repeatedOutput: 0.25, // same bottom-of-screen output dominating (stuck error)
    lowProgress: 0.20,    // big activity, tiny real movement
  },
  struggleThreshold: num(process.env.HANNIBAL_AWARE_STRUGGLE, 0.5), // composite ≥ this = struggling

  // ── per-signal tuning ──
  trialErrorRatio: 0.70,        // > this fraction of unique states → trial-and-error
  undoLookbackMin: 2,           // a "revert" = current hash matches one 2..5 snapshots ago
  undoLookbackMax: 5,
  undoMaxCount: 3,              // reverts at which the undo signal saturates to 1.0
  repeatedOutputFreq: 0.40,     // a bottom-output hash in > this fraction of snapshots → stuck
  repeatedOutputMin: 6,         // …with at least this many snapshots
  bottomChars: 500,            // hash just the bottom N chars (terminal/error output)
  lowProgressDistCap: 0.15,     // avg normalized edit-distance at/under which low-progress saturates
  editDistMaxChars: 1200,       // cap OCR text length for the cheap edit-distance

  // ── brakes (the anti-annoyance) ──
  graceMs: int(process.env.HANNIBAL_AWARE_GRACE_MS, 120000),    // ~2 min sustained before firing
  cooldownMs: int(process.env.HANNIBAL_AWARE_COOLDOWN_MS, 180000), // ~3 min silent after firing

  // ── speak gate (enforced in the renderer behind overlap guards) ──
  // urgency a struggle must reach to be SPOKEN; lower-urgency notes are logged to
  // memory but not voiced. low | medium | high.
  speakUrgency: process.env.HANNIBAL_AWARE_SPEAK_URGENCY || 'medium',

  // ── vision (the one expensive call) ──
  visionTimeoutMs: int(process.env.HANNIBAL_AWARE_VISION_TIMEOUT_MS, 90000),
};

function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function num(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

// ── tiny tools ────────────────────────────────────────────────────────────
function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Cheap, bounded Levenshtein (two-row DP), truncated so a giant page can't make
// this O(n²) explode. Returns a 0..1 normalized distance.
function normEditDist(a, b, cap) {
  a = a.slice(0, cap); b = b.slice(0, cap);
  const n = a.length, m = b.length;
  if (n === 0 && m === 0) return 0;
  if (n === 0 || m === 0) return 1;
  let prev = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  let cur = new Array(m + 1);
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const t = prev; prev = cur; cur = t;
  }
  return prev[m] / Math.max(n, m);
}

function classifyApp(app, title) {
  const s = `${app || ''} ${title || ''}`.toLowerCase();
  if (/\b(code|vscode|visual studio code|xcode|sublime|intellij|pycharm|webstorm|cursor|nvim|vim|emacs|zed|android studio|fleet|rubymine|goland|clion)\b/.test(s)) return 'code_editor';
  if (/\b(terminal|iterm2?|warp|alacritty|kitty|wezterm|tmux|console|hyper)\b/.test(s)) return 'terminal';
  if (/\b(safari|chrome|firefox|arc|brave|edge|opera|chromium|vivaldi|orion)\b/.test(s)) return 'browser';
  if (/\b(photoshop|illustrator|figma|sketch|premiere|final cut|after effects|blender|davinci|logic pro|ableton|affinity|canva|indesign|lightroom|cinema 4d)\b/.test(s)) return 'creative_app';
  return 'general';
}

// ── OCR via the compiled macOS Vision helper ────────────────────────────────
const HELPER_SRC = path.join(__dirname, 'ocr-vision.swift');
const HELPER_BIN = path.join(__dirname, '.bin', 'ocr-vision');

function ensureOcrHelper() {
  return new Promise((resolve) => {
    try {
      const srcStat = fs.statSync(HELPER_SRC);
      let binFresh = false;
      try { binFresh = fs.statSync(HELPER_BIN).mtimeMs >= srcStat.mtimeMs; } catch (_) {}
      if (binFresh) { resolve({ ok: true }); return; }
      fs.mkdirSync(path.dirname(HELPER_BIN), { recursive: true });
      const p = spawn('/usr/bin/swiftc', ['-O', HELPER_SRC, '-o', HELPER_BIN]);
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('error', (e) => resolve({ ok: false, error: `swiftc spawn: ${e.message}` }));
      p.on('close', (code) => {
        if (code === 0 && fs.existsSync(HELPER_BIN)) resolve({ ok: true });
        else resolve({ ok: false, error: `swiftc exit ${code}: ${err.trim().slice(0, 300)}` });
      });
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
}

function ocr(imagePath) {
  return new Promise((resolve) => {
    execFile(HELPER_BIN, [imagePath], { maxBuffer: 8 * 1024 * 1024, timeout: 20000 }, (e, stdout) => {
      if (e) { resolve({ ok: false, error: e.message }); return; }
      resolve({ ok: true, text: (stdout || '').trim() });
    });
  });
}

// ── frontmost app + window title (cheap, ~50ms) ─────────────────────────────
const FRONT_SCRIPT =
  'tell application "System Events"\n' +
  '  set fp to first application process whose frontmost is true\n' +
  '  set appName to name of fp\n' +
  '  set winTitle to ""\n' +
  '  try\n    set winTitle to name of front window of fp\n  end try\n' +
  'end tell\n' +
  'return appName & "\\n" & winTitle';

function frontmost() {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', FRONT_SCRIPT], { timeout: 4000 }, (e, stdout) => {
      if (e) { resolve({ app: 'unknown', title: '' }); return; }
      const [app = 'unknown', title = ''] = (stdout || '').split('\n');
      resolve({ app: app.trim(), title: title.trim() });
    });
  });
}

// ── perceptual hash: screencapture frame → 8x8 BMP via sips → 64-bit aHash ───
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

// Parse a small (uncompressed) BMP and compute an average-hash: grayscale each
// pixel, threshold against the mean, pack into a 64-bit BigInt. Dependency-free.
function aHashFromBmp(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 54 || buf[0] !== 0x42 || buf[1] !== 0x4d) throw new Error('not a BMP');
  const dataOff = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const height = Math.abs(buf.readInt32LE(22));
  const bpp = buf.readUInt16LE(28);
  const bytesPP = Math.max(1, bpp >> 3);
  const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
  const grays = [];
  for (let row = 0; row < height; row++) {
    let off = dataOff + row * rowSize;
    for (let col = 0; col < width; col++) {
      const b = buf[off], g = buf[off + 1], r = buf[off + 2]; // BMP is BGR(A)
      grays.push((b + g + r) / 3);
      off += bytesPP;
    }
  }
  if (!grays.length) throw new Error('no pixels');
  const mean = grays.reduce((s, v) => s + v, 0) / grays.length;
  let hash = 0n;
  for (let i = 0; i < grays.length; i++) hash = (hash << 1n) | (grays[i] >= mean ? 1n : 0n);
  return hash;
}

function hamming(a, b) {
  let x = a ^ b, c = 0n;
  while (x) { c += x & 1n; x >>= 1n; }
  return Number(c);
}

// ═══════════════════════════════════════════════════════════════════════════
// StruggleDetector — pure math, no LLM. Rolling window of OCR snapshots.
// ═══════════════════════════════════════════════════════════════════════════
class StruggleDetector {
  constructor(cfg) {
    this.cfg = cfg;
    this.window = [];          // [{ ts, app, appClass, ocr, ocrHash, bottomHash }]
    this.lastApp = null;
    this.strugglingSince = null; // when composite first crossed threshold (grace timer)
    this.lastFireTs = 0;         // cooldown anchor
  }

  reset(reason) {
    this.window = [];
    this.strugglingSince = null;
    // cooldown intentionally persists across resets — it's a global anti-nag.
    return reason;
  }

  // Add a snapshot; returns true if the window was reset (app switch).
  push(snap, now) {
    let switched = false;
    if (this.lastApp !== null && snap.app !== this.lastApp) { this.reset('app-switch'); switched = true; }
    this.lastApp = snap.app;
    this.window.push(snap);
    const cutoff = now - this.cfg.windowMs;
    while (this.window.length && this.window[0].ts < cutoff) this.window.shift();
    return switched;
  }

  signals() {
    const w = this.window, n = w.length, c = this.cfg;
    const out = { trialError: 0, undo: 0, repeatedOutput: 0, lowProgress: 0 };
    if (n < c.minSnapshots) return out;

    // 1) Trial-and-error — ratio of unique OCR states.
    const uniq = new Set(w.map((s) => s.ocrHash)).size;
    const ratio = uniq / n;
    if (ratio > c.trialErrorRatio) out.trialError = clamp01((ratio - c.trialErrorRatio) / (1 - c.trialErrorRatio));

    // 2) Undo/revert — current state matches one 2..5 back, with a DIFFERENT
    //    state in between (genuine back-out, not mere constancy).
    let reverts = 0;
    for (let i = c.undoLookbackMin; i < n; i++) {
      for (let j = i - c.undoLookbackMax; j <= i - c.undoLookbackMin; j++) {
        if (j < 0) continue;
        if (w[j].ocrHash !== w[i].ocrHash) continue;
        let intervening = false;
        for (let k = j + 1; k < i; k++) if (w[k].ocrHash !== w[i].ocrHash) { intervening = true; break; }
        if (intervening) { reverts++; break; }
      }
    }
    out.undo = clamp01(reverts / c.undoMaxCount);

    // 3) Repeated output — same bottom-of-screen hash dominating (stuck error).
    //    Blank-bottom snapshots are excluded so empty terminals don't trip it.
    const counts = new Map();
    let withOutput = 0, top = 0;
    for (const s of w) {
      if (!s.bottomHash) continue;
      withOutput++;
      const cc = (counts.get(s.bottomHash) || 0) + 1;
      counts.set(s.bottomHash, cc);
      if (cc > top) top = cc;
    }
    if (withOutput >= c.repeatedOutputMin) {
      const freq = top / withOutput;
      if (freq > c.repeatedOutputFreq) out.repeatedOutput = clamp01((freq - c.repeatedOutputFreq) / (1 - c.repeatedOutputFreq));
    }

    // 4) Low progress — small avg edit-distance across consecutive states.
    let sum = 0, pairs = 0;
    for (let i = 1; i < n; i++) { sum += normEditDist(w[i - 1].ocr, w[i].ocr, c.editDistMaxChars); pairs++; }
    if (pairs >= c.minSnapshots - 1) {
      const avg = sum / pairs;
      if (avg < c.lowProgressDistCap) out.lowProgress = clamp01((c.lowProgressDistCap - avg) / c.lowProgressDistCap);
    }
    return out;
  }

  // Composite + brake evaluation. Returns the decision for this cycle.
  analyze(now) {
    const c = this.cfg, sig = this.signals();
    const score = sig.trialError * c.weights.trialError
      + sig.undo * c.weights.undo
      + sig.repeatedOutput * c.weights.repeatedOutput
      + sig.lowProgress * c.weights.lowProgress;
    const ready = this.window.length >= c.minSnapshots;
    const over = ready && score >= c.struggleThreshold;

    // Grace: composite must stay over threshold for graceMs before it can fire.
    if (over) { if (!this.strugglingSince) this.strugglingSince = now; }
    else this.strugglingSince = null;

    const graceMet = this.strugglingSince && (now - this.strugglingSince) >= c.graceMs;
    const cooled = (now - this.lastFireTs) >= c.cooldownMs;
    const fire = !!(graceMet && cooled);
    if (fire) { this.lastFireTs = now; this.strugglingSince = null; } // re-arm after cooldown

    const sustainedMs = this.strugglingSince ? now - this.strugglingSince : (fire ? c.graceMs : 0);
    return { score, signals: sig, ready, over, fire, sustainedMs, snapshots: this.window.length };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// The awareness engine — owns the loop and the cheap gates.
// ═══════════════════════════════════════════════════════════════════════════
function createAwareness({ ollamaUrl, visionModel, emit, log } = {}) {
  const cfg = { ...CONFIG };
  const tmp = (name) => path.join(os.tmpdir(), name);
  const diag = (line) => (log ? log(line) : console.log(`[awareness] ${line}`));
  const send = (channel, payload) => { try { emit && emit(channel, payload); } catch (_) {} };

  let running = false;
  let timer = null;
  let inCycle = false;
  let lastFrameHash = null;
  const detector = new StruggleDetector(cfg);

  // Capture the configured display to a raw PNG; returns its path (caller deletes).
  async function captureRaw() {
    const raw = tmp(`hannibal-aware-${cfg.display}.png`);
    await runToFile('/usr/sbin/screencapture', ['-x', '-D', String(cfg.display), raw], raw);
    return raw;
  }

  async function frameHash(raw) {
    const bmp = tmp('hannibal-aware-hash.bmp');
    try {
      await runToFile('/usr/bin/sips', ['-s', 'format', 'bmp', '-z', '8', '8', raw, '--out', bmp], bmp);
      const h = aHashFromBmp(bmp);
      return h;
    } finally { fs.unlink(bmp, () => {}); }
  }

  async function toJpegB64(raw) {
    const jpg = tmp('hannibal-aware-frame.jpg');
    try {
      await runToFile('/usr/bin/sips', ['-s', 'format', 'jpeg', '-Z', String(cfg.visionMaxPx), raw, '--out', jpg], jpg);
      return fs.readFileSync(jpg).toString('base64');
    } finally { fs.unlink(jpg, () => {}); }
  }

  // The ONE expensive call — only when the cheap layer says it's warranted.
  async function visionLook(b64, appClass) {
    const sys = 'You are Hannibal, Fred\'s personal AI assistant, quietly watching his screen. '
      + 'The cheap on-device signals say he has been STUCK for a couple of minutes in a '
      + `${appClass.replace('_', ' ')}. Take one real look at this screenshot and judge whether to interrupt. `
      + 'Reply with STRICT JSON only: {"notable": true|false, "urgency": "low"|"medium"|"high", '
      + '"what": "<one sentence: what he is stuck on>", "offer": "<one short, concrete, spoken offer of help>"}. '
      + 'If nothing genuinely needs his attention, set notable=false. Keep it brief — you are spoken aloud.';
    const res = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: visionModel, stream: false, format: 'json', options: { temperature: 0.3 },
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: 'What is he stuck on, and what is the single most useful thing you could offer? Reply JSON.', images: [b64] },
        ],
      }),
      signal: AbortSignal.timeout(cfg.visionTimeoutMs),
    });
    if (!res.ok) throw new Error(`vision HTTP ${res.status}`);
    const j = await res.json();
    let obj = {};
    try { obj = JSON.parse((j.message && j.message.content) || '{}'); } catch (_) {}
    return {
      notable: obj.notable !== false,
      urgency: ['low', 'medium', 'high'].includes(obj.urgency) ? obj.urgency : 'medium',
      what: String(obj.what || '').trim(),
      offer: String(obj.offer || '').trim(),
    };
  }

  async function runCycle() {
    const now = Date.now();
    let raw = null;
    try {
      raw = await captureRaw();

      // ── CAPTURE GATE — perceptual hash, no model. ──
      const h = await frameHash(raw);
      if (lastFrameHash === null) {
        lastFrameHash = h;
        diag('cycle: captured baseline (first frame)');
        return;
      }
      const dist = hamming(lastFrameHash, h);
      lastFrameHash = h; // always compare consecutive frames
      if (dist <= cfg.changeHammingThreshold) {
        diag(`cycle: captured / skipped-no-change (dist=${dist}≤${cfg.changeHammingThreshold})`);
        return;
      }

      // ── CHANGE GATE PASSED — who's in front + cheap OCR. ──
      const { app, title } = await frontmost();
      const appClass = classifyApp(app, title);
      const r = await ocr(raw);
      if (!r.ok) { diag(`cycle: captured / change(dist=${dist}) / ocr-FAILED (${r.error})`); return; }
      const text = r.text;
      const bottom = text.slice(-cfg.bottomChars).trim();
      const snap = {
        ts: now, app, appClass,
        ocr: text,
        ocrHash: djb2(text),
        bottomHash: bottom ? djb2(bottom) : '',
      };
      const switched = detector.push(snap, now);

      // ── STRUGGLE DETECTION — pure math. ──
      const d = detector.analyze(now);
      const s = d.signals;
      const sigStr = `te${s.trialError.toFixed(2)} un${s.undo.toFixed(2)} ro${s.repeatedOutput.toFixed(2)} lp${s.lowProgress.toFixed(2)}`;
      const graceStr = d.over ? `grace=${Math.round(d.sustainedMs / 1000)}s/${Math.round(cfg.graceMs / 1000)}s` : 'grace=–';
      const head = `cycle: captured / change(dist=${dist}) / ocr-done(chars=${text.length} app="${app}" ${appClass})${switched ? ' [window reset: app-switch]' : ''}`;

      send('awareness:tick', { app, appClass, score: d.score, snapshots: d.snapshots, ts: now });

      if (!d.fire) {
        diag(`${head} / struggle-score=${d.score.toFixed(2)} [${sigStr}] ${graceStr} ${d.ready ? '' : '(warming up)'}`.trim());
        return;
      }

      // ── STRUGGLE FIRED — the one place the vision model runs. ──
      diag(`${head} / struggle-score=${d.score.toFixed(2)} [${sigStr}] FIRE → vision`);
      let look;
      try { look = await visionLook(await toJpegB64(raw), appClass); }
      catch (e) { diag(`cycle: vision-FAILED (${e.message})`); return; }
      if (!look.notable) { diag(`cycle: vision said not-notable ("${look.what}") — staying quiet`); return; }

      // Hand it to the renderer's speak gate (overlap guards + Qdrant memory there).
      send('awareness:observation', {
        kind: 'struggle', app, appClass, score: d.score,
        urgency: look.urgency, what: look.what, offer: look.offer, ts: now,
      });
      diag(`cycle: NOTABLE urgency=${look.urgency} "${look.what}" → renderer speak gate`);
    } catch (e) {
      diag(`cycle: ERROR ${e.message}`);
    } finally {
      if (raw) fs.unlink(raw, () => {}); // frame deleted after processing — never stored
    }
  }

  async function loop() {
    if (!running) return;
    if (!inCycle) { // never overlap cycles (a slow vision call must not stack)
      inCycle = true;
      try { await runCycle(); } catch (e) { diag(`loop error ${e.message}`); }
      inCycle = false;
    }
    if (running) timer = setTimeout(loop, cfg.captureIntervalMs);
  }

  return {
    isWatching: () => running,
    config: () => ({ ...cfg }),
    setConfig: (patch) => {
      if (patch && typeof patch === 'object') {
        for (const k of Object.keys(patch)) {
          if (k === 'weights' && patch.weights) Object.assign(cfg.weights, patch.weights);
          else if (k in cfg) cfg[k] = patch[k];
        }
        detector.cfg = cfg;
      }
      return { ...cfg };
    },
    async start(patch) {
      if (patch) this.setConfig(patch);
      if (running) return { ok: true, watching: true, already: true };
      const helper = await ensureOcrHelper();
      if (!helper.ok) { diag(`start FAILED — OCR helper: ${helper.error}`); return { ok: false, error: `OCR helper: ${helper.error}` }; }
      running = true;
      lastFrameHash = null;
      detector.reset('start'); detector.lastApp = null; detector.lastFireTs = 0;
      diag(`START — interval=${cfg.captureIntervalMs}ms change≤${cfg.changeHammingThreshold}bits struggle≥${cfg.struggleThreshold} grace=${cfg.graceMs / 1000}s cooldown=${cfg.cooldownMs / 1000}s`);
      send('awareness:state', { watching: true });
      loop();
      return { ok: true, watching: true };
    },
    stop() {
      if (!running) { send('awareness:state', { watching: false }); return { ok: true, watching: false }; }
      running = false;
      if (timer) { clearTimeout(timer); timer = null; }
      diag('STOP');
      send('awareness:state', { watching: false });
      return { ok: true, watching: false };
    },
    status() { return { watching: running, config: { ...cfg } }; },
  };
}

module.exports = {
  createAwareness,
  // exported for headless unit-testing of the cheap math (see scripts/awareness-selftest)
  StruggleDetector, aHashFromBmp, hamming, normEditDist, djb2, classifyApp, CONFIG,
};
