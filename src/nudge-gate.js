// ─────────────────────────────────────────────────────────────────────────
// NUDGE GATE: may Hannibal bring something up right now?
//
// Fred's rules (22 Nov 2026):
//   • never while Fred is talking, while Hannibal is speaking or thinking, or
//     while a tool call or a yes/no question is open;
//   • a normal nudge only once the room has been quiet for idleMs (default
//     25 s, HANNIBAL_NUDGE_IDLE_S): no speech from Fred (to Hannibal or to
//     anyone else) and none from Hannibal;
//   • after "stay quiet" / "we're busy" (quiet mode), nothing until Fred
//     speaks to Hannibal again;
//   • an urgent one (a reminder due now, a meeting in under 5 minutes) skips
//     the idle wait and quiet mode, but still waits for Fred to finish his
//     sentence and for any yes/no question to be answered.
// Pure functions, so the rules are tested without the app.
// ─────────────────────────────────────────────────────────────────────────
(function (root) {
  'use strict';

  // "Stay quiet", "we're busy", "not now" in his four languages. These put
  // nudges on hold; they don't mute his answers.
  const QUIET = /\b(stay quiet|keep quiet|be quiet for a (?:bit|while|moment)|quiet for (?:a )?(?:bit|while|now)|we'?re busy|we are busy|i'?m busy|i am busy|not now|later hannibal|i'?m in a meeting|i'?m on a call|give (?:me|us) a (?:minute|moment|bit)|don'?t disturb|do not disturb|blijf stil|wees even stil|even stil|we zijn bezig|ik ben bezig|niet nu|niet storen|reste tranquille|tais-toi un peu|on est occupés?|je suis occupée?|pas maintenant|ne dérange pas|estamos ocupados|estoy ocupad[oa]|ahora no|no molestes|silencio un momento)\b/i;

  const isQuietRequest = (text) => QUIET.test(String(text || '').toLowerCase());

  // s: { now, urgent, idleMs, lastHeardAt, lastSpokeAt, fredTalking,
  //      hannibalBusy, confirmPending, quietMode }
  // -> { ok, why }
  function canDeliver(s) {
    if (s.fredTalking) return { ok: false, why: 'Fred is talking' };
    if (s.confirmPending) return { ok: false, why: 'a yes/no question is open' };
    if (s.hannibalBusy) return { ok: false, why: 'Hannibal is speaking or working' };
    if (s.urgent) return { ok: true, why: 'urgent' };
    if (s.quietMode) return { ok: false, why: 'Fred asked for quiet' };
    const idleMs = Number(s.idleMs) > 0 ? Number(s.idleMs) : 25000;
    const since = s.now - Math.max(s.lastHeardAt || 0, s.lastSpokeAt || 0);
    if (since < idleMs) return { ok: false, why: `only ${Math.round(since / 1000)}s quiet` };
    return { ok: true, why: `${Math.round(since / 1000)}s quiet` };
  }

  const api = { canDeliver, isQuietRequest };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NudgeGate = api;
})(typeof window !== 'undefined' ? window : globalThis);
