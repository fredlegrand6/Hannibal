// VOICE IO (main side) — runs native/voice-io, Hannibal's mouth + ears on
// Apple's echo cancelling (see native/voice-io/VoiceIO.swift for why).
//
// IPC for the renderer:
//   vio:status → { ready }          vio:play (mp3 bytes) → resolves when heard
//   vio:stop                        vio:clip (ms) → WAV bytes of the last ms (16 kHz, echo removed)
//   'vio:level' events { mic, out } every 50 ms while he speaks; 'vio:ready'
// If the helper can't build or start, ready stays false and the renderer keeps
// playing through the page as before. HANNIBAL_VOICE_IO=0 turns it off.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'native', 'voice-io', 'VoiceIO.swift');
const BIN = path.join(ROOT, 'native', 'voice-io', 'voice-io');
const CLT = '/Library/Developer/CommandLineTools';

function log(...a) { try { console.log('[voice-io]', ...a); } catch (_) {} }

// Build once (and again when the source changes). Xcode's swiftc refuses to run
// until its licence is accepted, so fall back to the Command Line Tools.
function build() {
  return new Promise((resolve, reject) => {
    try { if (fs.existsSync(BIN) && fs.statSync(BIN).mtimeMs >= fs.statSync(SRC).mtimeMs) return resolve(); } catch (_) {}
    log('building the voice helper (one time)…');
    const target = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`;
    execFile('/usr/bin/swiftc', ['-O', SRC, '-o', BIN], { timeout: 240000 }, (e) => {
      if (!e) return resolve();
      execFile(`${CLT}/usr/bin/swiftc`, ['-O', '-sdk', `${CLT}/SDKs/MacOSX.sdk`, '-target', target, SRC, '-o', BIN],
        { timeout: 240000, env: { ...process.env, DEVELOPER_DIR: CLT } },
        (e2, _o, se) => (e2 ? reject(new Error(String(se || e2.message).split('\n')[0])) : resolve()));
    });
  });
}

function createVoiceIO({ send = () => {} } = {}) {
  let child = null, ready = false, seq = 0, wanted = false, failures = 0, restarting = false;
  const waiting = new Map();   // id → resolve
  let heardAt = 0;             // last time the helper reported his voice actually coming out

  function onLine(line) {
    let j; try { j = JSON.parse(line); } catch (_) { return; }
    if (j.ev === 'level') { if (j.out > 0.0005) heardAt = Date.now(); send('vio:level', { mic: j.mic, out: j.out }); return; }
    if (j.ev === 'engine') { log(j.on ? 'echo cancelling on (he is talking)' : 'echo cancelling off, mic handed back'); return; }
    if (j.ev === 'ready') { ready = true; failures = 0; log('ready (echo cancelling works here; it runs only while he talks)'); send('vio:ready', {}); return; }
    if (j.ev === 'done' || j.ev === 'clip') { const w = waiting.get(j.id); if (w) { waiting.delete(j.id); w(j); } return; }
    if (j.ev === 'error') { log('error:', j.error); if (j.id && waiting.has(j.id)) { const w = waiting.get(j.id); waiting.delete(j.id); w(j); } return; }
    if (j.ev === 'reconfigured') log('audio device changed — the helper drops this sentence and starts fresh on the new speakers');
    if (j.ev === 'info') log(j.error || `input ${j.in}, output ${j.out}`);
  }

  async function start() {
    wanted = true;
    if (child || process.platform !== 'darwin' || process.env.HANNIBAL_VOICE_IO === '0') return;
    try { await build(); } catch (e) { log('could not build — using the old playback:', e.message); return; }
    child = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    child.stderr.on('data', (d) => { const s = String(d).trim(); if (s) log(s.slice(0, 300)); });
    child.stdin.on('error', () => {});
    child.on('exit', (code) => {
      log('helper exited', code);
      child = null; ready = false; send('vio:ready', { ready: false });
      for (const [, w] of waiting) w({ ev: 'done', error: 'helper exited' });
      waiting.clear();
      // A restart we asked for (hung, woke from sleep) doesn't count as a failure.
      const asked = restarting; restarting = false;
      // Keep his voice on, but don't spin: after 3 quick failures stay on the old playback.
      if (!asked && code !== 0 && ++failures >= 3) { log('giving up for this session — he speaks through the page instead'); return; }
      if (wanted) setTimeout(start, asked ? 300 : 3000);
    });
  }

  function cmd(obj) { try { child && child.stdin.write(JSON.stringify(obj) + '\n'); } catch (_) {} }

  function request(obj, timeoutMs) {
    if (!child || !ready) return Promise.resolve({ ev: 'error', error: 'voice helper not ready' });
    const id = String(++seq);
    return new Promise((resolve) => {
      const t = setTimeout(() => { if (waiting.delete(id)) resolve({ ev: 'error', error: 'timeout' }); }, timeoutMs);
      waiting.set(id, (j) => { clearTimeout(t); resolve(j); });
      cmd({ ...obj, id });
    });
  }

  // Wait for the sentence's own length plus a margin, not two minutes: a hung
  // helper used to keep him "speaking" (deaf and silent) for that long.
  // Start watchdog: if none of his voice comes out within START_MS, the sentence
  // fails fast (the page plays it instead) and the helper is restarted fresh.
  const START_MS = Number(process.env.HANNIBAL_VIO_START_MS) || 4000;
  async function play(bytes, durationMs) {
    const f = path.join(os.tmpdir(), `hannibal-say-${process.pid}-${++seq}.mp3`);
    fs.writeFileSync(f, Buffer.from(bytes));
    const limit = durationMs > 0 ? Math.max(6000, durationMs + 4000) : 60000;
    const sent = Date.now();
    let watch = null;
    try {
      const silent = new Promise((resolve) => {
        watch = setInterval(() => {
          if (heardAt >= sent) { clearInterval(watch); watch = null; return; }
          if (Date.now() - sent >= START_MS) { clearInterval(watch); watch = null; resolve({ ev: 'error', error: `no sound started within ${START_MS} ms` }); }
        }, 250);
      });
      const j = await Promise.race([request({ cmd: 'play', path: f }, limit), silent]);
      if (j.error === 'timeout' || /no sound started/.test(j.error || '')) {
        log(`play ${j.error === 'timeout' ? `hung for ${limit} ms` : 'made no sound'} — restarting the helper`);
        restart(j.error);
      }
      return j;
    } finally { if (watch) clearInterval(watch); fs.unlink(f, () => {}); }
  }

  // Kill the helper and start it fresh (its audio engine follows the Mac's current speakers).
  function restart(why) {
    if (!child) return;
    log(`restarting the helper (${why})`);
    restarting = true;
    for (const [, w] of waiting) w({ ev: 'done', error: `helper restarted: ${why}` });
    waiting.clear();
    try { child.kill(); } catch (_) {}
  }
  function refresh(why) { if (child && !waiting.size) restart(why); }

  async function clip(ms) {
    const j = await request({ cmd: 'clip', ms: Math.round(ms) }, 5000);
    if (!j.path) return null;
    try { return fs.readFileSync(j.path); } finally { fs.unlink(j.path, () => {}); }
  }

  function stop() { cmd({ cmd: 'stop' }); }
  function warm() { if (ready) cmd({ cmd: 'warm' }); }
  function release() { if (ready) cmd({ cmd: 'release' }); }
  function quit() { wanted = false; cmd({ cmd: 'quit' }); setTimeout(() => { try { child && child.kill(); } catch (_) {} }, 500); }

  function register(ipcMain) {
    ipcMain.handle('vio:status', () => ({ ready }));
    ipcMain.handle('vio:play', async (_e, bytes, ms) => { const j = await play(bytes, ms); return { ok: !j.error, stopped: !!j.stopped, error: j.error }; });
    ipcMain.handle('vio:stop', () => { stop(); return { ok: true }; });
    ipcMain.handle('vio:warm', () => { warm(); return { ok: true }; });
    ipcMain.handle('vio:release', () => { release(); return { ok: true }; });
    ipcMain.handle('vio:clip', async (_e, ms) => clip(ms));
  }

  return { start, stop, warm, release, play, clip, quit, register, restart, refresh, get ready() { return ready; } };
}

module.exports = { createVoiceIO, build };
