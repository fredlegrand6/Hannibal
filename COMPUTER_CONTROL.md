# Computer control — Hannibal's hands

Hannibal can operate any app on the Mac with keyboard and mouse, and check his
own work on the screen. Code: `electron/services/computer/`, native helper
`native/hands/Hands.swift` (built automatically on first start, like voice-io).

## One-time setup (Fred)

1. Restart Hannibal: `cd ~/Desktop/Projects/hannibal-v2 && ./start.sh --stop; open ~/Applications/Hannibal.app`
2. macOS asks for **Accessibility** for "Electron". If it doesn't, or it was declined:
   System Settings → Privacy & Security → **Accessibility** → turn on **Electron**
   (it lives in `hannibal-v2/node_modules/electron/dist/Electron.app`; use **+** to add it if it is not listed).
   If the list shows **hands** instead of Electron, turn that one on.
3. Restart Hannibal once more after granting. The log then says `[computer] hands ready (Esc×3 stop on)`.
   If it says Esc×3 is off: also turn on Electron under Privacy & Security → **Input Monitoring**.

Screen Recording is already granted (vision.capture uses it).

## Tools (for Claude, at the desk only)

| tool | what |
|---|---|
| `computer.screen` | screenshot of one display (or `all`) + the display list |
| `computer.click` | click x/y in the last screenshot of a display |
| `computer.clickText` | click visible text / a labelled button (accessibility first, OCR next) |
| `computer.type` | type or paste text (Fred's clipboard is put back) |
| `computer.key` | shortcuts: `cmd+n`, `enter`, `cmd+tab`, `esc`, `cmd+a, delete` |
| `computer.scroll` | up / down / left / right |
| `computer.pasteToClaudeCode` | find the Claude Code session (desktop app, then Terminal/iTerm), wait till idle, paste, send, verify |

Every action comes back with `verified` true/false (read from the screen after)
and a fresh screenshot. Max 25 actions per task.

Displays are numbered left to right: 1 = left Philips, 2 = MacBook, 3 = right
Philips. Claude clicks in the pixels of the screenshot it saw; the service maps
that to the real screen (different scaling per display is handled).

## Safety

- Clicking a **Send / Delete / Pay / Submit / Merge** button (EN/NL/FR/ES), Enter in
  a chat app, Terminal or browser, cmd+Enter, cmd+Q, Delete outside a text box,
  a new line typed into a chat app or Terminal → the normal **voice yes/no** first.
- Focus can move mid-action (cmd+tab, cmd+space, a pop-up). Right before every key, typed text
  and click he looks again at the front app and focused field and re-runs the safety check
  there. A key sequence runs one step at a time; if a later step would land somewhere gated
  (a chat app's Enter, Terminal, a protected app) he stops and that step goes through the yes/no
  on its own. If the front app is not the one that was checked, he stops and types nothing.
  Typing "System Settings" (or Keychain, a password manager) into Spotlight and pressing Enter is refused.
- "Put this in Claude Code" counts as approved by Fred's own ask.
- **Stop**: say "Hannibal stop" (or just "stop"), press **Esc 3×**, or say the wake word
  while he drives. The action is cut, Claude's turn ends, nothing more runs; he says "Stopped."
- Never types passwords/secrets unless Fred explicitly says so (then still confirmed, masked in the log).
- System Settings, Keychain and password managers are off limits unless Fred explicitly asks (then confirmed).
- A red **"Hannibal is driving"** pill shows on every display while he acts (it is hidden from his own screenshots).
- Every action is logged to `data/computer-actions.log` (app, action, target, result). The log is not committed.
- Desk only: the phone / Telegram / the always-on server can't drive the Mac. The
  Ollama planner, the presence loop and taught skills can't either.

## Tests

`node electron/services/computer/test-computer.js` (offline, fake helper, Fred's real 3-display layout).
