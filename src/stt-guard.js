// ─────────────────────────────────────────────────────────────────────────
// STT GUARD — ask, don't guess.
//
// The speech server sends a confidence (high / medium / low) with every
// transcript (electron/services/stt-filter.js). This decides what Hannibal
// does with an unsure line:
//   • a clear line runs exactly as before;
//   • an unsure harmless command (play, pause, volume, next...) still runs,
//     but he says what he understood: 'I heard "volume up". Volume up.';
//   • an unsure command that is not harmless (quit an app, lock the Mac...)
//     does not run: he says what he heard and asks for it again;
//   • an unsure or very short line never sets Fred's mood, and the brain gets
//     a note telling it to say what it heard and ask once, neutrally;
//   • a send / delete / book that follows an unsure line is stated back
//     before the yes/no question.
// Plain functions, no DOM: node src/test-stt-guard.js
// ─────────────────────────────────────────────────────────────────────────
(function (root) {
  'use strict';

  const UNSURE_MS = 3 * 60 * 1000;    // an unsure line still colours a write asked within this time

  const words = (t) => String(t || '').trim().split(/\s+/).filter(Boolean);
  const isFragment = (t) => words(t).length <= 4;   // "Mm", "No, there's no way"
  const isLow = (c) => c === 'low';

  // Instant commands that are fine to run on a hunch: media, volume, brightness,
  // and read-only questions. Everything else waits for a clear line.
  const HARMLESS = /^(?:spotify-(?:play|pause|next|prev|current)|volume-(?:up|down|set|mute|unmute)|brightness-(?:up|down)|battery|uptime|disk-space|ip-address|wifi-status|list-apps|clipboard-get|desktop-files|downloads-files)$/;
  function isHarmless(cmd) {
    return !!(cmd && cmd.kind === 'mac' && HARMLESS.test(String(cmd.action || '')));
  }

  const quote = (t) => `"${String(t || '').trim().replace(/[.?!]+$/, '')}"`;

  // What to do with an instant command, given how sure the ears were.
  // → { run: true, reply } or { run: false, say }
  function commandPlan(cmd, transcript, confidence) {
    const reply = cmd && cmd.reply ? cmd.reply : 'Done.';
    if (!isLow(confidence)) return { run: true, reply };
    if (isHarmless(cmd)) return { run: true, reply: `I heard ${quote(transcript)}. ${reply}` };
    return { run: false, say: `I heard ${quote(transcript)}, but I'm not sure I got that right. Say it again if you want me to do it.` };
  }

  // Mood is read from Fred's words; a garbled or tiny line says nothing about it.
  function shouldReadMood(transcript, confidence) {
    return !isLow(confidence) && !isFragment(transcript);
  }

  // The note the brain gets with this turn.
  function brainNote({ text, confidence, prevLine, lastTask } = {}) {
    if (!confidence) return '';
    const low = isLow(confidence);
    const frag = isFragment(text);
    let note = `\nSPEECH-TO-TEXT: confidence ${confidence}.`;
    if (low || frag) {
      note += ` Heard exactly: ${quote(text)}.`;
      if (low) note += ' The ears were NOT sure: this may be misheard.';
      if (frag) note += ' It is a short fragment.';
      if (prevLine) note += ` Fred's previous line: ${quote(prevLine)}.`;
      if (lastTask) note += ` Last thing you did for him: ${String(lastTask).replace(/_/g, ' ')}.`;
      note += ' If it does not clearly make sense, say what you heard and ask once, briefly' +
        ' (e.g. "I heard \'pleasure day\', did you mean press play?"). Do not read a mood or feeling into it.';
    }
    return note;
  }

  // Before a send / delete / book: if the line that led here was unsure, say it back first.
  function writeEcho(lastHeard, now = Date.now()) {
    if (!lastHeard || !isLow(lastHeard.confidence) || !lastHeard.at || now - lastHeard.at > UNSURE_MS) return '';
    return `I want to be sure I heard you right. I heard ${quote(lastHeard.text)}.`;
  }

  // Store this turn in long-term memory? Not when the ears were unsure.
  const shouldRemember = (confidence) => !isLow(confidence);

  const api = { isFragment, isHarmless, commandPlan, shouldReadMood, brainNote, writeEcho, shouldRemember, UNSURE_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SttGuard = api;
})(typeof window !== 'undefined' ? window : globalThis);
