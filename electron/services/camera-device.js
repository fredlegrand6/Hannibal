// ─────────────────────────────────────────────────────────────────────────
// CAMERA DEVICE — which camera Hannibal looks through.
//
// macOS numbers cameras in the order they appear, and that order changes (an
// iPhone nearby adds "Continuity Camera" entries), so a fixed number like 0
// often lands on the MacBook's own camera instead of the OBSBOT. We pick the
// camera by NAME instead:
//   HANNIBAL_CAMERA = part of the camera's name (default "OBSBOT"), or a number;
//   if no camera matches, fall back to HANNIBAL_CAMERA_INDEX (default 0).
// The list is read with `ffmpeg -f avfoundation -list_devices true -i ""` and
// cached; call resolve({ fresh: true }) after a failed capture to re-check.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const { spawn } = require('child_process');

// ffmpeg's device list → [{ index, name }] for VIDEO devices only.
function parseVideoDevices(text) {
  const out = [];
  let inVideo = false;
  for (const line of String(text || '').split(/\r?\n|(?=\[AVFoundation)/)) {
    if (/AVFoundation video devices/i.test(line)) { inVideo = true; continue; }
    if (/AVFoundation audio devices/i.test(line)) { inVideo = false; continue; }
    if (!inVideo) continue;
    const m = /\]\s*\[(\d+)\]\s*(.+?)\s*$/.exec(line);
    if (m) out.push({ index: Number(m[1]), name: m[2] });
  }
  return out;
}

// Pick the ffmpeg input for the wanted camera: its exact name, or the index.
function pickCamera(devices, { want = 'OBSBOT', fallbackIndex = '0' } = {}) {
  const w = String(want || '').trim();
  if (/^\d+$/.test(w)) return w;
  if (w) {
    const hit = devices.find((d) => d.name.toLowerCase().includes(w.toLowerCase())
      && !/capture screen/i.test(d.name));
    if (hit) return hit.name;
  }
  return String(fallbackIndex);
}

function listDevices(ffmpeg) {
  return new Promise((resolve) => {
    let text = '';
    let p;
    try { p = spawn(ffmpeg, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']); }
    catch (_) { resolve([]); return; }
    p.stderr.on('data', (d) => { text += d; });
    p.stdout.on('data', (d) => { text += d; });
    p.on('error', () => resolve([]));
    p.on('close', () => resolve(parseVideoDevices(text)));
    setTimeout(() => { try { p.kill(); } catch (_) {} }, 8000);
  });
}

function createCameraPicker({ ffmpeg, want = process.env.HANNIBAL_CAMERA || 'OBSBOT',
  fallbackIndex = process.env.HANNIBAL_CAMERA_INDEX || '0', list = listDevices, log = console.log } = {}) {
  let cached = null;
  async function resolve({ fresh = false } = {}) {
    if (cached && !fresh) return cached;
    const devices = await list(ffmpeg);
    const chosen = pickCamera(devices, { want, fallbackIndex });
    if (chosen !== cached) log(`[vision] camera: ${/^\d+$/.test(chosen) ? `#${chosen}` : chosen}`);
    cached = chosen;
    return cached;
  }
  return { resolve };
}

module.exports = { parseVideoDevices, pickCamera, createCameraPicker };
