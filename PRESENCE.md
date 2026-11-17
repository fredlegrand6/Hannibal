# Presence Loop — Hannibal's first autonomous layer

A light, continuous heartbeat that makes Hannibal feel alive: he looks around on
his own, notices things through the vision model, and speaks up (English) without
being asked. **Default OFF** — a restart alone stays silent.

## Hard safety boundary (non-negotiable)

The loop may **only autonomously fire READ tools**. Every write/confirm tool
(`mail.send`, `whatsapp.send`, `imessage.send`, `file.trash`, `mac.shell`,
`mac.emptyTrash`, `app.quit`, …) is **blocked by `safeInvoke()`** before it can
run — verified: all refused, only the read allow-list passes. Two layers:
1. `catalog.isWrite(tool) || catalog.confirmRequired(tool)` → refuse.
2. explicit read allow-list (`camera.*`, `vision.capture`, `world.*`, `memory.query`).
Every autonomous action (incl. refusals) is logged (`[presence] …`) and emitted
on `presence:action` for Fred to review. The loop can at most *propose* a write;
it never executes one — writes stay behind the existing confirmation gate.

## Architecture

- **`electron/services/agent/presence.js`** (main process, mirrors the Stage-7
  awareness engine). Owns the heartbeat + state; emits events to the renderer.
  - **RUST**: keeps the OBSBOT tracking Fred (`camera.track auto/upper`).
  - **HOORT**: relies on the OBSBOT **Voice Locator** (hardware) to orient toward
    whoever speaks while tracking is on — we don't drive the gimbal at sound. The
    renderer feeds the last utterance (`presence:heard`) for conversational context.
  - **ZIET**: every `visionIntervalMs` it grabs a frame (a curiosity-driven
    `camera.look` wander, else `vision.capture`) and asks the vision model
    *"anything worth reacting to?"* → JSON `{notable, interest, say}`.
  - **BESLIST/PRAAT**: if notable + interest ≥ threshold (lower when livelier) +
    rate-limit ok + not muted → emits `presence:remark {text}` (English).
- **`src/voice-controller.js`** speaks remarks through the **same overlap guard as
  awareness** (`handlePresenceRemark`) — never over Fred, the confirm gate, or an
  in-progress utterance. Remarks are English, **not translated**.
- Speech playback + brain reuse the existing `speakLine` path (so the mic never
  opens over Hannibal's own voice).

## Controls (spoken + typed, EN + NL) — STAP 3

| say | effect |
|---|---|
| "shut up" / "be quiet" / "hou je mond" / "stil" / "zwijg" | **MUTE** — keeps watching, says nothing |
| "you can talk" / "unmute" / "praat maar" | **UNMUTE** |
| "go to sleep" / "ga slapen" | **SLEEP** — fully reactive (no proactive look/talk) |
| "wake up" / "word wakker" / "come alive" | **WAKE** — proactive again (starts the loop if stopped) |

`mute` (bare) is intentionally left as the existing **audio** mute — not hijacked.
mute/sleep **persist** to `data/presence.json`, so a restart respects them.

## Env knobs (no code edits) — STAP 4

| env | default | meaning |
|---|---|---|
| `HANNIBAL_PRESENCE_ENABLED` | off | auto-start the loop on app launch |
| `HANNIBAL_PRESENCE_VISION_INTERVAL_MS` | 6000 | how often it looks |
| `HANNIBAL_PRESENCE_SPEAK_MIN_GAP_MS` | 45000 | min gap between spontaneous remarks (anti-spam) |
| `HANNIBAL_PRESENCE_CURIOSITY` | 0.5 | 0 calm … 1 lively (wander chance + speak threshold) |
| `HANNIBAL_PRESENCE_VISION_TIMEOUT_MS` | 90000 | vision-model timeout |
| `HANNIBAL_OBSBOT_NUDGE_DEG` | 15 | (existing) relative nudge step for look-arounds |

## How Fred tests it — and turns it off

The code is in the running tree but **Electron won't hot-reload main/preload/renderer**,
so it goes live only after an **app restart** (Fred's go). Then:
- **Start it**: launch with `HANNIBAL_PRESENCE_ENABLED=1`, or just say **"wake up"**.
- **Watch**: it looks around, and after a few seconds may say something in English.
  Console shows `[presence] cycle: …` and `[presence] REMARK → …`.
- **Silence it**: say **"shut up"** (mutes) or **"go to sleep"** (fully dormant).
- **Off entirely**: don't set the env / say "go to sleep"; state persists.
- **No app needed** (logic dry-run): the STAP-5 harness drives one `tick()` with a
  fake camera + vision and shows autonomous look, an English remark, mute→silent,
  sleep→dormant, and every write refused.

## Files touched
- **NEW** `electron/services/agent/presence.js` — the loop + `safeInvoke` write-filter.
- `electron/main.js` — `createPresence(...)` + `presence:*` IPC + stop-on-quit + env auto-start.
- `electron/preload.js` — `presenceControl/Status/Config/Heard` + `onPresence*` bridges.
- `src/voice-controller.js` — `parsePresence()` + `handlePresence()` + `handlePresenceRemark()`
  (reuses the awareness overlap guard) + `presenceHeard` feed.

No new npm deps. No deploy. No LaunchAgent/app restart without Fred's go.
