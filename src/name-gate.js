// ─────────────────────────────────────────────────────────────────────────
// NAME GATE — "Hannibal" is the wake word.
//
// With always-listen on, Hannibal hears everything in the room (calls, music,
// people talking) and used to answer all of it. Now, outside a conversation he
// only answers when he hears his name. Whisper already transcribes every
// utterance, so his name works as the wake word with no extra model.
//
// He answers without the name when:
//   • he spoke or answered in the last FOLLOW_UP_MS (a conversation is going),
//   • a question of his is pending (yes/no confirm, teach mode, "did you mean"),
//   • the "hey Jarvis" wake word just fired.
// HANNIBAL_NAME_GATE=0 turns the gate off (answers everything, as before).
// ─────────────────────────────────────────────────────────────────────────
(function (root) {
  'use strict';

  // Whisper's usual spellings of "Hannibal" (and the near-misses it makes).
  // On a quiet morning voice it also writes "Annable." (seen live 2026-11-22),
  // so the first pattern takes any h?an(n)[aie]b…l(e) spelling.
  // At the very start of an utterance it also hears "Hannibal" as
  // "They handle ..." / "The handle ..." (seen live 2026-11-20).
  const NAME = /(?:^[\s,.!?:-]*(?:(?:hey|hi|ok|okay|yo)[\s,]+)?(?:they|the)\s+handle\b[\s,.!?:]*|\b(?:hey|hi|ok|okay|yo)?[\s,]*(?:h?an{1,2}[aie]b[aeiuo]?l{1,2}e?|hannibal|hanibal|hannible|hanniball|hannibel|anibal|aníbal|haníbal|annibal|hannabal|hannibul|hannable|honnibal|hanni\s?ball?|hand[iy]\s?ball?|hanna\s?b[ae]ll?)\b[\s,.!?:]*)/i;

  function mentionsName(text) { return NAME.test(String(text || '')); }

  // The request without the name ("Hannibal, open Spotify" → "open Spotify").
  function stripName(text) {
    const t = String(text || '');
    const out = t.replace(NAME, ' ').replace(/\s{2,}/g, ' ').replace(/^[\s,.!?:]+/, '').trim();
    return out;
  }

  // Should Hannibal answer this utterance?
  //   ctx: { now, lastSpokeAt, wokeAt, pending, followUpMs, enabled }
  // → { answer: bool, text: string, why: string }
  function decide(text, ctx = {}) {
    const now = ctx.now || Date.now();
    const followUpMs = ctx.followUpMs || 20000;
    if (ctx.enabled === false) return { answer: true, text, why: 'gate off' };
    if (mentionsName(text)) {
      const rest = stripName(text);
      return { answer: true, text: rest || text, why: 'name', nameOnly: !rest };
    }
    if (ctx.pending) return { answer: true, text, why: 'waiting for an answer' };
    if (ctx.wokeAt && now - ctx.wokeAt < followUpMs) return { answer: true, text, why: 'wake word' };
    if (ctx.lastSpokeAt && now - ctx.lastSpokeAt < followUpMs) return { answer: true, text, why: 'conversation' };
    return { answer: false, text, why: 'not addressed' };
  }

  const api = { mentionsName, stripName, decide, NAME };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NameGate = api;
})(typeof window !== 'undefined' ? window : globalThis);
