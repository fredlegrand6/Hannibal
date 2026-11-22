// Runs native/hands (Swift): keyboard, mouse, accessibility, OCR, Esc watch.
// One JSON command per line in, one JSON answer per line out (see Hands.swift).
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'native', 'hands', 'Hands.swift');
const BIN = path.join(ROOT, 'native', 'hands', 'hands');
const CLT = '/Library/Developer/CommandLineTools';
const log = (...a) => { try { console.log('[hands]', ...a); } catch (_) {} };

// Build once, and again when the source changes (same fallback as voice-io).
function build() {
  return new Promise((resolve, reject) => {
    try { if (fs.existsSync(BIN) && fs.statSync(BIN).mtimeMs >= fs.statSync(SRC).mtimeMs) return resolve(); } catch (_) {}
    log('building the hands helper (one time)…');
    const target = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`;
    execFile('/usr/bin/swiftc', ['-O', SRC, '-o', BIN], { timeout: 240000 }, (e) => {
      if (!e) return resolve();
      execFile(`${CLT}/usr/bin/swiftc`, ['-O', '-sdk', `${CLT}/SDKs/MacOSX.sdk`, '-target', target, SRC, '-o', BIN],
        { timeout: 240000, env: { ...process.env, DEVELOPER_DIR: CLT } },
        (e2, _o, se) => (e2 ? reject(new Error(String(se || e2.message).split('\n')[0])) : resolve()));
    });
  });
}

function createHands({ onEvent = () => {} } = {}) {
  let child = null, ready = null, seq = 0;
  const waiting = new Map();

  function onLine(line) {
    let j; try { j = JSON.parse(line); } catch (_) { return; }
    if (j.ev) { onEvent(j); return; }
    const w = waiting.get(j.id);
    if (w) { waiting.delete(j.id); w(j); }
  }

  function start() {
    if (ready) return ready;
    ready = (async () => {
      if (process.platform !== 'darwin') throw new Error('computer control only works on the Mac');
      await build();
      child = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      let buf = '';
      const up = new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('hands helper did not start')), 8000);
        onEvent.__ready = () => { clearTimeout(t); res(); };
      });
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (line.includes('"ev":"ready"') && onEvent.__ready) { onEvent.__ready(); onEvent.__ready = null; continue; }
          onLine(line);
        }
      });
      child.stderr.on('data', (d) => { const s = String(d).trim(); if (s) log(s.slice(0, 300)); });
      child.stdin.on('error', () => {});
      child.on('exit', (code) => {
        log('helper exited', code);
        child = null; ready = null;
        for (const [, w] of waiting) w({ error: 'hands helper exited' });
        waiting.clear();
      });
      await up;
      return true;
    })();
    ready.catch(() => { ready = null; });
    return ready;
  }

  async function call(cmd, args = {}, timeoutMs = 10000) {
    await start();
    const id = ++seq;
    return new Promise((resolve) => {
      const t = setTimeout(() => { if (waiting.delete(id)) resolve({ error: `hands ${cmd} timed out` }); }, timeoutMs);
      waiting.set(id, (j) => { clearTimeout(t); resolve(j); });
      try { child.stdin.write(JSON.stringify({ ...args, cmd, id }) + '\n'); }
      catch (e) { clearTimeout(t); waiting.delete(id); resolve({ error: e.message }); }
    });
  }
  // Cuts in ahead of queued work (the helper reads it on its own thread).
  function stopTyping() { try { child && child.stdin.write(JSON.stringify({ cmd: 'stopTyping', id: 0 }) + '\n'); } catch (_) {} }
  function quit() { try { child && child.stdin.write('{"cmd":"quit"}\n'); } catch (_) {} }

  return { start, call, stopTyping, quit, get running() { return !!child; } };
}

module.exports = { createHands, build, BIN, SRC };
