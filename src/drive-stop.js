// DRIVE STOP — "Hannibal stop" while Hannibal is operating the Mac.
//
// While the hands are busy (computer.* tools), the open mic is watched the same
// way barge-in watches it: a burst of speech is cut out of the audio tap and
// sent to Whisper. If what was heard is a stop, everything stops at once
// (main: computer:stop → the action is cut, Claude's turn is interrupted).
//
//   stop   = his name + a stop word ("Hannibal stop", "Hannibal, wacht", "arrête Hannibal"),
//            or ONLY stop words ("stop", "stop stop", "halt") — while he drives,
//            a bare "stop" from Fred can mean nothing else.
//   not    = anything else (Fred on a call, music, "stop the music" said to someone).
//
// Pure decision, tested in node: src/test-drive-stop.js.
(function (root) {
  'use strict';

  const STOP_WORDS = /\b(?:stop+(?:pen)?|halt|wait|hold on|hold it|enough|cancel|abort|freeze|wacht(?: even)?|genoeg|ophouden|arr[eê]te(?:z)?|stoppe|attends|para(?:r)?|espera|basta|alto)\b/i;
  const FILLER = /\b(?:hannibal|hey|ok(?:ay)?|now|nu|please|alsjeblieft|svp|por favor|right now|meteen|tout de suite|ya|it|that|dat|het|it now)\b/gi;

  const words = (t) => String(t || '').toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);

  // heard: Whisper text. mentionsName: NameGate.mentionsName (optional).
  // → { stop: bool, why }
  function decide(heard, { mentionsName } = {}) {
    const text = String(heard || '').trim();
    const w = words(text);
    if (!w.length) return { stop: false, why: 'nothing heard' };
    if (!STOP_WORDS.test(text)) return { stop: false, why: 'no stop word' };
    const named = typeof mentionsName === 'function' ? mentionsName(text) : /\bh?an+[aie]b[aeiou]?l+e?\b/i.test(text);
    if (named && w.length <= 7) return { stop: true, why: 'name + stop word' };
    // Only stop words (and fillers) left?
    const rest = words(text.replace(new RegExp(STOP_WORDS.source, 'gi'), ' ').replace(FILLER, ' '));
    if (!rest.length && w.length <= 4) return { stop: true, why: 'stop word on its own' };
    return { stop: false, why: 'stop word inside other talk' };
  }

  const api = { decide, STOP_WORDS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DriveStop = api;
})(typeof window !== 'undefined' ? window : globalThis);
