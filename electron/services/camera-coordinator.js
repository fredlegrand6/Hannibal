// ─────────────────────────────────────────────────────────────────────────
// CAMERA COORDINATOR — HANDS-OFF guard (single owner of the gimbal).
//
// WHY HANDS-OFF (live-established on the OBSBOT Tiny 3, 2026-07-04):
//   • OSC can move the gimbal (General/SetGimbal*), but the AI-tracking commands
//     (/Tiny/SetAiMode, SetTrackingMode, ToggleAILock…) are "unknown path" on the
//     Tiny 3 — silently dropped. So we cannot enable/disable/query AI tracking.
//   • Moving the gimbal BREAKS OBSBOT's native Human Tracking, and there is NO OSC
//     command that turns it back on. A manual look-away is therefore a one-way
//     ticket: the camera loses Fred and can't re-lock without the OBSBOT UI/gesture.
//   • Cracking the real control plane (ZMQ / in-process libdev calls) is a separate
//     reverse-engineering project (see the camera memory). Until then: DON'T TOUCH
//     THE GIMBAL.
//
// So this coordinator PROTECTS the thing that works — OBSBOT's own tracking + its
// Sound-Source Voice Locator (which already finds Fred, follows him, and turns to
// whoever speaks). It REFUSES every gimbal-moving action and returns a clear,
// spoken-friendly reason. Hannibal still SEES (vision.capture grabs the current
// frame without moving anything) and TALKS (grounded presence remarks). It just
// never steers.
//
// If/when the ZMQ control plane is cracked, this is the one place to re-enable real
// steering — swap the refusals for verified commands and restore the state machine.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const STATES = { HANDS_OFF: 'hands_off' };

const HANDSOFF_REASON =
  'Camera steering is disabled: moving the OBSBOT gimbal breaks its native tracking, '
  + 'and the Tiny 3 gives no OSC command to turn tracking back on. The camera follows '
  + 'Fred and turns to whoever speaks on its own (OBSBOT Voice Locator).';

// primitives = { aim, zoom, track, followFred, preset, reset, status } (OSC layer);
// makeLook / captureCameraFrame accepted for signature-compat but unused while
// hands-off (no excursions). `status` is the only OSC call we still make (read-only).
function createCameraCoordinator({ primitives = {}, log = (m) => console.log(m) } = {}) {
  const { status } = primitives;

  const refuse = (action) => {
    log(`[camera] REFUSED "${action}" — hands-off (protecting native tracking).`);
    return { ok: false, refused: true, handsOff: true, action, reason: HANDSOFF_REASON };
  };

  return {
    state: () => STATES.HANDS_OFF,
    config: () => ({ handsOff: true }),

    // Every gimbal-moving action is refused — this is the whole point.
    look:   async () => refuse('look'),
    aim:    async () => refuse('aim'),
    reset:  async () => refuse('reset'),
    preset: async () => refuse('preset'),
    zoom:   async () => refuse('zoom'),

    // "follow me" / track: nothing to do — tracking is owned by OBSBOT hardware and
    // is already on. Report success so callers/UX read it as "yep, already on you".
    track:  async () => ({ ok: true, handsOff: true, hardwareControlled: true,
      note: 'Tracking is handled by the OBSBOT camera itself; nothing to send.' }),

    // Read-only status still works (best-effort OSC read-back, degraded by default).
    status: async () => {
      const r = (typeof status === 'function') ? await status() : { ok: true, degraded: true };
      return { ...r, coordinatorState: STATES.HANDS_OFF, handsOff: true };
    },

    stop() { /* no watchdog in hands-off mode */ },
  };
}

module.exports = { createCameraCoordinator, STATES, HANDSOFF_REASON };
