#!/usr/bin/env node
// Standalone tester for the OBSBOT camera-control OSC layer — no Electron needed.
// It drives electron/services/camera-control.js directly (dgram over UDP).
//
// PREREQ: OBSBOT Center running + OSC enabled (Settings → OSC), receive port set
// to match. Override the port if you didn't use 16284:
//   HANNIBAL_OBSBOT_OSC_PORT=8000 node scripts/camera-test.js aim 30 0
//
// Usage:
//   node scripts/camera-test.js follow             # tracking ON → camera finds Fred (rest state)
//   node scripts/camera-test.js follow-demo        # (a) find me → (b) look left → (c) back on me
//   node scripts/camera-test.js nudge left 2       # 2 relative nudges left (the working path)
//   node scripts/camera-test.js aim 10 0           # relative nudge: pan +10 device units
//   node scripts/camera-test.js aim 40 0 absolute  # absolute (UNRELIABLE — for scale testing only)
//   node scripts/camera-test.js zoom 60            # absolute zoom 60   (or: zoom in / zoom out)
//   node scripts/camera-test.js track auto upper   # AI track, upper-body frame
//   node scripts/camera-test.js track off          # release the gimbal
//   node scripts/camera-test.js preset 2
//   node scripts/camera-test.js reset
//   node scripts/camera-test.js status
//   node scripts/camera-test.js demo               # nudge sweep + zoom
//   tune the nudge step:  HANNIBAL_OBSBOT_NUDGE_DEG=25 node scripts/camera-test.js nudge left 1
const path = require('path');
const cc = require(path.join(__dirname, '..', 'electron', 'services', 'camera-control.js'));
const { aim, nudge, zoom, track, followFred, preset, reset, status } = cc._internal;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [, , cmd, a, b, c] = process.argv;

(async () => {
  console.log(`→ OBSBOT OSC at ${cc.CFG.host}:${cc.CFG.port}\n`);
  let out;
  switch (cmd) {
    case 'aim':   out = await aim({ pan: Number(a) || 0, tilt: Number(b) || 0, mode: c || 'relative' }); break;
    case 'nudge': out = await nudge(a || 'left', Number(b) || 1); break;
    case 'zoom':  out = /^\d+$/.test(a) ? await zoom({ level: Number(a) }) : await zoom({ direction: a }); break;
    case 'track': out = await track({ mode: a || 'auto', frame: b || 'upper' }); break;
    case 'follow':out = await followFred(); break;
    case 'preset':out = await preset({ slot: Number(a) || 1 }); break;
    case 'status':out = await status(); break;
    case 'reset': out = await reset(); break;
    // The STAP verification path Fred watches: find-me → look-away → back-on-me.
    case 'follow-demo':
      console.log('(a) tracking ON → camera should FIND Fred…'); await track({ mode: 'auto', frame: 'upper' }); await sleep(3000);
      console.log('(b) look LEFT → tracker released, nudge left, (capture happens in-app)…');
      await track({ mode: 'off' }); await nudge('left', 2); await sleep(2500);
      console.log('(c) back on Fred → tracking ON again, camera returns…'); await followFred();
      out = { ok: true, followDemo: 'done', note: 'watch: found you → glanced left → returned to you' }; break;
    case 'demo':
      console.log('nudge left…');  await nudge('left', 2);  await sleep(1500);
      console.log('nudge right…'); await nudge('right', 4); await sleep(1500);
      console.log('nudge up…');    await nudge('up', 1);    await sleep(1200);
      console.log('reset…');       await reset();           await sleep(1200);
      console.log('zoom in…');     await zoom({ level: 70 }); await sleep(1200);
      console.log('zoom out…');    await zoom({ level: 0 });
      out = { ok: true, demo: 'done' }; break;
    default:
      console.log('commands: aim|nudge|zoom|track|follow|preset|status|reset|demo|follow-demo  (see header)'); return;
  }
  console.log('\nresult:', JSON.stringify(out, null, 2));
  console.log('\n(If OSC is off in OBSBOT Center the send still "succeeds" — UDP is fire-and-forget.\n Watch the camera physically move to confirm the port/args are right.)');
})();
