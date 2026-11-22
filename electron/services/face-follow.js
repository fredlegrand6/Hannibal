// ─────────────────────────────────────────────────────────────────────────
// FACE FOLLOW — Hannibal turns the OBSBOT himself to keep Fred in the picture.
//
// The camera's own Human Tracking would not stay on (2026-11-19), so Hannibal
// does it:
//   • native/face-follow (Swift + Apple Vision) watches the OBSBOT and prints
//     where faces are, ~6 times a second. It shares the camera with the normal
//     snapshots (tested: both work at once).
//   • a small controller turns that into gimbal moves over OSC to OBSBOT Center.
//
// Live-found on the Tiny 3: SetGimbal{Up,Down,Left,Right} [n] is a SPEED, not a
// step. The gimbal keeps turning until the same command is sent with [0]. So
// the controller sends a speed when Fred is off-centre and 0 when he is back,
// and every way out (face lost, stop, quit) sends 0 on both axes.
//
// Env: HANNIBAL_CAMERA_FOLLOW=0 turns it off at start-up; HANNIBAL_FOLLOW_MAX_SPEED
// (default 30) caps how fast it turns.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const { spawn, execFile } = require('child_process');

const DEFAULTS = {
  targetX: 0.5,        // face centre wanted here (0..1 across)
  targetY: 0.38,       // a little above the middle: head room like a person framing
  startAt: 0.12,       // start turning when the face is this far off
  stopAt: 0.05,        // and stop again once it is this close
  gain: 70,            // speed per unit of error
  minSpeed: 6,
  maxSpeed: Number(process.env.HANNIBAL_FOLLOW_MAX_SPEED) || 30,
  smooth: 0.5,         // EMA on the face centre (1 = no smoothing)
  lostAfterMs: 900,    // no face this long → stop moving…
  searchMs: 2500,      // …unless he left over an edge: keep turning that way this long
};

// Pure: faces in, gimbal commands out. One controller per run.
function createFollowController(opts = {}) {
  const c = { ...DEFAULTS, ...opts };
  let fx = null, fy = null, lastSeen = 0;
  const moving = { pan: null, tilt: null }; // { dir, speed } or null

  function axis(name, err, pos, neg) {
    const cur = moving[name];
    const mag = Math.abs(err);
    const want = (cur ? mag > c.stopAt : mag > c.startAt)
      ? { dir: err > 0 ? pos : neg, speed: Math.max(c.minSpeed, Math.min(c.maxSpeed, Math.round(c.gain * mag))) }
      : null;
    const out = [];
    if (cur && (!want || want.dir !== cur.dir)) out.push({ dir: cur.dir, speed: 0 });
    if (want && (!cur || want.dir !== cur.dir || Math.abs(want.speed - cur.speed) >= 3)) out.push(want);
    moving[name] = want ? (out.length ? want : cur) : null;
    return out;
  }

  // Was he last seen near an edge (and are we already turning that way)?
  function nearEdge() {
    if (fx == null) return false;
    return fx < 0.15 || fx > 0.85 || fy < 0.15 || fy > 0.85;
  }

  function halt() {
    const out = [];
    for (const k of ['pan', 'tilt']) if (moving[k]) { out.push({ dir: moving[k].dir, speed: 0 }); moving[k] = null; }
    return out;
  }

  const biggest = (list) => (list || []).slice().sort((a, b) => b.w * b.h - a.w * a.h)[0];

  // Where Fred's head is: his face, or else the top of his body (standing up,
  // the face leaves the picture first). null when neither is seen.
  function head(faces, bodies) {
    const f = biggest(faces);
    if (f) return { cx: f.x + f.w / 2, cy: f.y + f.h / 2 };
    const b = biggest(bodies);
    if (b) return { cx: b.x + b.w / 2, cy: b.y + Math.min(0.12, b.h * 0.12) };
    return null;
  }

  function step(faces, now = Date.now(), bodies = []) {
    const h = head(faces, bodies);
    if (!h) {
      // Lost him. If he went out over an edge, keep turning that way for a
      // moment (search); otherwise stop.
      if (now - lastSeen > c.searchMs) { fx = fy = null; return halt(); }
      if (now - lastSeen > c.lostAfterMs && !nearEdge()) { fx = fy = null; return halt(); }
      return [];
    }
    lastSeen = now;
    const { cx, cy } = h;
    fx = fx == null ? cx : fx + c.smooth * (cx - fx);
    fy = fy == null ? cy : fy + c.smooth * (cy - fy);
    // Face right of the target → turn right. Face low in the picture → tilt down.
    return [...axis('pan', fx - c.targetX, 'right', 'left'), ...axis('tilt', fy - c.targetY, 'down', 'up')];
  }

  return { step, halt, state: () => ({ ...moving }) };
}

// Pure: did Fred just walk in? He must have been out of the picture for
// awayMs, then be seen steadily for presentMs. Starts as "here" so a restart
// of Hannibal does not trigger a greeting.
function createArrivalWatch({ awayMs = Number(process.env.HANNIBAL_GREET_AWAY_MIN || 10) * 60000, presentMs = 1500, now = Date.now() } = {}) {
  let lastSeen = now;      // last moment anyone was in the picture
  let seenSince = null;    // start of the current run of sightings
  let away = false;
  let lastHere = now;      // last sighting while he was settled here (not away)
  function see(present, t = Date.now()) {
    if (!present) {
      if (t - lastSeen > 3000) seenSince = null;   // short dropouts don't break a run
      if (t - lastSeen >= awayMs) away = true;
      return null;
    }
    const gone = t - lastSeen;
    if (gone >= awayMs) away = true;
    if (seenSince == null || gone > 3000) seenSince = t;
    lastSeen = t;
    if (!away) lastHere = t;
    if (away && t - seenSince >= presentMs) {
      away = false;
      const lastHere0 = lastHere;
      lastHere = t;
      return { arrived: true, awayMs: seenSince - lastHere0 };
    }
    return null;
  }
  return { see };
}

// What Hannibal says when Fred walks in.
function greetingFor({ awayMs = 0, date = new Date(), tz = 'Europe/Amsterdam', pick = Math.random } = {}) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: tz }).format(date)) % 24;
  const part = hour < 5 ? 'evening' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const hours = awayMs / 3600000;
  const options = hours >= 8
    ? [`Good ${part}, Fred. Good to see you.`, `Good ${part}, Fred. Ready when you are.`]
    : hours >= 2
      ? [`Welcome back, Fred. You were gone about ${Math.round(hours)} hours.`, `There you are, Fred. Good ${part}.`]
      : [`Welcome back, Fred.`, `Hey Fred, welcome back.`, `There you are.`];
  return options[Math.floor(pick() * options.length) % options.length];
}

const ADDR = { up: 'SetGimbalUp', down: 'SetGimbalDown', left: 'SetGimbalLeft', right: 'SetGimbalRight' };

function createFaceFollow({
  oscMessage, host = '127.0.0.1', port = 16284,
  camera = process.env.HANNIBAL_CAMERA || 'OBSBOT', fps = 6,
  root = path.join(__dirname, '..', '..'), log = (...a) => console.log('[follow]', ...a),
  onArrive = null,   // ({ awayMs }) → when Fred walks in after being away
} = {}) {
  const src = path.join(root, 'native', 'face-follow', 'FaceFollow.swift');
  const bin = path.join(root, 'native', 'face-follow', 'face-follow');
  let child = null, ctl = null, sock = null, wanted = false, restartTimer = null;
  let seen = { faces: 0, bodies: 0, at: 0 };   // last frame: how many people the camera sees

  function send(cmds) {
    if (!sock || !cmds.length) return;
    for (const { dir, speed } of cmds) {
      const msg = oscMessage(`/OBSBOT/WebCam/General/${ADDR[dir]}`, [speed]);
      sock.send(msg, port, host, () => {});
    }
  }

  function build() {
    return new Promise((resolve, reject) => {
      try {
        if (fs.existsSync(bin) && fs.statSync(bin).mtimeMs >= fs.statSync(src).mtimeMs) { resolve(); return; }
      } catch (_) {}
      log('building the face finder (one time)…');
      execFile('/usr/bin/swiftc', ['-O', src, '-o', bin], { timeout: 180000 }, (e, _o, se) => (e ? reject(new Error(se || e.message)) : resolve()));
    });
  }

  async function start() {
    wanted = true;
    if (child) return { ok: true, already: true };
    try { await build(); } catch (e) { log('could not build the face finder:', e.message.split('\n')[0]); return { ok: false, error: e.message }; }
    if (!wanted || child) return { ok: true };
    sock = sock || dgram.createSocket('udp4');
    ctl = createFollowController();
    const arrival = createArrivalWatch();
    child = spawn(bin, [camera, String(fps)], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const j = JSON.parse(line);
          send(ctl.step(j.faces, Date.now(), j.bodies));
          seen = { faces: (j.faces || []).length, bodies: (j.bodies || []).length, at: Date.now() };
          const a = arrival.see((j.faces || []).length > 0 || (j.bodies || []).length > 0);
          if (a && onArrive) { log(`Fred is back after ${Math.round(a.awayMs / 60000)} min`); try { onArrive(a); } catch (_) {} }
        } catch (_) {}
      }
    });
    child.stderr.on('data', (d) => log(String(d).trim()));
    child.on('exit', (code) => {
      if (ctl) send(ctl.halt());
      child = null;
      if (wanted) { log(`face finder stopped (${code}); restarting in 5s`); restartTimer = setTimeout(start, 5000); }
    });
    log('on: Hannibal keeps the camera on you');
    return { ok: true };
  }

  function stop() {
    wanted = false;
    clearTimeout(restartTimer);
    if (ctl) send(ctl.halt());
    // Belt and braces: zero every direction.
    send(Object.keys(ADDR).map((dir) => ({ dir, speed: 0 })));
    if (child) { try { child.stdin.end(); child.kill(); } catch (_) {} child = null; }
    log('off');
    return { ok: true };
  }

  // How many people are in frame right now (a hint for "is Fred talking to
  // someone else?"). null when the camera has not reported in the last 3 s.
  function people(now = Date.now()) {
    if (!child || now - seen.at > 3000) return null;
    return { count: Math.max(seen.faces, seen.bodies), faces: seen.faces, bodies: seen.bodies, at: seen.at };
  }

  return { start, stop, people, running: () => !!child };
}

module.exports = { createFollowController, createFaceFollow, createArrivalWatch, greetingFor, DEFAULTS };
