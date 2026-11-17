# Camera Steering — OBSBOT Tiny 3 (pan/tilt/zoom/track)

Hannibal's **hands** for the camera, beside `vision.capture`'s **eyes**. Sandbox
build — nothing promoted, live-verify before wiring into voice/planner flows.

## Which copy runs? (checked live)

The camera code and the **running app are the SAME copy**: `~/hannibal-v2`,
launched manually via `start.sh` (`npx electron .`, PID seen at runtime). The
`com.revalis.hannibal` **LaunchAgent points at the OLD `/Users/Shared/HoloAssistant/ui`
(`main-v2.js`) and is loaded-but-not-running** (status 0, no PID); that tree has
no `electron/services/agent` and no camera layer. So there is **nothing to sync** —
`~/hannibal-v2` is canonical. **Caveat:** the live Electron process was started
*before* the camera files were written, so the running process has NOT loaded the
camera layer yet — it needs an app **restart** to pick up `main.js`
(`registerCameraControl`) + the new catalog tools. That restart is **Fred's call**
(no restart without go).

## "Follow Fred" (default) vs. deliberate look-away

- **Rest state = `camera.track {mode:'auto', frame:'upper'}`** → drives the OBSBOT's
  OWN AI tracking (SetAiMode ON + SetTrackingMode upper). The camera finds and stays
  on Fred — we steer the tracker, we don't rebuild it.
- **`camera.look`** is a temporary excursion that never fights the tracker:
  `track OFF` → **relative nudge** (absolute degrees are unreliable) → settle →
  reuse the existing camera capture → **`track auto/upper` again** so the camera
  falls back onto Fred. Pass `stay:true` to remain pointed away.
- Aiming while AI-tracking is ON gets yanked back to Fred (live-established) — that's
  why `look` releases the tracker first.

## Transport chosen: OSC over UDP → OBSBOT Center

Decided in STAP 0 after probing all four options on this Mac:

| Option | Verdict |
|---|---|
| **(a) OSC → OBSBOT Center** | ✅ **CHOSEN.** App installed **and running**; Tiny 3 attached (UVC 0x3564/0xFF02). Full OSC schema is compiled into the app binary, incl. Tiny-3-specific addresses. Pure UDP → Node built-in `dgram`, **zero new deps**. |
| (b) UVC-PTZ over USB | ❌ No macOS PTZ CLI installed (`uvc-util`/`uvcc`/`v4l2-ctl` all absent = new binary dep). Tiny gimbal/AI-track/presets are proprietary, only partial on standard UVC. |
| (c) VISCA over serial | ❌ A `/dev/cu.usbmodem2105` exists but couldn't be confirmed as the OBSBOT; Tiny 3 isn't a documented VISCA device (that's the Tail Air). |
| (d) OBSBOT SDK / npm | ❌ No official Node SDK exists. |

### OSC addresses used (extracted from the OBSBOT Center binary)
```
/OBSBOT/WebCam/General/SetGimMotorDegreeEx   aim absolute (pan, tilt degrees)
/OBSBOT/WebCam/General/SetGimbal{Up,Down,Left,Right}  aim relative nudge
/OBSBOT/WebCam/General/ResetGimbal           recenter
/OBSBOT/WebCam/General/SetZoom               zoom absolute
/OBSBOT/WebCam/General/GetGimbalPosInfo(+Resp), GetZoomInfo  status read-back
/OBSBOT/WebCam/Tiny/SetAiMode                track auto/off
/OBSBOT/WebCam/Tiny/SetTrackingMode          framing upper/full
/OBSBOT/WebCam/Tiny/TriggerPreset            recall preset slot
```

## ⚠️ One-time setup Fred must do (this is why nothing moves yet)

During the scan **nothing was listening on an OSC port** → OSC is currently OFF.

1. **OBSBOT Center → Settings → OSC → enable.**
2. Set its **OSC receive port** to **16284** (or any port, then set
   `HANNIBAL_OBSBOT_OSC_PORT` in `.env` to match).
3. (Optional, for `camera.status` live read-back) point OBSBOT's OSC **send-back**
   at `127.0.0.1:16285` (`HANNIBAL_OBSBOT_OSC_RECV_PORT`).

## Honesty note

Addresses are **certain** (from the binary). The per-address **argument encodings**
are **best-effort** — OBSBOT doesn't publish them and I couldn't live-test (OSC was
off). UDP is fire-and-forget, so a send always "succeeds"; **watch the camera
physically move** to confirm port + args. Arg tuning is the first thing to check on
your live run. Every send is logged (`[camera] OSC → …`).

## Calibration knobs (env — no code edits)

| env | default | what |
|---|---|---|
| `HANNIBAL_OBSBOT_OSC_PORT` | 16284 | OBSBOT Center OSC receive port (must match app) |
| `HANNIBAL_OBSBOT_NUDGE_DEG` | 15 | magnitude of ONE relative nudge — tune the step feel |
| `HANNIBAL_OBSBOT_AI_ON` | 1 | SetAiMode ON value (0 = off; verify ON on live run) |
| `HANNIBAL_OBSBOT_FRAME_UPPER` / `_FULL` | 1 / 0 | SetTrackingMode framing values |
| `HANNIBAL_OBSBOT_SETTLE_MS` | 650 | gimbal settle before `look` captures |

Absolute-degree encoding (`SetGimMotorDegreeEx`) is **kept but marked unreliable**
(live: 40 → ~190°); relative nudges are the working path.

## How to test locally (no full app needed)

```bash
cd ~/hannibal-v2
node scripts/camera-test.js follow          # tracking ON → camera finds Fred (rest state)
node scripts/camera-test.js follow-demo     # (a) find me → (b) look left → (c) back on me
node scripts/camera-test.js nudge left 2    # 2 relative nudges left (working path)
node scripts/camera-test.js zoom 60         # or: zoom in / zoom out
node scripts/camera-test.js track auto upper
node scripts/camera-test.js track off
node scripts/camera-test.js reset
node scripts/camera-test.js status
# tune the step: HANNIBAL_OBSBOT_NUDGE_DEG=25 node scripts/camera-test.js nudge left 1
# wrong port?    HANNIBAL_OBSBOT_OSC_PORT=8000 node scripts/camera-test.js follow-demo
```

`camera.look` (steer + capture) runs inside the Electron app — it reuses
`captureCameraFrame()` (the same avfoundation device as `vision.capture`, no
second camera path). Test it via the Hannibal UI once the app is running.

## Voice / text routing (intent → tool)

Spoken/typed commands are matched in `parseCommand` by a new **`parseCamera(t)`**
(NL + EN), placed **before `parseVision`** so a directed look MOVES the gimbal
instead of taking a passive snapshot. Dispatched by `handleCamera` (renderer) via
the `cameraControl` preload bridge → `camera:control` IPC.

| say (NL / EN) | → tool |
|---|---|
| "kijk rond" / "look around" | `camera.look {around}` → nudge + capture + back to Fred |
| "kijk naar links/rechts/boven/beneden", "look left", "pan up", "turn right" | `camera.look {dir}` (relative nudge) |
| "wat zie je" / "what do you see" | falls to `parseVision` → passive camera snapshot (no move) |
| "volg mij" / "blijf op mij" / "follow me" / "stay on me" | `camera.track {mode:auto, frame:upper}` |
| "stop met volgen" / "kijk zelf" / "stop following" | `camera.track {mode:off}` |
| "zoom in/uit" / "zoom in/out" / "inzoomen" | `camera.zoom {direction}` |
| "camera terug/center" / "recenter" | `camera.reset` |

Directed looks always run through `camera.look` (tracker-off → nudge → capture →
back to Fred), so they never fight the AI tracker. "look up/for &lt;X&gt;" is
guarded as a search, not a tilt. The **planner** also reaches these tools for
free-form asks (verified: *"point the camera to my left and describe what is there"*
→ `camera.look {target:"left"}`).

## Files touched (routing)
- `src/voice-controller.js` — `parseCamera()` + `handleCamera()` + `describeFrames()`
  (factored from `describeVision`) + dispatch + task-type.
- `electron/preload.js` — `cameraControl` bridge.
- `electron/services/camera-control.js` — `look()` gained voice-path `dir`/`around`
  conveniences (calibrated via `nudge()`); catalog params unchanged.

## Files touched (steering layer)
- **NEW** `electron/services/camera-control.js` — OSC layer + `camera:control` IPC.
- **NEW** `scripts/camera-test.js` — standalone tester.
- `electron/main.js` — require + `registerCameraControl(...)`; extracted the camera
  branch of `voice:capture` into reusable `captureCameraFrame()` (behavior identical).
- `electron/services/agent/catalog.js` — new `camera` domain: 7 read tools.

No new npm dependencies. No auto-deploy, no LaunchAgent restart.
