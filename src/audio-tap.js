// AUDIO TAP — the mic never blinks, and the first word is never lost.
//
// Before: every listening turn opened the mic, recorded, closed it, and in
// always-listen mode reopened it every 20 s of silence. Anything said in that
// gap (or while the mic was warming up) was cut, so "Hannibal, ..." often
// reached Whisper as "...nibal" or not at all.
//
// Now: one mic stream stays open and its sound runs into a rolling buffer
// (the last ~40 s). A turn is just a slice of that buffer, starting a little
// BEFORE the turn opened (pre-roll), sent to Whisper as a 16 kHz WAV.
//
// The ring/WAV parts are plain functions (tested in node: src/test-audio-tap.js);
// attach() wires them to a live MediaStream in the browser.
(function (root) {
  'use strict';

  function createRing(sampleRate, seconds) {
    const size = Math.max(1, Math.floor(sampleRate * seconds));
    const buf = new Float32Array(size);
    let total = 0;           // samples ever written (a running clock)
    let lastWriteAt = 0;
    return {
      sampleRate,
      get total() { return total; },
      get lastWriteAt() { return lastWriteAt; },
      write(samples, now) {
        for (let i = 0; i < samples.length; i++) buf[(total + i) % size] = samples[i];
        total += samples.length;
        lastWriteAt = now || Date.now();
      },
      // Samples from position `from` (clamped to what is still in the ring) up to `to`.
      read(from, to = total) {
        const start = Math.max(from, total - size, 0);
        const end = Math.min(to, total);
        const out = new Float32Array(Math.max(0, end - start));
        for (let i = 0; i < out.length; i++) out[i] = buf[(start + i) % size];
        return out;
      },
    };
  }

  // Simple averaging downsampler (48 kHz → 16 kHz is an exact 3:1).
  function downsample(samples, fromRate, toRate) {
    if (toRate >= fromRate) return samples;
    const ratio = fromRate / toRate;
    const out = new Float32Array(Math.floor(samples.length / ratio));
    for (let i = 0; i < out.length; i++) {
      const a = Math.floor(i * ratio), b = Math.min(samples.length, Math.floor((i + 1) * ratio));
      let s = 0; for (let j = a; j < b; j++) s += samples[j];
      out[i] = s / Math.max(1, b - a);
    }
    return out;
  }

  // 16-bit mono PCM WAV bytes.
  function encodeWav(samples, rate) {
    const bytes = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(bytes);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Uint8Array(bytes);
  }

  // Browser: tap a live MediaStream. Returns null if the audio graph can't run.
  function attach(audioCtx, stream, { seconds = 40 } = {}) {
    try {
      const ring = createRing(audioCtx.sampleRate, seconds);
      const src = audioCtx.createMediaStreamSource(stream);
      const proc = audioCtx.createScriptProcessor(4096, 1, 1);
      const mute = audioCtx.createGain(); mute.gain.value = 0;   // must reach the destination to run, silently
      proc.onaudioprocess = (e) => ring.write(e.inputBuffer.getChannelData(0), Date.now());
      src.connect(proc); proc.connect(mute); mute.connect(audioCtx.destination);
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      return {
        stream, source: src, ring,
        // Is sound actually flowing (the context may be suspended)?
        alive(now = Date.now()) { return ring.total > 0 && now - ring.lastWriteAt < 1500; },
        mark() { return ring.total; },
        // WAV of [mark - prerollSec, now] (never before `floor`), 16 kHz.
        wav(mark, prerollSec = 0.8, floor = 0) {
          const from = Math.max(floor, mark - Math.floor(prerollSec * ring.sampleRate));
          return encodeWav(downsample(ring.read(from), ring.sampleRate, 16000), 16000);
        },
        close() {
          try { proc.disconnect(); src.disconnect(); mute.disconnect(); } catch (_) {}
          proc.onaudioprocess = null;
        },
      };
    } catch (e) {
      console.warn('[voice] audio tap unavailable — using the recorder', e);
      return null;
    }
  }

  const api = { createRing, downsample, encodeWav, attach };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AudioTap = api;
})(typeof window !== 'undefined' ? window : globalThis);
