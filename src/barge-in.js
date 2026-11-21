// BARGE-IN — Fred can cut Hannibal off mid-sentence just by talking.
//
// The mic tap (src/audio-tap.js) keeps running while Hannibal speaks. When the
// mic level jumps and stays up, that is a candidate. The slice goes to Whisper,
// and Hannibal stops only if what was heard is really Fred:
//   • it is NOT just his own voice coming back through the speakers (most of the
//     heard words appear in what he was saying), and
//   • it has his name, a stop word, or a few words of its own.
// The pure parts (level watcher, echo check, decision) are tested in node:
// src/test-barge-in.js.
(function (root) {
  'use strict';

  const STOP = /\b(?:stop|wait|hold on|enough|quiet|shut up|be quiet|never ?mind|ok(?:ay)? ok(?:ay)?|wacht(?: even)?|stop maar|genoeg|stil|laat maar|arr[eê]te|attends|tais[- ]toi|chut|para|espera|basta|c[aá]llate|vale vale)\b/i;

  const words = (t) => String(t || '').toLowerCase().normalize('NFC')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);

  // Share of the heard words that he was saying himself (0..1).
  function echoShare(heard, spoken) {
    const h = words(heard);
    if (!h.length) return 1;
    const said = new Set(words(Array.isArray(spoken) ? spoken.join(' ') : spoken));
    return h.filter((w) => said.has(w)).length / h.length;
  }

  // Should he stop talking? heard: Whisper text of the slice; spoken: his recent sentences.
  // → { barge, why, stopOnly }
  function decide(heard, spoken, { mentionsName } = {}) {
    const text = String(heard || '').trim();
    const w = words(text);
    if (!w.length) return { barge: false, why: 'nothing heard' };
    const echo = echoShare(text, spoken);
    if (echo >= 0.6) return { barge: false, why: `own voice (${Math.round(echo * 100)}%)` };
    const named = typeof mentionsName === 'function' && mentionsName(text);
    if (named) return { barge: true, why: 'name', stopOnly: false };
    if (STOP.test(text)) return { barge: true, why: 'stop word', stopOnly: w.length <= 3 };
    if (w.length >= 3 && echo < 0.35) return { barge: true, why: 'Fred talking', stopOnly: false };
    return { barge: false, why: 'too little' };
  }

  // Level watcher: feed it frames (RMS per ~50 ms). It reports 'onset' when the
  // level stays above the bar for onsetMs, then 'done' after quietMs of quiet or
  // maxMs of talking. The bar sits well above the room and his own echo.
  function createWatcher({ frameMs = 50, onsetMs = 250, quietMs = 450, maxMs = 3500, minBar = 0.02, factor = 3 } = {}) {
    let floor = 0, floorN = 0, loud = 0, quiet = 0, active = false, talkMs = 0;
    const bar = () => Math.max(minBar, floor * factor);
    return {
      get active() { return active; },
      get bar() { return bar(); },
      // Learn the level while nobody is talking over him (his echo + the room).
      learn(level) { floorN++; floor += (level - floor) / Math.min(floorN, 40); },
      reset() { loud = 0; quiet = 0; active = false; talkMs = 0; },
      push(level) {
        if (!active) {
          if (level > bar()) loud += frameMs; else { loud = 0; this.learn(level); }
          if (loud >= onsetMs) { active = true; talkMs = loud; quiet = 0; return 'onset'; }
          return null;
        }
        talkMs += frameMs;
        if (level > bar() * 0.6) quiet = 0; else quiet += frameMs;
        if (quiet >= quietMs) return 'done';
        if (talkMs >= maxMs) return 'long';
        return null;
      },
    };
  }

  function rms(samples) {
    let s = 0; for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
    return Math.sqrt(s / Math.max(1, samples.length));
  }

  const api = { decide, echoShare, createWatcher, rms, STOP };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BargeIn = api;
})(typeof window !== 'undefined' ? window : globalThis);
