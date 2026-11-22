// VOICE PLAYER — Hannibal's voice must never go quiet until a restart.
//
// What went wrong (22 Nov 2026): every sentence waited for the audio's "ended"
// event, with no time limit. When the Mac slept, or a speaker came or went
// (Philips monitor asleep, USB-C audio), the page's AudioContext stopped
// running, "ended" never came, and his whole voice queue sat behind that one
// sentence. Text kept coming; sound only came back after a restart, because
// only a restart made a fresh AudioContext.
//
// This module holds the parts that make playback safe, so they can be tested
// in node with fakes (src/test-voice-player.js):
//   • createAudioOut — owns the output AudioContext: resumes it with a time
//     limit, rebuilds it when it is stuck, closed, or the speakers changed
//     (devicechange) or the Mac woke up. A new AudioContext follows the Mac's
//     current output device.
//   • playBuffer     — plays one clip with a start watchdog (no sound within a
//     few seconds = a dropout) and a duration-based time limit. Stop works
//     instantly even when the audio output is dead.
//   • createSpeaker  — one sentence, stage by stage (tts → decode → play), each
//     with a time limit. A failure is logged with its stage, recovered
//     (rebuild the output) and retried once; then the sentence is skipped.
//   • runQueue       — plays sentences in order; one bad sentence can never
//     hold up the ones after it.
(function (root) {
  'use strict';

  class VoiceDrop extends Error {
    constructor(stage, message) { super(message); this.stage = stage; this.name = 'VoiceDrop'; }
  }

  const realTimers = {
    now: () => Date.now(),
    setTimeout: (f, ms) => setTimeout(f, ms),
    clearTimeout: (t) => clearTimeout(t),
    setInterval: (f, ms) => setInterval(f, ms),
    clearInterval: (t) => clearInterval(t),
  };

  // How long one clip may take: its own length plus a margin, never forever.
  const HARD_CAP_MS = 90000;
  function clipLimitMs(durationMs) {
    const d = Number(durationMs);
    if (!(d > 0)) return 30000;
    return Math.min(HARD_CAP_MS, Math.round(d + Math.max(2500, d * 0.25)));
  }

  function withTimeout(promise, ms, stage, what, timers = realTimers) {
    let t;
    return new Promise((resolve, reject) => {
      t = timers.setTimeout(() => reject(new VoiceDrop(stage, `${what || stage} took longer than ${ms} ms`)), ms);
      Promise.resolve(promise).then(
        (v) => { timers.clearTimeout(t); resolve(v); },
        (e) => { timers.clearTimeout(t); reject(e instanceof VoiceDrop ? e : new VoiceDrop(stage, (e && e.message) || String(e))); });
    });
  }

  // ── the output AudioContext ──────────────────────────────────────────────
  function createAudioOut({ makeContext, mediaDevices = null, log = () => {}, resumeMs = 1500, timers = realTimers, onDeviceChange = () => {} } = {}) {
    let ctx = null, dirty = '', deviceLabel = '', builds = 0;

    function build(why) {
      const old = ctx; ctx = null;
      if (old) { try { const p = old.close(); if (p && p.catch) p.catch(() => {}); } catch (_) {} }
      ctx = makeContext();
      builds++; dirty = '';
      if (why) log(`audio output rebuilt (${why}) → ${deviceLabel || 'default output'}`);
      const mine = ctx;
      try { mine.onstatechange = () => { if (ctx === mine && mine.state !== 'running') log(`audio output is ${mine.state}`); }; } catch (_) {}
      return ctx;
    }

    async function resume(c) {
      if (c.state === 'running') return true;
      try { await withTimeout(c.resume(), resumeMs, 'play', 'resuming the audio output', timers); } catch (_) {}
      return c.state === 'running';
    }

    // A running output, or the best we could do (the start watchdog catches the rest).
    async function ensure() {
      if (!ctx) build('');
      else if (ctx.state === 'closed') build('it was closed');
      else if (dirty) build(dirty);
      if (await resume(ctx)) return ctx;
      build(`it was stuck "${ctx.state}"`);
      await resume(ctx);
      return ctx;
    }

    async function refreshDevice() {
      if (!mediaDevices || !mediaDevices.enumerateDevices) return deviceLabel;
      try {
        const outs = (await mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
        const d = outs.find((o) => o.deviceId === 'default') || outs[0];
        deviceLabel = d ? String(d.label || '').replace(/^Default - /, '') : '';
      } catch (_) {}
      return deviceLabel;
    }

    function deviceChanged() {
      dirty = 'speakers changed';
      refreshDevice().then((l) => { log(`speakers changed → ${l || 'unknown'}`); try { onDeviceChange(l); } catch (_) {} });
    }
    if (mediaDevices && mediaDevices.addEventListener) mediaDevices.addEventListener('devicechange', deviceChanged);
    refreshDevice();

    return {
      ensure,
      current: () => (ctx && ctx.state !== 'closed' ? ctx : build('')),   // for decoding (works on a suspended context)
      rebuild: (why) => build(why || 'asked'),
      markDirty: (why) => { dirty = why || 'asked'; },
      deviceChanged,
      device: () => deviceLabel || 'default output',
      get builds() { return builds; },
    };
  }

  // ── one clip on a context ─────────────────────────────────────────────────
  // → { promise (resolves {ok} or {stopped}, rejects VoiceDrop), stop() }
  function playBuffer(ctx, audioBuf, { limitMs = 0, startMs = 2500, tickMs = 200, connect = null, timers = realTimers } = {}) {
    let stopFn = () => {};
    const promise = new Promise((resolve, reject) => {
      let done = false, iv = null, cleanup = () => {};
      const src = ctx.createBufferSource();
      src.buffer = audioBuf;
      const finish = (err, res) => {
        if (done) return; done = true;
        if (iv !== null) timers.clearInterval(iv);
        try { src.onended = null; } catch (_) {}
        if (err || (res && res.stopped)) { try { src.stop(); } catch (_) {} }
        try { cleanup(); } catch (_) {}
        if (err) reject(err); else resolve(res);
      };
      src.onended = () => finish(null, { ok: true });
      stopFn = () => finish(null, { ok: false, stopped: true });
      try {
        cleanup = (connect ? connect(src, ctx) : (src.connect(ctx.destination), null)) || (() => {});
        src.start();
      } catch (e) { finish(new VoiceDrop('play', `could not start the clip: ${e.message}`)); return; }
      const t0 = timers.now(), c0 = ctx.currentTime;
      const limit = limitMs || clipLimitMs((audioBuf.duration || 0) * 1000);
      let started = false;
      iv = timers.setInterval(() => {
        const el = timers.now() - t0;
        if (!started && ctx.currentTime > c0 + 0.02) started = true;
        if (!started && el >= startMs) finish(new VoiceDrop('play', `no sound started within ${el} ms (audio output "${ctx.state}")`));
        else if (el >= limit) finish(new VoiceDrop('play', `clip never finished (${el} ms, limit ${limit} ms)`));
      }, tickMs);
    });
    return { promise, stop: () => stopFn() };
  }

  // ── one sentence, stage by stage ──────────────────────────────────────────
  // tts(text) → bytes · decode(bytes) → AudioBuffer · playVio(bytes, ms) → {ok|stopped|error,retryable}
  // (used while useVio() says the helper is on)
  // playPage(audioBuf) → playBuffer handle · recover(why) → rebuilds the output
  // onDrop({ stage, error, recovered, path, text }) — one entry per failure
  function createSpeaker({ tts, decode, playVio = null, useVio = () => !!playVio, playPage, recover = async () => {}, onDrop = () => {}, ttsMs = 45000, decodeMs = 8000, timers = realTimers } = {}) {
    let current = null, stopped = 0;

    async function speak(text, { prefetched = null, isCurrent = () => true } = {}) {
      const myStop = stopped;
      const cut = () => myStop !== stopped || !isCurrent();
      const said = String(text || '').slice(0, 80);
      const drop = (stage, e, recovered, path = 'page') => { try { onDrop({ stage, error: (e && e.message) || String(e), recovered, path, text: said }); } catch (_) {} };

      // 1. TTS request
      let bytes = null, ttsErr = null;
      for (let attempt = 0; attempt < 2 && !bytes; attempt++) {
        try {
          const b = await withTimeout(attempt === 0 && prefetched ? prefetched : tts(text), ttsMs, 'tts', 'the voice request', timers);
          if (!b || !b.byteLength) throw new VoiceDrop('tts', 'no audio came back');
          bytes = b;
        } catch (e) {
          if (cut()) return { stopped: true };
          if (!ttsErr) ttsErr = e;
          if (/longer than/.test(e.message)) break;   // already waited long enough: skip
        }
      }
      if (cut()) return { stopped: true };
      if (ttsErr) drop('tts', ttsErr, !!bytes);
      if (!bytes) return { dropped: 'tts' };

      // 2. decode
      let audioBuf = null;
      for (let attempt = 0; attempt < 2 && !audioBuf; attempt++) {
        try {
          const ab = bytes.buffer ? bytes.buffer.slice(bytes.byteOffset || 0, (bytes.byteOffset || 0) + bytes.byteLength) : bytes;
          audioBuf = await withTimeout(decode(ab), decodeMs, 'decode', 'decoding the voice', timers);
        } catch (e) {
          if (attempt === 0) { await recover('decode failed'); continue; }
          drop('decode', e, false); return { dropped: 'decode' };
        }
      }
      if (cut()) return { stopped: true };
      const ms = Math.round((audioBuf.duration || 0) * 1000);

      // 3a. the echo-cancelling helper (desk only); a device change gets one more go there
      if (playVio && useVio()) {
        let r = await playVio(bytes, ms);
        if (r && r.retryable && !r.ok && !r.stopped && !cut()) r = await playVio(bytes, ms);
        if (r && (r.ok || r.stopped)) return r.ok ? { ok: true, path: 'helper' } : { stopped: true };
        if (cut()) return { stopped: true };
        drop('play', new Error((r && r.error) || 'no answer from the voice helper'), true, 'helper');   // the page plays it instead
      }

      // 3b. the page, with one recovery + retry
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (cut()) return { stopped: true };
        let h;
        try {
          h = await playPage(audioBuf);
          current = h;
          const r = await h.promise;
          if (r && r.stopped) return { stopped: true };
          if (lastErr) drop(lastErr.stage || 'play', lastErr, true);
          return { ok: true, path: 'page' };
        } catch (e) {
          if (cut()) return { stopped: true };
          lastErr = e;
          if (attempt === 0) await recover(e.message);
        } finally { if (current === h) current = null; }
      }
      drop(lastErr.stage || 'play', lastErr, false);
      await recover('a sentence was skipped');   // the next sentence starts on a fresh output
      return { dropped: lastErr.stage || 'play' };
    }

    // "Hannibal stop": cut the sound now, and the sentence in flight gives up.
    function stop() { stopped++; if (current) { try { current.stop(); } catch (_) {} current = null; } }

    return { speak, stop, get playing() { return !!current; } };
  }

  // ── the sentence queue ────────────────────────────────────────────────────
  // next() → item | undefined · more() → may more items still come
  // A sentence that somehow exceeds itemCapMs is abandoned (stage "queue") so
  // the queue never stays locked; waiting for more text is capped by idleCapMs.
  async function runQueue({ next, more, speak, isCurrent = () => true, onDrop = () => {}, onAbandon = () => {}, itemCapMs = 150000, idleCapMs = 120000, pollMs = 40, timers = realTimers }) {
    let idleSince = timers.now(), played = 0, dropped = 0;
    const sleep = (ms) => new Promise((r) => timers.setTimeout(r, ms));
    while (isCurrent()) {
      const item = next();
      if (!item) {
        if (!more()) break;
        if (timers.now() - idleSince > idleCapMs) { try { onDrop({ stage: 'queue', error: `waited ${idleCapMs} ms for the rest of the reply`, recovered: false }); } catch (_) {} break; }
        await sleep(pollMs); continue;
      }
      try {
        const r = await withTimeout(speak(item), itemCapMs, 'queue', 'one sentence', timers);
        if (r && r.dropped) dropped++; else if (r && r.ok) played++;
      } catch (e) {
        dropped++;
        try { onAbandon(); } catch (_) {}
        try { onDrop({ stage: 'queue', error: e.message, recovered: false, text: String((item && item.text) || '').slice(0, 80) }); } catch (_) {}
      }
      idleSince = timers.now();
    }
    return { played, dropped };
  }

  const api = { VoiceDrop, clipLimitMs, withTimeout, createAudioOut, playBuffer, createSpeaker, runQueue, HARD_CAP_MS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VoicePlayer = api;
})(typeof window !== 'undefined' ? window : globalThis);
