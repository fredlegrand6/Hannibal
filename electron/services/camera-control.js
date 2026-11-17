// ─────────────────────────────────────────────────────────────────────────
// CAMERA CONTROL — OBSBOT Tiny 3 pan/tilt/zoom/track steering layer.
// (Sits BESIDE the existing vision.capture "eyes"; this is the "hands".)
//
// TRANSPORT (chosen in STAP 0 — see WHY below): OSC over UDP to OBSBOT Center.
//   • OBSBOT_Center.app is installed AND running on this Mac, and the OBSBOT
//     Tiny 3 is attached (UVC VendorID 0x3564 / ProductID 0xFF02).
//   • OBSBOT Center exposes a full OSC control surface. Its address schema is
//     compiled into the app binary — Tiny-3-specific addresses are present:
//       /OBSBOT/WebCam/General/SetGimMotorDegreeEx   (absolute pan/tilt degrees)
//       /OBSBOT/WebCam/General/SetGimbal{Up,Down,Left,Right}  (relative nudge)
//       /OBSBOT/WebCam/General/ResetGimbal            (recenter)
//       /OBSBOT/WebCam/General/SetZoom                (absolute zoom)
//       /OBSBOT/WebCam/General/GetGimbalPosInfo(+Resp), GetZoomInfo (read-back)
//       /OBSBOT/WebCam/Tiny/SetAiMode, SetTrackingMode, TriggerPreset, ToggleAILock
//   • It is UDP, so Node's built-in `dgram` speaks it with ZERO new npm deps —
//     the OSC 1.0 wire format (below) is a few lines to hand-roll.
//
//   WHY NOT the alternatives (probed in STAP 0):
//     (b) UVC-PTZ over USB — no macOS PTZ CLI is installed (uvc-util/uvcc/v4l2
//         all absent = a NEW binary dependency), and the Tiny's gimbal motion,
//         AI tracking and presets are proprietary, only partially on standard
//         UVC. Would give incomplete control. Rejected.
//     (c) VISCA over serial — a /dev/cu.usbmodem port exists but could NOT be
//         confirmed as the OBSBOT, and the Tiny 3 is not a documented VISCA
//         device (VISCA is the Tail Air line). Unverified + risky. Rejected.
//     (d) OBSBOT SDK / npm — no official Node SDK exists. Rejected.
//
// ONE-TIME SETUP FRED MUST DO (config, not code — this is why nothing is live
// until you flip it): OBSBOT Center → Settings → OSC → enable, and set the
// "OSC receive port" to match HANNIBAL_OBSBOT_OSC_PORT below (default 16284).
// Nothing was listening on an OSC port during the scan, so OSC is currently OFF.
//
// HONESTY NOTE: OBSBOT does not publish the per-address ARGUMENT schema, and this
// file could not be live-tested (OSC was off during the build). The addresses are
// certain (extracted from the binary); the argument encodings below are best-effort
// and are the first thing to tune on Fred's live run. Every send is logged.
//
// SIDE-EFFECT: camera motion is a trivially-reversible device toggle (recenter
// with camera.reset), same class as mac.volume*/brightness — so all camera.*
// tools are READ in the catalog and never hit the confirmation gate.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const dgram = require('dgram');

const CFG = {
  host: process.env.HANNIBAL_OBSBOT_OSC_HOST || '127.0.0.1',
  // OBSBOT Center's OSC *receive* port (where we SEND commands). User-set in the
  // app; override here to match. 16284 is the default this layer assumes.
  port: parseInt(process.env.HANNIBAL_OBSBOT_OSC_PORT || '16284', 10),
  // Local port we bind to hear *Resp read-backs (camera.status). Best-effort.
  recvPort: parseInt(process.env.HANNIBAL_OBSBOT_OSC_RECV_PORT || '16285', 10),
  statusTimeoutMs: parseInt(process.env.HANNIBAL_OBSBOT_STATUS_TIMEOUT_MS || '700', 10),
  // How long to let the gimbal settle before camera.look grabs a frame.
  settleMs: parseInt(process.env.HANNIBAL_OBSBOT_SETTLE_MS || '650', 10),
  // "Look around" = a real scan: how many frames across the sweep, and the gap
  // between each shot (Fred wants continuous looking, ~a frame every 2s).
  scanFrames: parseInt(process.env.HANNIBAL_OBSBOT_SCAN_FRAMES || '4', 10),
  scanStepMs: parseInt(process.env.HANNIBAL_OBSBOT_SCAN_STEP_MS || '2000', 10),
  // STAP 3 calibration knob: magnitude sent with ONE relative nudge. Live-found
  // that absolute degrees are unreliable (40→~190°) but relative nudges work; the
  // true degrees-per-unit is not yet calibrated, so tune this without code edits.
  nudgeDeg: parseFloat(process.env.HANNIBAL_OBSBOT_NUDGE_DEG || '15'),
  // SetAiMode ON value. Live-found [0] = tracking OFF; the ON value is assumed 1
  // (human-follow) and left tunable until verified on Fred's live run.
  aiOnValue: parseInt(process.env.HANNIBAL_OBSBOT_AI_ON || '1', 10),
  // SetTrackingMode value for upper- vs full-body framing (assumed; tunable).
  frameUpperValue: parseInt(process.env.HANNIBAL_OBSBOT_FRAME_UPPER || '1', 10),
  frameFullValue:  parseInt(process.env.HANNIBAL_OBSBOT_FRAME_FULL  || '0', 10),
};

const OSC = {
  // ⚠ UNRELIABLE (live-found: scale is off — 40 → ~190°). Kept but NOT the default;
  // relative SetGimbal{Up,Down,Left,Right} is the working path until calibrated.
  aimAbs:   '/OBSBOT/WebCam/General/SetGimMotorDegreeEx',
  up:       '/OBSBOT/WebCam/General/SetGimbalUp',
  down:     '/OBSBOT/WebCam/General/SetGimbalDown',
  left:     '/OBSBOT/WebCam/General/SetGimbalLeft',
  right:    '/OBSBOT/WebCam/General/SetGimbalRight',
  reset:    '/OBSBOT/WebCam/General/ResetGimbal',
  zoom:     '/OBSBOT/WebCam/General/SetZoom',
  getPos:   '/OBSBOT/WebCam/General/GetGimbalPosInfo',
  getZoom:  '/OBSBOT/WebCam/General/GetZoomInfo',
  aiMode:   '/OBSBOT/WebCam/Tiny/SetAiMode',
  trackMode:'/OBSBOT/WebCam/Tiny/SetTrackingMode',
  preset:   '/OBSBOT/WebCam/Tiny/TriggerPreset',
};

// Module state we can't reliably read back over OSC (best-effort mirror).
let lastZoom = 50; // 0..100

// ── OSC 1.0 wire format (address + ',typetags' + args, each 4-byte aligned) ──
function pad4(buf) {
  const rem = buf.length % 4;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - rem)]);
}
function oscStr(s) {
  return pad4(Buffer.concat([Buffer.from(String(s), 'ascii'), Buffer.from([0])]));
}
function oscMessage(address, args = []) {
  let tags = ',';
  const argBufs = [];
  for (const a of args) {
    if (typeof a === 'string') { tags += 's'; argBufs.push(oscStr(a)); }
    else if (Number.isInteger(a)) { const b = Buffer.alloc(4); b.writeInt32BE(a); tags += 'i'; argBufs.push(b); }
    else { const b = Buffer.alloc(4); b.writeFloatBE(a); tags += 'f'; argBufs.push(b); }
  }
  return Buffer.concat([oscStr(address), oscStr(tags), ...argBufs]);
}

function sendOsc(address, args = []) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const msg = oscMessage(address, args);
    sock.send(msg, CFG.port, CFG.host, (err) => {
      sock.close();
      if (err) { console.log('[camera] OSC send failed', address, err.message); resolve({ ok: false, address, error: err.message }); }
      else { console.log('[camera] OSC →', address, JSON.stringify(args)); resolve({ ok: true, address, args }); }
    });
  });
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── individual actions ───────────────────────────────────────────────────────
// DEFAULT is 'relative' (the working path). pan/tilt are magnitudes in device
// units; if given but zero-ish, one CFG.nudgeDeg step is used. Absolute mode is
// kept but UNRELIABLE (scale off) — only used if explicitly requested.
async function aim({ pan = 0, tilt = 0, mode = 'relative' } = {}) {
  pan = Number(pan) || 0; tilt = Number(tilt) || 0;
  if (mode !== 'absolute') {
    const out = [];
    if (pan) out.push(await sendOsc(pan > 0 ? OSC.right : OSC.left, [Math.abs(pan)]));
    if (tilt) out.push(await sendOsc(tilt > 0 ? OSC.up : OSC.down, [Math.abs(tilt)]));
    return { ok: out.every((r) => r.ok), mode: 'relative', pan, tilt, unit: 'device', sent: out.map((r) => r.address) };
  }
  // absolute: pan/tilt in degrees. ⚠ UNRELIABLE scale — prefer relative.
  const p = clamp(pan, -160, 160), t = clamp(tilt, -90, 90);
  const r = await sendOsc(OSC.aimAbs, [Math.round(p), Math.round(t)]);
  return { ok: r.ok, mode: 'absolute', pan: p, tilt: t, warning: 'absolute encoding is unreliable — use relative' };
}

// One relative nudge in a named direction, CFG.nudgeDeg magnitude (the calibration
// knob). This is what "look a bit left/right/up/down" should use.
async function nudge(direction, steps = 1) {
  const mag = Math.abs(CFG.nudgeDeg * (Number(steps) || 1));
  const addr = { left: OSC.left, right: OSC.right, up: OSC.up, down: OSC.down }[direction];
  if (!addr) return { ok: false, error: `unknown nudge direction "${direction}"` };
  const r = await sendOsc(addr, [mag]);
  return { ok: r.ok, direction, magnitude: mag };
}

async function zoom({ level, direction } = {}) {
  if (direction) {
    const step = direction === 'in' ? 25 : -25;
    lastZoom = clamp(lastZoom + step, 0, 100);
    const r = await sendOsc(OSC.zoom, [Math.round(lastZoom)]);
    return { ok: r.ok, direction, level: lastZoom };
  }
  const lvl = clamp(Number(level) || 0, 0, 100);
  lastZoom = lvl;
  const r = await sendOsc(OSC.zoom, [Math.round(lvl)]);
  return { ok: r.ok, level: lvl };
}

// STAP 1: "Volg Fred". mode:'auto' → SetAiMode(ON) so the OBSBOT's own AI tracking
// finds and locks onto Fred (we drive it, we don't rebuild it); optional frame sets
// upper/full framing. mode:'off' → SetAiMode(0), which frees the gimbal for a
// deliberate manual look (they fight otherwise — live-established). This is the
// REST STATE: whenever Hannibal isn't deliberately looking elsewhere, call
// track({mode:'auto', frame:'upper'}) and the camera keeps itself on Fred.
async function track({ mode = 'auto', frame, group } = {}) {
  const on = mode === 'auto' || mode === 'on' || mode === true;
  const aiVal = !on ? 0 : (group ? 2 : CFG.aiOnValue); // group-follow rides on variant 2 (best-effort)
  const out = [await sendOsc(OSC.aiMode, [aiVal])];
  if (on && frame) {
    const fv = frame === 'upper' ? CFG.frameUpperValue : CFG.frameFullValue;
    out.push(await sendOsc(OSC.trackMode, [fv]));
  }
  return { ok: out.every((r) => r.ok), mode: on ? 'auto' : 'off', aiVal, frame: on ? (frame || null) : null, group: !!group };
}

// Convenience for the rest state — the one call that puts the camera back on Fred.
function followFred() { return track({ mode: 'auto', frame: 'upper' }); }

async function preset({ slot = 1 } = {}) {
  const s = clamp(Math.round(Number(slot) || 1), 1, 9);
  const r = await sendOsc(OSC.preset, [s]);
  return { ok: r.ok, slot: s };
}

async function reset() {
  const r = await sendOsc(OSC.reset, []);
  lastZoom = 50;
  return { ok: r.ok, reset: true };
}

// Best-effort read-back: ask for pos+zoom, listen briefly for any *Resp. OBSBOT
// only replies if OSC send-back is configured, so this DEGRADES gracefully.
async function status() {
  const result = await new Promise((resolve) => {
    let done = false;
    const sock = dgram.createSocket('udp4');
    const finish = (payload) => {
      if (done) return; done = true;
      try { sock.close(); } catch (_) {}
      resolve(payload);
    };
    sock.on('error', () => finish({ ok: true, degraded: true, note: 'OSC read-back socket error' }));
    sock.on('message', (buf) => {
      const s = buf.toString('latin1');
      const addr = (s.split(' ')[0] || '').trim();
      finish({ ok: true, degraded: false, raw: addr, bytes: buf.length });
    });
    sock.bind(CFG.recvPort, () => {
      sendOsc(OSC.getPos, []);
      sendOsc(OSC.getZoom, []);
      setTimeout(() => finish({
        ok: true, degraded: true, lastZoom,
        note: 'No OSC read-back within timeout — enable OSC send-back in OBSBOT Center '
          + `and point it at 127.0.0.1:${CFG.recvPort} for live pan/tilt/zoom status.`,
      }), CFG.statusTimeoutMs);
    });
  });
  return result;
}

// ── LOOK composite (STAP 2): a deliberate glance that NEVER fights the tracker.
//   1. track OFF            (SetAiMode 0 — free the gimbal; AI-on would yank back to Fred)
//   2. aim via RELATIVE nudge (absolute degrees are unreliable, so we nudge)
//   3. settle → reuse the EXISTING camera capture → frame for the vision model
//   4. return to Fred: track auto/upper (unless the caller asks to stay put)
// So "find me / stay on me" is the default and "look over there" is a temporary
// excursion that auto-falls-back onto Fred. `captureCameraFrame` is injected from
// main.js so camera device selection is NOT duplicated.
function makeLook(captureCameraFrame) {
  // `dir`/`around`/`steps` are VOICE-PATH conveniences (not in the catalog — the
  // planner uses pan/tilt). `dir` routes through nudge() so directional looks share
  // the HANNIBAL_OBSBOT_NUDGE_DEG calibration knob.
  return async function look({ target, dir, steps, around, pan, tilt, zoom: z, stay = false, frames, stepMs } = {}) {
    const moved = {};
    const wantsMove = dir || around || pan !== undefined || tilt !== undefined || z !== undefined;

    // ── AROUND = a real SCAN: sweep across the room in steps, grabbing a frame at
    //    each stop (~every stepMs, default 2s) so Hannibal actually takes the room
    //    in, instead of one snapshot. Returns all frames; the caller/vision can
    //    reason over the sweep. Falls back onto Fred at the end.
    if (around) {
      moved.trackOff = await track({ mode: 'off' });
      const nShots = Math.max(2, Number(frames) || Number(CFG.scanFrames) || 4);
      const gap = Math.max(300, Number(stepMs) || Number(CFG.scanStepMs) || 2000);
      const stepN = Number(steps) || 1;
      // sweep pattern across the pan range: start left, walk right across the room.
      const seq = ['left', 'left', 'right', 'right', 'right', 'right']; // net: swing left, then pan across
      const shots = [];
      // first swing off Fred to the left edge
      await nudge('left', stepN * 2);
      await sleep(gap);
      for (let i = 0; i < nShots; i++) {
        const f = typeof captureCameraFrame === 'function' ? await captureCameraFrame() : { ok: false };
        if (f && f.ok && f.b64) shots.push(f.b64);
        if (i < nShots - 1) { await nudge('right', stepN); await sleep(gap); }
      }
      moved.scan = { frames: shots.length, stepMs: gap };
      if (!stay) moved.returnedToFred = await followFred();
      return {
        ok: shots.length > 0, target: target || null, moved,
        b64: shots[0], frames: shots, scanned: shots.length,
        restedOnFred: !stay,
      };
    }
    // 1. release the tracker so the manual aim can hold.
    if (wantsMove) moved.trackOff = await track({ mode: 'off' });
    // 2. move: named direction (calibrated nudge), a simple "around" sweep, or raw pan/tilt.
    if (dir) moved.aim = await nudge(dir, steps || 2);
    else if (around) moved.aim = await nudge('right', steps || 2); // simple look-around: swing off Fred
    else if (pan !== undefined || tilt !== undefined) moved.aim = await aim({ pan, tilt, mode: 'relative' });
    if (z !== undefined) moved.zoom = await zoom({ level: z });
    // 3. let the gimbal settle, then grab the frame.
    if (wantsMove) await sleep(CFG.settleMs);
    const frame = typeof captureCameraFrame === 'function'
      ? await captureCameraFrame()
      : { ok: false, error: 'no camera capture function injected' };
    // 4. fall back onto Fred (unless explicitly told to stay).
    if (wantsMove && !stay) moved.returnedToFred = await followFred();
    return {
      ok: !!frame.ok, target: target || null, moved, b64: frame.b64,
      restedOnFred: !!(wantsMove && !stay),
      captureError: frame.ok ? undefined : frame.error,
    };
  };
}

// ── registration: exposes the 'camera:control' IPC channel (auto-captured by
// the executor's tool tap, exactly like 'mac-control'). Signature mirrors
// mac-control: (event, action, params).
function registerCameraControl(ipcMain, { captureCameraFrame } = {}) {
  // The COORDINATOR is the single owner of the gimbal (serialization + state
  // machine + verified re-assert + follow watchdog). Every camera:control action
  // — from the voice path AND the autonomous presence loop, which both reach this
  // same IPC channel — routes through it, so nothing can interleave or strand the
  // camera off Fred. See camera-coordinator.js.
  const { createCameraCoordinator } = require('./camera-coordinator');
  const coordinator = createCameraCoordinator({
    primitives: { aim, zoom, track, followFred, preset, reset, status },
    makeLook, captureCameraFrame,
  });
  const dispatch = {
    aim:    (p) => coordinator.aim(p),
    zoom:   (p) => coordinator.zoom(p),
    track:  (p) => coordinator.track(p),
    preset: (p) => coordinator.preset(p),
    reset:  (p) => coordinator.reset(p),
    status: (p) => coordinator.status(p),
    look:   (p) => coordinator.look(p),
  };
  ipcMain.handle('camera:control', async (_e, action, params) => {
    const fn = dispatch[action];
    if (!fn) return { ok: false, error: `unknown camera action "${action}"` };
    try {
      const p = typeof params === 'string' ? JSON.parse(params) : (params || {});
      return await fn(p);
    } catch (e) {
      console.log('[camera] action failed', action, e.message);
      return { ok: false, error: e.message };
    }
  });
  console.log(`[camera] OSC steering ready → ${CFG.host}:${CFG.port} via coordinator (enable OSC in OBSBOT Center to activate)`);
  return coordinator; // caller stops its heartbeat on quit
}

module.exports = { registerCameraControl, makeLook, CFG, OSC, _internal: { oscMessage, aim, nudge, zoom, track, followFred, preset, reset, status } };
