// ─────────────────────────────────────────────────────────────────────────
// TOOL CATALOG — the single source of truth for every action Hannibal can
// currently perform. (Agent loop, Stage 1.)
//
// This file ONLY DESCRIBES capabilities that already exist elsewhere in the
// codebase — it changes no behavior and executes nothing. Later stages read it:
//   • the Planner (Stage 2) may ONLY compose plans from tools listed here.
//   • the Executor (Stage 3+) maps a tool's `via` field to the real invocation
//     and uses `side_effect` to decide what runs automatically (read) vs. what
//     needs Fred's confirmation (write).
//
// WHERE EACH TOOL ACTUALLY LIVES (kept faithful, nothing relocated):
//   • electron/main.js                    — most IPC handlers (mail, calendar,
//                                            web, vision, lists, persistence)
//   • electron/services/system-control.js — 'browser-action' + 'mac-control'
//   • electron/services/imap-mail.py /
//     imap-read-body.py                   — spawned by main for Zoho IMAP
//   • src/voice-controller.js (renderer)  — Qdrant memory + LLM translation
//
// SIDE-EFFECT RULE (how 'read' vs 'write' was assigned — applied consistently):
//   read  = observes / retrieves only, or a trivially-reversible UI or device
//           toggle. Makes no outbound communication, deletes/overwrites no
//           PERSISTENT data, spends nothing, runs no arbitrary code.
//   write = sends/posts outbound (mail, WhatsApp, iMessage), creates / deletes /
//           overwrites persistent data (data/*.json, Qdrant), spends money,
//           runs arbitrary code (shell, taught skills), force-quits an app
//           (may discard unsaved work), or triggers a page action in the
//           browser (form submit / link click).
//   (Clipboard + the macOS clipboard are treated as ephemeral scratch, so
//    clipboard writes stay 'read' — they need no confirmation.)
//
// TWO PLANNER/GATE FLAGS (added Stage 1b):
//   planner_safe — defaults to true (omitted). Only mac.shell and skills.execute
//                  set it false: still usable by a direct command, but the
//                  Planner must NEVER compose them into a plan. Use plannerTools().
//   confirm      — present on every write tool. true  → Stage 4's confirmation
//                  gate fires before executing (external/consequential actions).
//                  false → internal housekeeping write, runs without a prompt.
//                  (Read tools have no confirm, except clipboard.set which carries
//                   confirm:false for completeness.) Use confirmRequired(name).
//
// SUPABASE / n8n — read this before adding tools for them:
//   • There is NO Supabase-backed query action today. "Supabase" exists only as
//     a Chrome bookmark URL (browser-action bookmark|supabase). Nothing in the
//     app authenticates to or queries a Supabase project.
//   • n8n is INBOUND ONLY. electron/services/cc-ingest.js runs an HTTP listener
//     that RECEIVES Claude Code session events pushed FROM an n8n workflow over
//     Tailscale. Hannibal never calls out to an n8n workflow, so there is no
//     outbound n8n tool to catalog. (See `notes` export at the bottom.)
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const SIDE_EFFECT = { READ: 'read', WRITE: 'write' };

// Which process / service actually does the work.
const EXECUTOR = {
  MAIN: 'electron-main',       // IPC handler in main.js / system-control.js (osascript, shell, fetch, spawn)
  RENDERER: 'electron-renderer', // function in src/voice-controller.js (HTTP to GEX131 Qdrant / Ollama)
  SSH: 'ssh',                  // spawned by main, but the work runs on GEX131 over SSH
  N8N: 'n8n',                  // an n8n workflow (none outbound today — see header)
};

// Every entry:
//   name        — stable dotted id the planner/executor reference
//   domain      — grouping for humans
//   description — one line: what it does
//   params      — [{ name, type, required, desc?, enum? }]  (type ∈ string|number|boolean|object|array|enum)
//   side_effect — SIDE_EFFECT.READ | SIDE_EFFECT.WRITE
//   executor    — EXECUTOR.*
//   via         — concrete invocation today (IPC channel + action, or renderer fn)
//   note?       — caveat worth carrying forward
const TOOLS = [
  // ═══════════════════════ MAIL (Zoho IMAP) ═══════════════════════
  { name: 'mail.inbox', domain: 'mail',
    description: 'Zoho inbox summary over IMAP: unread count + latest messages.',
    params: [], side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'mail:inbox' },
    returns: '{ ok, unread, messages:[{ from, subject, time, unread, uid }] }  (messages[0] = newest)',
    note: 'Spawns electron/services/imap-mail.py. Mail is Zoho (imap.zoho.eu), not Nextcloud/Apple Mail.' },
  { name: 'mail.readBody', domain: 'mail',
    description: 'Read the full body of one message by its IMAP UID.',
    params: [{ name: 'uid', type: 'string', required: true, desc: 'IMAP UID from mail.inbox' }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'mail:read-body' },
    returns: '{ ok, from (display name), from_email (use this as a reply recipient), subject, date, body }',
    note: 'Spawns electron/services/imap-read-body.py. For a reply, send to {{N.from_email}}, not {{N.from}}.' },
  { name: 'mail.send', domain: 'mail',
    description: 'Open a pre-filled compose window via a mailto: URL.',
    params: [
      { name: 'to', type: 'string', required: true },
      { name: 'subject', type: 'string', required: false },
      { name: 'body', type: 'string', required: false },
    ], side_effect: SIDE_EFFECT.WRITE, confirm: true, executor: EXECUTOR.MAIN,
    via: { channel: 'mac-control', action: 'email-send' },
    // ask-once-generalize: remember per RECIPIENT, exact match. Capped at
    // cancel-beat even though mailto only opens a draft today — protects the
    // future SMTP version, which would actually send.
    permission: { key: 'to', match: 'exact', ceiling: 'cancel-beat' },
    note: 'Opens the default mail client compose window (mailto:); does NOT auto-send. Outbound → write. Prefer mail.reply / mail.write, which really send from Zoho.' },
  { name: 'mail.triage', domain: 'mail',
    description: "Fred's unread Zoho mail from the last few days, with sender, subject and a short preview of each, to tell him what matters.",
    params: [
      { name: 'days', type: 'number', required: false, desc: 'how many days back (default 3)' },
      { name: 'limit', type: 'number', required: false, desc: 'max messages (default 20)' },
    ], side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'mail:triage' },
    returns: '{ ok, unread_total, messages:[{ uid, from, from_email, subject, date, to_me_directly, newsletter, preview }] }',
    note: 'Use this first for "what\'s in my mail / anything important". Lead with what needs Fred (clients, money, deadlines, people he knows), '
      + 'skip newsletters and notifications unless asked. Read a full mail with mail.readBody before drafting a reply.' },
  { name: 'mail.reply', domain: 'mail',
    description: "Send a reply from Fred's Zoho address to one email (threaded, quotes the original, saved in Sent).",
    params: [
      { name: 'uid', type: 'string', required: true, desc: 'IMAP UID from mail.triage / mail.inbox' },
      { name: 'to', type: 'string', required: true, desc: 'the sender address to reply to (from_email); the send is refused if it does not match the original sender' },
      { name: 'body', type: 'string', required: true, desc: "the reply text in Fred's voice, in the language of the original mail, signed as Fred" },
    ], side_effect: SIDE_EFFECT.WRITE, confirm: true, executor: EXECUTOR.MAIN,
    via: { channel: 'mail:reply' },
    permission: { ceiling: 'never' },
    returns: '{ ok, sent_to, subject }',
    note: 'Really sends. Fred hears or reads the full draft and says yes first, every time. Draft first, then call this once he likes it.' },
  { name: 'mail.write', domain: 'mail',
    description: "Send a new email from Fred's Zoho address to one recipient (saved in Sent).",
    params: [
      { name: 'to', type: 'string', required: true, desc: 'one email address (from a mail he received, a contact or Fred himself)' },
      { name: 'subject', type: 'string', required: true },
      { name: 'body', type: 'string', required: true },
    ], side_effect: SIDE_EFFECT.WRITE, confirm: true, executor: EXECUTOR.MAIN,
    via: { channel: 'mail:write' },
    permission: { ceiling: 'never' },
    returns: '{ ok, sent_to, subject }',
    note: 'Really sends. Never guess an address. Fred approves the full text first, every time.' },
  { name: 'mail.markRead', domain: 'mail',
    description: 'Mark one Zoho email as read (when Fred has dealt with it or says skip).',
    params: [{ name: 'uid', type: 'string', required: true }],
    side_effect: SIDE_EFFECT.WRITE, confirm: false, executor: EXECUTOR.MAIN,
    via: { channel: 'mail:seen' },
    returns: '{ ok }' },
  { name: 'mail.checkAppleMail', domain: 'mail',
    description: 'LEGACY: unread count + latest senders/subjects from Apple Mail.app.',
    params: [], side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'mac-control', action: 'email-check' },
    note: 'Reads Apple Mail, not Zoho. Prefer mail.inbox. Kept for completeness.' },

  // ═══════════════════════ CALENDAR ═══════════════════════
  { name: 'calendar.events', domain: 'calendar',
    description: "Fred's calendar events from today onwards (Apple Calendar: all his iCloud calendars). Default today + tomorrow; ask for more days to see further ahead or check for clashes before booking.",
    params: [{ name: 'days', type: 'number', required: false, desc: 'how many days from today, 1-31 (default 2)' }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'calendar:events' },
    returns: '{ ok, events:[{ id, ts, time, allDay, title, calendar, day:"today"|"tomorrow"|"Monday 24 November" }] } (id is what calendar.delete and calendar.move need)',
    note: 'CalDAV REPORT on every iCloud calendar (caldav.js, ICLOUD_EMAIL + app-specific ICLOUD_APP_PW in .env); Nextcloud if only that is set.' },
  { name: 'calendar.add', domain: 'calendar',
    description: "Book an event in Fred's calendar (Apple Calendar), e.g. a meeting you just agreed on. Check calendar.events for clashes first. Fred always confirms before it is booked.",
    params: [
      { name: 'title', type: 'string', required: true, desc: 'e.g. "Call with Jean-Marc about HTS"' },
      { name: 'start', type: 'string', required: true, desc: 'local time YYYY-MM-DDTHH:MM, or YYYY-MM-DD for an all-day event' },
      { name: 'minutes', type: 'number', required: false, desc: 'length in minutes (default 60)' },
      { name: 'location', type: 'string', required: false },
      { name: 'notes', type: 'string', required: false },
    ], side_effect: SIDE_EFFECT.WRITE, confirm: true, permission: { ceiling: 'never' }, executor: EXECUTOR.MAIN,
    via: { channel: 'calendar:add' },
    returns: '{ ok, title, when }',
    note: 'CalDAV PUT of one new VEVENT (If-None-Match: *).' },
  { name: 'calendar.delete', domain: 'calendar',
    description: "Delete an event from Fred's calendar. Look it up with calendar.events first and pass its id and exact title. Fred always confirms first. Repeating events can't be changed here yet.",
    params: [
      { name: 'id', type: 'string', required: true, desc: 'the event id from calendar.events' },
      { name: 'title', type: 'string', required: true, desc: 'the event title as calendar.events gave it' },
      { name: 'when', type: 'string', required: false, desc: 'when it is, as calendar.events gave it (day + time), for the question to Fred' },
    ], side_effect: SIDE_EFFECT.WRITE, confirm: true, permission: { ceiling: 'never' }, executor: EXECUTOR.MAIN,
    via: { channel: 'calendar:delete' },
    returns: '{ ok, deleted, calendar }',
    note: 'CalDAV DELETE with If-Match; refuses when the id belongs to another title, a repeating event or a read-only calendar.' },
  { name: 'calendar.move', domain: 'calendar',
    description: "Move an event in Fred's calendar to a new time (and optionally a new length). Look it up with calendar.events first and pass its id and exact title; check the new slot for clashes. Fred always confirms first. Repeating events can't be changed here yet.",
    params: [
      { name: 'id', type: 'string', required: true, desc: 'the event id from calendar.events' },
      { name: 'start', type: 'string', required: true, desc: 'new local time YYYY-MM-DDTHH:MM, or YYYY-MM-DD for all day' },
      { name: 'minutes', type: 'number', required: false, desc: 'new length in minutes (default: keep the old length)' },
      { name: 'title', type: 'string', required: true, desc: 'the event title as calendar.events gave it' },
    ], side_effect: SIDE_EFFECT.WRITE, confirm: true, permission: { ceiling: 'never' }, executor: EXECUTOR.MAIN,
    via: { channel: 'calendar:move' },
    returns: '{ ok, title, when, calendar }',
    note: 'Rewrites DTSTART/DTEND of the stored event (If-Match), bumps SEQUENCE; keeps everything else (alarms, notes, invitees).' },
  { name: 'calendar.todaysEventsAppleCal', domain: 'calendar',
    description: "LEGACY: today's events read from Apple Calendar.app.",
    params: [], side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'mac-control', action: 'todays-events' },
    note: 'Reads local Calendar.app, not Nextcloud. Prefer calendar.events.' },

  // ═══════════════════════ MESSAGING ═══════════════════════
  { name: 'whatsapp.send', domain: 'messaging',
    description: 'Send a WhatsApp message to a contact via UI scripting.',
    params: [
      { name: 'contact', type: 'string', required: true },
      { name: 'message', type: 'string', required: true },
    ], side_effect: SIDE_EFFECT.WRITE, confirm: true, planner_safe: false, executor: EXECUTOR.MAIN,
    via: { channel: 'mac-control', action: 'whatsapp-send' },
    note: 'KNOWN-WEAK: AppleScript-driving the WhatsApp Catalyst app is brittle — its '
      + 'a11y tree shifts with chat state (empty chat → no findable composer), localized rows. '
      + 'planner_safe:false until rebuilt on WhatsApp Web via Playwright (stable DOM composer). '
      + 'Still callable directly; it now verifies the send and reports honest success/failure.' },
  { name: 'whatsapp.search', domain: 'messaging',
    description: 'Open WhatsApp and search for a contact (does not send anything).',
    params: [{ name: 'contact', type: 'string', required: true }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'mac-control', action: 'whatsapp-search' } },
  { name: 'whatsapp.debugUi', domain: 'messaging',
    description: "Dump WhatsApp's accessibility tree (debugging aid).",
    params: [], side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'mac-control', action: 'whatsapp-debug-ui' } },
  { name: 'imessage.send', domain: 'messaging',
    description: 'Send an iMessage to a known contact or explicit number.',
    params: [
      { name: 'contact', type: 'string', required: false, desc: 'name in built-in map; or use number' },
      { name: 'number', type: 'string', required: false, desc: 'phone number, overrides contact' },
      { name: 'message', type: 'string', required: true },
    ], side_effect: SIDE_EFFECT.WRITE, confirm: true, executor: EXECUTOR.MAIN,
    via: { channel: 'mac-control', action: 'imessage-send' },
    note: 'Contact→number map is hardcoded with placeholder numbers in system-control.js.' },

  // ═══════════════════════ APPS ═══════════════════════
  { name: 'app.open', domain: 'apps',
    description: 'Launch/focus an app by spoken or typed name (alias + fuzzy match).',
    params: [{ name: 'name', type: 'string', required: true }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'mac-control', action: 'open-app' } },
  { name: 'app.openInEditor', domain: 'apps',
    description: 'Open a project folder in a dev tool (Cursor/VS Code) or launch Claude Code in Terminal.',
    params: [
      { name: 'editor', type: 'enum', required: true, enum: ['claude', 'cc', 'cursor', 'code', 'vscode'] },
      { name: 'project', type: 'string', required: true, desc: 'name (fuzzy across common roots) or explicit path' },
    ], side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'mac-control', action: 'open-in-editor' } },
  { name: 'app.quit', domain: 'apps',
    description: 'Quit an app (graceful AppleScript quit, pkill fallback).',
    params: [{ name: 'name', type: 'string', required: true }],
    side_effect: SIDE_EFFECT.WRITE, confirm: true, executor: EXECUTOR.MAIN,
    via: { channel: 'mac-control', action: 'quit-app' },
    // ask-once-generalize: remember per APP NAME, exact. Quitting an app is
    // low-stakes and reversible (relaunch), so it may reach true auto (via a
    // second deliberate opt-in). (app.open/switch/hide are reads — never gated.)
    permission: { key: 'name', match: 'exact', ceiling: 'auto' },
    note: 'pkill fallback can force-kill and discard unsaved work → write.' },
  { name: 'app.list', domain: 'apps',
    description: 'List visible (non-background) running apps.',
    params: [], side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'mac-control', action: 'list-apps' } },
  { name: 'app.switch', domain: 'apps',
    description: 'Bring an app to the front.',
    params: [{ name: 'name', type: 'string', required: true }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'mac-control', action: 'switch-app' } },
  { name: 'app.hide', domain: 'apps',
    description: 'Hide an app.',
    params: [{ name: 'name', type: 'string', required: true }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'mac-control', action: 'hide-app' } },
  { name: 'app.minimize', domain: 'apps',
    description: "Minimize all of an app's windows.",
    params: [{ name: 'name', type: 'string', required: true }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'mac-control', action: 'minimize' } },

  // ═══════════════════════ FILES (Spotlight + fs) ═══════════════════════
  { name: 'file.search', domain: 'files',
    description: 'Spotlight file search by name, with type/location filters; returns structured JSON hits.',
    params: [
      { name: 'query', type: 'string', required: true },
      { name: 'type', type: 'enum', required: false, enum: ['all', 'pdf', 'doc'] },
      { name: 'location', type: 'enum', required: false, enum: ['all', 'downloads', 'desktop', 'documents', 'projects'] },
    ], side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'mac-control', action: 'file-search' } },
  { name: 'file.list', domain: 'files',
    description: 'List a folder (formatted), sorted by recent/name/size.',
    params: [
      { name: 'folder', type: 'string', required: false, desc: 'defaults to ~' },
      { name: 'sort', type: 'enum', required: false, enum: ['recent', 'name', 'size'] },
    ], side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'mac-control', action: 'file-list' } },
  { name: 'file.recent', domain: 'files',
    description: 'Recently changed files in the home tree (Spotlight date predicate).',
    params: [
      { name: 'hours', type: 'number', required: false, desc: 'lookback window, default 24' },
      { name: 'type', type: 'enum', required: false, enum: ['all', 'pdf', 'doc', 'code'] },
    ], side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'mac-control', action: 'file-recent' } },
  { name: 'file.read', domain: 'files',
    description: 'Read a text file as UTF-8 (200 KB cap) for the LLM to read/summarize.',
    params: [{ name: 'path', type: 'string', required: true }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'mac-control', action: 'file-read' } },
  { name: 'file.open', domain: 'files',
    description: 'Open a file/path with the default app (LaunchServices).',
    params: [{ name: 'path', type: 'string', required: true }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'mac-control', action: 'file-open' } },
  { name: 'file.findByName', domain: 'files',
    description: 'LEGACY: plain mdfind by name, top 10 paths as text.',
    params: [{ name: 'name', type: 'string', required: true }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'mac-control', action: 'find-file' },
    note: 'Superseded by file.search (structured JSON).' },
  { name: 'file.openFolder', domain: 'files',
    description: 'Open a folder in Finder.',
    params: [{ name: 'path', type: 'string', required: true }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'mac-control', action: 'open-folder' } },
  { name: 'file.openPath', domain: 'files',
    description: 'LEGACY: open a path with `open` (bare string).',
    params: [{ name: 'path', type: 'string', required: true }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'mac-control', action: 'open-file' },
    note: 'Equivalent to file.open.' },
  { name: 'file.desktop', domain: 'files',
    description: 'List the top of ~/Desktop.',
    params: [], side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'mac-control', action: 'desktop-files' } },
  { name: 'file.downloads', domain: 'files',
    description: 'List the newest items in ~/Downloads.',
    params: [], side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'mac-control', action: 'downloads-files' } },
  { name: 'file.recentHome', domain: 'files',
    description: "LEGACY: files changed in ~ in the last day (text list).",
    params: [], side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'mac-control', action: 'recent-files' },
    note: 'Superseded by file.recent.' },
  { name: 'file.trash', domain: 'files',
    description: 'Move a file to the Trash via Finder.',
    params: [{ name: 'path', type: 'string', required: true }],
    side_effect: SIDE_EFFECT.WRITE, confirm: true, executor: EXECUTOR.MAIN,
    via: { channel: 'mac-control', action: 'trash' },
    // ask-once-generalize: PREFIX match on path, so "always for ~/Downloads"
    // generalizes to files under that folder. Recoverable (Trash, not hard
    // delete) so it may reach cancel-beat — never auto.
    permission: { key: 'path', match: 'prefix', ceiling: 'cancel-beat' } },

  // ═══════════════════════ VISION / SCREENSHOTS ═══════════════════════
  { name: 'vision.capture', domain: 'vision',
    description: 'Capture a frame (camera or screen[s]), downscale, return base64 for the vision model.',
    params: [{ name: 'kind', type: 'enum', required: false,
      enum: ['camera', 'screen', 'screen-laptop', 'screen-left', 'screen-right', 'screen-N'],
      desc: "defaults to 'screen' (all displays); 'screen-N' is 1-indexed" }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'voice:capture' },
    note: 'Needs Camera / Screen Recording TCC grants on the Electron binary.' },
  { name: 'screenshot.toDesktop', domain: 'vision',
    description: 'Save a full-screen screenshot to ~/Desktop.',
    params: [], side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'mac-control', action: 'screenshot' } },
  { name: 'screenshot.toClipboard', domain: 'vision',
    description: 'Capture the screen to the clipboard.',
    params: [], side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'mac-control', action: 'screenshot-clipboard' } },
  { name: 'screenshot.window', domain: 'vision',
    description: 'Capture a window to ~/Desktop (interactive picker).',
    params: [], side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'mac-control', action: 'screenshot-window' } },

  // ═══════════════════════ CAMERA STEERING (OBSBOT Tiny 3) ═══════════════════════
  // The 'hands' beside vision.capture's 'eyes'. Real control over OSC → OBSBOT
  // Center (electron/services/camera-control.js, channel 'camera:control').
  // side_effect READ for all: camera motion is a trivially-reversible device
  // toggle (recenter via camera.reset), same class as mac.volume*/brightness —
  // no confirmation gate. All planner-safe (read).
  { name: 'camera.aim', domain: 'camera',
    description: 'Nudge the OBSBOT gimbal. Relative nudge (default, RELIABLE); absolute degrees exist but are unreliable.',
    params: [
      { name: 'pan', type: 'number', required: false, desc: 'left(−)/right(+) nudge magnitude (device units)' },
      { name: 'tilt', type: 'number', required: false, desc: 'down(−)/up(+) nudge magnitude (device units)' },
      { name: 'mode', type: 'enum', required: false, enum: ['relative', 'absolute'], desc: "default 'relative' — 'absolute' is UNRELIABLE (scale off), avoid" },
    ], side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'camera:control', action: 'aim' },
    note: 'Relative → SetGimbalUp/Down/Left/Right (working path; step tunable via HANNIBAL_OBSBOT_NUDGE_DEG). '
      + 'Absolute → SetGimMotorDegreeEx is kept but scale is unreliable (40→~190°). Aiming while AI-tracking is on gets '
      + 'yanked back to Fred — use camera.look, which releases the tracker first. Needs OSC enabled in OBSBOT Center.' },
  { name: 'camera.zoom', domain: 'camera',
    description: 'Set OBSBOT zoom to an absolute level (0–100) or step in/out.',
    params: [
      { name: 'level', type: 'number', required: false, desc: '0–100 absolute zoom' },
      { name: 'direction', type: 'enum', required: false, enum: ['in', 'out'], desc: 'relative ±25 step' },
    ], side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'camera:control', action: 'zoom' },
    note: 'OSC SetZoom. Pass level OR direction.' },
  { name: 'camera.track', domain: 'camera',
    description: "OBSBOT AI tracking = 'follow Fred'. auto → the camera finds & locks onto Fred itself; off → frees the gimbal for a manual look. auto+upper is the REST STATE.",
    params: [
      { name: 'mode', type: 'enum', required: true, enum: ['auto', 'off'] },
      { name: 'frame', type: 'enum', required: false, enum: ['upper', 'full'], desc: 'upper-body vs full-body framing' },
      { name: 'group', type: 'boolean', required: false, desc: 'track a group instead of one subject' },
    ], side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'camera:control', action: 'track' },
    note: "OSC Tiny/SetAiMode (ON value tunable via HANNIBAL_OBSBOT_AI_ON, default 1; [0]=off) + SetTrackingMode for framing. "
      + "This DRIVES the OBSBOT's own AI tracking rather than reimplementing it — that's how Hannibal 'finds you'. "
      + 'REST STATE: when not deliberately looking elsewhere, leave this at auto/upper so the camera keeps itself on Fred.' },
  { name: 'camera.preset', domain: 'camera',
    description: 'Recall a saved OBSBOT gimbal position preset (slot 1–9).',
    params: [{ name: 'slot', type: 'number', required: true, desc: 'preset slot 1–9' }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'camera:control', action: 'preset' },
    note: 'OSC Tiny/TriggerPreset.' },
  { name: 'camera.reset', domain: 'camera',
    description: 'Recenter the OBSBOT gimbal (and zoom) to the neutral home position.',
    params: [], side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'camera:control', action: 'reset' },
    note: 'OSC General/ResetGimbal.' },
  { name: 'camera.status', domain: 'camera',
    description: 'Read current OBSBOT pan/tilt/zoom/mode (best-effort; degrades if OSC read-back is unconfigured).',
    params: [], side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'camera:control', action: 'status' },
    returns: '{ ok, degraded, raw?, lastZoom?, note? }',
    note: 'OSC GetGimbalPosInfo/GetZoomInfo. Returns degraded:true unless OBSBOT Center OSC send-back points at us.' },
  { name: 'camera.look', domain: 'camera',
    description: "Deliberately glance somewhere then capture a frame — releases the tracker, nudges, sees, then auto-returns to Fred.",
    params: [
      { name: 'target', type: 'string', required: false, desc: 'free-text description of what to look at (for logs)' },
      { name: 'pan', type: 'number', required: false, desc: 'relative pan nudge (left −/right +, device units)' },
      { name: 'tilt', type: 'number', required: false, desc: 'relative tilt nudge (down −/up +, device units)' },
      { name: 'zoom', type: 'number', required: false, desc: 'absolute zoom 0–100' },
      { name: 'stay', type: 'boolean', required: false, desc: "default false → returns to Fred (auto/upper) after the glance; true = stay put" },
    ], side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'camera:control', action: 'look' },
    returns: '{ ok, target, moved:{ trackOff?, aim?, zoom?, returnedToFred? }, restedOnFred, b64 }  (b64 = the captured frame)',
    note: 'STAP-2 cycle: track OFF → RELATIVE nudge (absolute is unreliable) → settle → reuse existing camera capture '
      + '(captureCameraFrame, same device as vision.capture) → track auto/upper so the camera falls back onto Fred. '
      + 'So "stay on me" is the default and "look over there" is a temporary excursion. Read-only.' },

  // ═══════════════════════ WEB ═══════════════════════
  { name: 'web.search', domain: 'web',
    description: 'Web search via the self-hosted SearXNG; returns top results as JSON.',
    params: [{ name: 'query', type: 'string', required: true }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'web:search' },
    returns: '{ ok, results:[{ url, title, content }] }',
    note: 'SearXNG at gex131-1:8888; JSON format must be enabled in settings.yml.' },
  { name: 'web.fetch', domain: 'web',
    description: 'Fetch a URL and return title + plain text (HTML stripped, 200 KB cap).',
    params: [{ name: 'url', type: 'string', required: true }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'web:fetch' },
    returns: '{ ok, url, title, text }' },

  // ═══════════════════════ GEX131 / SYSTEM METRICS ═══════════════════════
  { name: 'gex131.metrics', domain: 'metrics',
    description: 'GPU/CPU/mem/net/uptime snapshot of GEX131 over a single SSH round-trip.',
    params: [], side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.SSH,
    via: { channel: 'system:metrics' },
    returns: '{ ok, ts, gpu, mem:{ used, total }, cpu:{ busy, total }, net:{ rx, tx }, uptime }',
    note: 'main spawns `ssh GEX131 <script>`; GPU is null while the NVIDIA driver is unloaded.' },

  // ═══════════════════════ LOCAL MAC SYSTEM INFO (read) ═══════════════════════
  { name: 'mac.battery', domain: 'system',
    description: 'Battery percentage.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'battery' } },
  { name: 'mac.wifiStatus', domain: 'system',
    description: 'Current Wi-Fi network.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'wifi-status' } },
  { name: 'mac.diskSpace', domain: 'system',
    description: 'Root disk usage summary.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'disk-space' } },
  { name: 'mac.uptime', domain: 'system',
    description: 'System uptime.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'uptime' } },
  { name: 'mac.topCpu', domain: 'system',
    description: 'Top CPU-consuming processes.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'top-cpu' } },
  { name: 'mac.memoryUsage', domain: 'system',
    description: 'Memory pressure summary.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'memory-usage' } },
  { name: 'mac.ipAddress', domain: 'system',
    description: 'Primary local IP address.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'ip-address' } },

  // ═══════════════════════ MAC SYSTEM CONTROL (toggles) ═══════════════════════
  { name: 'mac.volumeUp', domain: 'control', description: 'Raise output volume ~10%.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'volume-up' } },
  { name: 'mac.volumeDown', domain: 'control', description: 'Lower output volume ~10%.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'volume-down' } },
  { name: 'mac.volumeSet', domain: 'control', description: 'Set output volume to a level (0-100).',
    params: [{ name: 'level', type: 'number', required: true }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'volume-set' } },
  { name: 'mac.volumeMute', domain: 'control', description: 'Mute output.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'volume-mute' } },
  { name: 'mac.volumeUnmute', domain: 'control', description: 'Unmute output.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'volume-unmute' } },
  { name: 'mac.volumeGet', domain: 'control', description: 'Report current volume + mute state.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'volume-get' } },
  { name: 'mac.brightnessUp', domain: 'control', description: 'Increase display brightness.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'brightness-up' } },
  { name: 'mac.brightnessDown', domain: 'control', description: 'Decrease display brightness.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'brightness-down' } },
  { name: 'mac.darkMode', domain: 'control', description: 'Set dark mode on/off.',
    params: [{ name: 'state', type: 'enum', required: true, enum: ['on', 'off'] }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'dark-mode' } },
  { name: 'mac.darkModeToggle', domain: 'control', description: 'Toggle dark mode.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'dark-mode-toggle' } },
  { name: 'mac.wifiToggle', domain: 'control', description: 'Turn Wi-Fi on/off.',
    params: [{ name: 'state', type: 'enum', required: true, enum: ['on', 'off'] }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'wifi-toggle' } },
  { name: 'mac.bluetoothToggle', domain: 'control', description: 'Turn Bluetooth on/off (needs blueutil).',
    params: [{ name: 'state', type: 'enum', required: true, enum: ['on', 'off'] }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'bluetooth-toggle' } },
  { name: 'mac.dndOn', domain: 'control', description: 'Turn on Focus / Do Not Disturb (Shortcut).', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'dnd-on' } },
  { name: 'mac.dndOff', domain: 'control', description: 'Turn off Focus / Do Not Disturb (Shortcut).', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'dnd-off' } },
  { name: 'mac.lock', domain: 'control', description: 'Lock the screen (display sleep).', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'lock' } },
  { name: 'mac.sleep', domain: 'control', description: 'Put the machine to sleep.', params: [],
    side_effect: SIDE_EFFECT.WRITE, confirm: true, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'sleep' },
    note: 'Disruptive system-state change → write.' },
  { name: 'mac.emptyTrash', domain: 'control', description: 'Empty the Trash (permanent delete).', params: [],
    side_effect: SIDE_EFFECT.WRITE, confirm: true, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'empty-trash' },
    // Hard, irreversible delete → ceiling 'never': it ALWAYS asks, "always" is refused.
    permission: { ceiling: 'never' } },
  { name: 'mac.notify', domain: 'control', description: 'Show a macOS notification banner.',
    params: [{ name: 'message', type: 'string', required: true }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'notify' } },
  { name: 'mac.say', domain: 'control', description: 'Speak text with the macOS `say` command.',
    params: [{ name: 'text', type: 'string', required: true }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'say' } },
  { name: 'mac.shell', domain: 'control', description: 'Run an arbitrary shell command.',
    params: [{ name: 'command', type: 'string', required: true }],
    side_effect: SIDE_EFFECT.WRITE, confirm: true, planner_safe: false,
    executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'shell' },
    note: 'Arbitrary code execution → always write. planner_safe:false — usable by direct command, never composable into a plan.' },

  // ═══════════════════════ MEDIA / MUSIC ═══════════════════════
  { name: 'media.playPause', domain: 'media', description: 'Toggle play/pause (media key).', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'play-pause' } },
  { name: 'media.nextTrack', domain: 'media', description: 'Next track (media key).', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'next-track' } },
  { name: 'media.prevTrack', domain: 'media', description: 'Previous track (media key).', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'prev-track' } },
  { name: 'spotify.play', domain: 'media', description: 'Spotify play.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'spotify-play' } },
  { name: 'spotify.pause', domain: 'media', description: 'Spotify pause.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'spotify-pause' } },
  { name: 'spotify.next', domain: 'media', description: 'Spotify next track.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'spotify-next' } },
  { name: 'spotify.prev', domain: 'media', description: 'Spotify previous track.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'spotify-prev' } },
  { name: 'spotify.current', domain: 'media', description: 'Name + artist of the current Spotify track.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'spotify-current' } },

  // ═══════════════════════ BROWSER (Google Chrome) ═══════════════════════
  { name: 'browser.open', domain: 'browser', description: 'Open a URL in Chrome.',
    params: [{ name: 'url', type: 'string', required: true }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'browser-action', action: 'open' } },
  { name: 'browser.search', domain: 'browser', description: 'Google search in Chrome.',
    params: [{ name: 'query', type: 'string', required: true }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'browser-action', action: 'search' } },
  { name: 'browser.youtube', domain: 'browser', description: 'YouTube search in Chrome.',
    params: [{ name: 'query', type: 'string', required: true }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'browser-action', action: 'youtube' } },
  { name: 'browser.bookmark', domain: 'browser',
    description: 'Open a named bookmark (supabase, vercel, github, drive, docs, sheets, calendar, claude, chatgpt, n8n, lovable, notion, slack, twitter, linkedin, suite synq, mellow yellow, revalis, stripe).',
    params: [{ name: 'name', type: 'string', required: true }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'browser-action', action: 'bookmark' },
    note: 'This is the ONLY place "supabase"/"n8n" appear as targets — just a URL, not a query.' },
  { name: 'browser.newTab', domain: 'browser', description: 'Open a new tab/window.',
    params: [{ name: 'which', type: 'string', required: false, desc: "pass 'new'" }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'browser-action', action: 'tab' } },
  { name: 'browser.closeTab', domain: 'browser', description: 'Close the active tab.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'browser-action', action: 'close-tab' } },
  { name: 'browser.closeBrowser', domain: 'browser', description: 'Quit Chrome (graceful).', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'browser-action', action: 'close-browser' } },
  { name: 'browser.nextTab', domain: 'browser', description: 'Switch to the next tab.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'browser-action', action: 'next-tab' } },
  { name: 'browser.prevTab', domain: 'browser', description: 'Switch to the previous tab.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'browser-action', action: 'prev-tab' } },
  { name: 'browser.gotoTab', domain: 'browser', description: 'Switch to tab N (1-indexed).',
    params: [{ name: 'index', type: 'number', required: true }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'browser-action', action: 'goto-tab' } },
  { name: 'browser.back', domain: 'browser', description: 'History back.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'browser-action', action: 'back' } },
  { name: 'browser.forward', domain: 'browser', description: 'History forward.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'browser-action', action: 'forward' } },
  { name: 'browser.refresh', domain: 'browser', description: 'Reload the active tab.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'browser-action', action: 'refresh' } },
  { name: 'browser.readPage', domain: 'browser', description: 'Return active tab title + URL.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'browser-action', action: 'read-page' } },
  { name: 'browser.listTabs', domain: 'browser', description: 'List titles of open tabs.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'browser-action', action: 'list-tabs' } },
  { name: 'browser.readContent', domain: 'browser', description: 'Extract main text of the active page (~3 KB).', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'browser-action', action: 'read-content' } },
  { name: 'browser.scrollDown', domain: 'browser', description: 'Scroll the page down.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'browser-action', action: 'scroll-down' } },
  { name: 'browser.scrollUp', domain: 'browser', description: 'Scroll the page up.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'browser-action', action: 'scroll-up' } },
  { name: 'browser.scrollTop', domain: 'browser', description: 'Jump to top of page.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'browser-action', action: 'scroll-top' } },
  { name: 'browser.scrollBottom', domain: 'browser', description: 'Jump to bottom of page.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'browser-action', action: 'scroll-bottom' } },
  { name: 'browser.typeInBrowser', domain: 'browser', description: 'Type text into the focused field (keystrokes).',
    params: [{ name: 'text', type: 'string', required: true }],
    side_effect: SIDE_EFFECT.WRITE, confirm: true, executor: EXECUTOR.MAIN, via: { channel: 'browser-action', action: 'type-in-browser' },
    note: 'Can trigger page-side effects (submit) → write.' },
  { name: 'browser.clickLink', domain: 'browser', description: 'Click the first link/button matching text.',
    params: [{ name: 'text', type: 'string', required: true }],
    side_effect: SIDE_EFFECT.WRITE, confirm: true, executor: EXECUTOR.MAIN, via: { channel: 'browser-action', action: 'click-link' },
    note: 'Triggers a page action → write.' },
  { name: 'browser.fillField', domain: 'browser', description: 'Fill a form field matched by label/name/id.',
    params: [
      { name: 'field', type: 'string', required: true },
      { name: 'value', type: 'string', required: true },
    ], side_effect: SIDE_EFFECT.WRITE, confirm: true, executor: EXECUTOR.MAIN, via: { channel: 'browser-action', action: 'fill-field' },
    note: 'Mutates a web form → write.' },

  // ═══════════════════════ REMINDERS / TIMERS / NOTES ═══════════════════════
  { name: 'reminders.list', domain: 'reminders', description: 'Load persisted reminders.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'reminders:load' } },
  { name: 'reminders.save', domain: 'reminders', description: 'Replace the persisted reminders list (data/reminders.json).',
    params: [{ name: 'reminders', type: 'array', required: true }],
    side_effect: SIDE_EFFECT.WRITE, confirm: false, executor: EXECUTOR.MAIN, via: { channel: 'reminders:save' },
    note: 'Whole-list replace; to add one, load → append → save.' },
  // One-at-a-time reminder tools (electron/services/proactive.js) — what Claude uses.
  { name: 'reminders.add', domain: 'reminders',
    description: 'Set a spoken reminder for Fred at a specific local date and time.',
    params: [
      { name: 'message', type: 'string', required: true, desc: 'what to remind him about, e.g. "call Jay about the Mutuele launch"' },
      { name: 'at', type: 'string', required: true, desc: 'local date-time "YYYY-MM-DDTHH:MM" (work it out from the current date/time in the context)' },
    ], side_effect: SIDE_EFFECT.WRITE, confirm: false, executor: EXECUTOR.MAIN,
    via: { channel: 'reminders:add' },
    returns: '{ ok, id, message, when }',
    note: 'Fired aloud by the renderer tick, same as the voice reminder command.' },
  { name: 'reminders.cancel', domain: 'reminders',
    description: 'Cancel an upcoming reminder by id or by words in its message.',
    params: [{ name: 'query', type: 'string', required: true }],
    side_effect: SIDE_EFFECT.WRITE, confirm: false, executor: EXECUTOR.MAIN,
    via: { channel: 'reminders:cancel' },
    returns: '{ ok, cancelled:[{ message, when }] }' },
  { name: 'reminders.upcoming', domain: 'reminders',
    description: 'List the reminders that have not fired yet, soonest first, with readable times.',
    params: [], side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'reminders:upcoming' },
    returns: '{ ok, reminders:[{ id, message, when }] }' },
  { name: 'timers.list', domain: 'timers', description: 'Load persisted timers.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'timers:load' } },
  { name: 'timers.save', domain: 'timers', description: 'Replace the persisted timers list (data/timers.json).',
    params: [{ name: 'timers', type: 'array', required: true }],
    side_effect: SIDE_EFFECT.WRITE, confirm: false, executor: EXECUTOR.MAIN, via: { channel: 'timers:save' } },
  { name: 'notes.list', domain: 'notes', description: 'Load persisted notes (data/notes.json).', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'notes:load' } },
  { name: 'notes.save', domain: 'notes', description: 'Replace the persisted notes list (data/notes.json).',
    params: [{ name: 'notes', type: 'array', required: true }],
    side_effect: SIDE_EFFECT.WRITE, confirm: false, executor: EXECUTOR.MAIN, via: { channel: 'notes:save' },
    note: 'Dictation/notes also get dual-written to Qdrant in the renderer (see memory.store).' },

  // ═══════════════════════ CLIPBOARD ═══════════════════════
  { name: 'clipboard.get', domain: 'clipboard', description: 'Read the macOS clipboard (pbpaste).', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'mac-control', action: 'clipboard-get' } },
  { name: 'clipboard.set', domain: 'clipboard', description: 'Write text to the macOS clipboard (pbcopy).',
    params: [{ name: 'text', type: 'string', required: true }],
    side_effect: SIDE_EFFECT.READ, confirm: false, executor: EXECUTOR.MAIN, via: { channel: 'clipboard:set' },
    note: 'Clipboard is ephemeral scratch, so this stays read (no confirmation needed). A duplicate shell-based path exists as mac-control clipboard-set.' },

  // ═══════════════════════ COMPOSE (LLM text generation) ═══════════════════════
  { name: 'text.compose', domain: 'language',
    description: 'Draft text with the LLM from a context + instruction (e.g. an email reply body).',
    params: [
      { name: 'instruction', type: 'string', required: true, desc: 'what to write' },
      { name: 'context', type: 'string', required: false, desc: 'source material, often a {{N.path}} from an earlier read' },
    ], side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'text:compose' },
    returns: '{ ok, text }  (the drafted text is at .text)',
    note: 'READ-ONLY: pure text generation whose output FILLS a later param (e.g. mail.send body). '
      + 'It never sends anything — the gate still sits between the draft and any write that uses it.' },

  // ═══════════════════════ TRANSLATION ═══════════════════════
  { name: 'translate.text', domain: 'language',
    description: 'Translate text into a target language via the fast Ollama model.',
    params: [
      { name: 'text', type: 'string', required: true },
      { name: 'language', type: 'string', required: true, desc: 'e.g. dutch, french, english, spanish, german' },
    ], side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.RENDERER,
    via: { module: 'src/voice-controller.js', fn: 'translate' },
    note: 'Pure text transform (LLM call) → read.' },

  // ═══════════════════════ LONG-TERM MEMORY (Qdrant) ═══════════════════════
  { name: 'memory.query', domain: 'memory',
    description: 'Semantic search over the hannibal_memory Qdrant collection.',
    params: [
      { name: 'text', type: 'string', required: true },
      { name: 'limit', type: 'number', required: false, desc: 'default 3' },
    ], side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.RENDERER,
    via: { module: 'src/voice-controller.js', fn: 'queryMemory' },
    returns: '{ ok, results:[{ text, score }] }',
    note: 'Embeds via Ollama nomic-embed-text, searches Qdrant at gex131-1:6333 (768-dim, cosine).' },
  { name: 'memory.store', domain: 'memory',
    description: 'Embed and store a memory in the hannibal_memory Qdrant collection.',
    params: [
      { name: 'text', type: 'string', required: true },
      { name: 'metadata', type: 'object', required: false },
    ], side_effect: SIDE_EFFECT.WRITE, confirm: false, executor: EXECUTOR.RENDERER,
    via: { module: 'src/voice-controller.js', fn: 'storeMemory' } },
  // Saved FACTS (electron/services/memory-facts.js): short lasting facts that ride
  // in Claude's system prompt every turn — people, projects, preferences, decisions.
  { name: 'memory.remember', domain: 'memory',
    description: "Save one lasting fact about Fred's world (a person, project, preference, decision, place or routine) so Hannibal always knows it.",
    params: [
      { name: 'fact', type: 'string', required: true, desc: 'one short, self-contained fact, e.g. "HTS is a hotel group and Revalis Hospitality\'s first client"' },
      { name: 'category', type: 'enum', required: false, enum: ['person', 'project', 'preference', 'decision', 'place', 'routine', 'other'] },
    ], side_effect: SIDE_EFFECT.WRITE, confirm: false, executor: EXECUTOR.MAIN,
    via: { channel: 'facts:remember' },
    returns: '{ ok, id, duplicate? }',
    note: 'Local data/memory-facts.json. A near-identical fact is updated, not duplicated.' },
  { name: 'memory.forget', domain: 'memory',
    description: 'Remove saved facts, by id (e.g. "f12") or by words they contain.',
    params: [{ name: 'query', type: 'string', required: true }],
    side_effect: SIDE_EFFECT.WRITE, confirm: false, executor: EXECUTOR.MAIN,
    via: { channel: 'facts:forget' },
    returns: '{ ok, removed:[{ id, text }] }  (refuses if more than 5 facts match)' },
  // Past CONVERSATIONS (electron/services/conversation-journal.js): a summarized
  // diary of every stretch of conversation, desk and phone.
  { name: 'memory.conversations', domain: 'memory',
    description: 'Search past conversations with Fred (desk, phone and Telegram) by person, project or topic; returns when it was, a summary, and what was left open.',
    params: [
      { name: 'query', type: 'string', required: true, desc: 'names, projects or topic words, e.g. "Jay Mutuele launch"' },
      { name: 'limit', type: 'number', required: false, desc: 'default 5' },
    ], side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'journal:search' },
    returns: '{ ok, count, conversations:[{ when, where, title, summary, people, projects, open }] }' },
  { name: 'memory.facts', domain: 'memory',
    description: 'List the saved facts, optionally one category.',
    params: [{ name: 'category', type: 'enum', required: false, enum: ['person', 'project', 'preference', 'decision', 'place', 'routine', 'other'] }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'facts:list' },
    returns: '{ ok, count, facts:[{ id, category, text }] }' },

  // ═══════════════════════ VOICE / TTS ═══════════════════════
  { name: 'voice.tts', domain: 'voice',
    description: 'Synthesize speech (nova-tts.py) and return MP3 bytes to the renderer.',
    params: [{ name: 'text', type: 'string', required: true }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'voice:tts' } },
  { name: 'voice.config', domain: 'voice',
    description: 'Return runtime config (whisper/ollama URLs + model ids).', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'voice:config' },
    note: 'Metadata accessor; how the renderer learns the fast/heavy/vision model ids.' },

  // ═══════════════════════ SKILLS (user-taught) ═══════════════════════
  { name: 'skills.list', domain: 'skills', description: 'Load the taught-skill library (data/skills.json).', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'skills:load' } },
  { name: 'skills.save', domain: 'skills', description: 'Replace the taught-skill library.',
    params: [{ name: 'skills', type: 'array', required: true }],
    side_effect: SIDE_EFFECT.WRITE, confirm: false, executor: EXECUTOR.MAIN, via: { channel: 'skills:save' } },
  { name: 'skills.execute', domain: 'skills',
    description: 'Run a taught skill (its shell command with ${ENV} substituted).',
    params: [{ name: 'skill', type: 'object', required: true, desc: 'skill object with a .command field' }],
    side_effect: SIDE_EFFECT.WRITE, confirm: true, planner_safe: false,
    executor: EXECUTOR.MAIN, via: { channel: 'skills:execute' },
    note: 'Runs arbitrary shell (30s timeout, env-substituted) → write. planner_safe:false — usable by direct command, never composable into a plan.' },

  // ═══════════════════════ CONFIG / LEARNING STORES ═══════════════════════
  { name: 'aliases.load', domain: 'config', description: 'Load Whisper-misrecognition aliases.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'aliases:load' } },
  { name: 'aliases.save', domain: 'config', description: 'Replace aliases (data/aliases.json).',
    params: [{ name: 'data', type: 'object', required: true, desc: '{ names, commands }' }],
    side_effect: SIDE_EFFECT.WRITE, confirm: false, executor: EXECUTOR.MAIN, via: { channel: 'aliases:save' } },
  { name: 'preferences.load', domain: 'config', description: 'Load learned response/style/model preferences.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'preferences:load' } },
  { name: 'preferences.save', domain: 'config', description: 'Replace preferences (data/preferences.json).',
    params: [{ name: 'data', type: 'object', required: true }],
    side_effect: SIDE_EFFECT.WRITE, confirm: false, executor: EXECUTOR.MAIN, via: { channel: 'preferences:save' } },
  { name: 'personality.load', domain: 'config', description: 'Load Hannibal personality + relationship + mood.', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'personality:load' } },
  { name: 'personality.save', domain: 'config', description: 'Replace personality (data/personality.json).',
    params: [{ name: 'data', type: 'object', required: true }],
    side_effect: SIDE_EFFECT.WRITE, confirm: false, executor: EXECUTOR.MAIN, via: { channel: 'personality:save' } },
  { name: 'behavior.list', domain: 'config', description: 'Load the behavior log (command history).', params: [],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'behavior:list' } },
  { name: 'behavior.log', domain: 'config', description: 'Append a command to the behavior log (data/behavior-log.json).',
    params: [{ name: 'command', type: 'string', required: true }],
    side_effect: SIDE_EFFECT.WRITE, confirm: false, executor: EXECUTOR.MAIN, via: { channel: 'behavior:log' } },

  // ═══════════════════════ WORLD AWARENESS ═══════════════════════
  { name: 'world.read', domain: 'world',
    description: "What's happening with a world topic: opens the WorldMonitor view AND returns one spoken, filtered read. Topics: crypto, markets, news, a region (middle-east/europe/asia-pacific/africa/latin-america/us), energy, government, conflict, flights, weather.",
    params: [{ name: 'topic', type: 'string', required: true, desc: 'spoken topic or topic key; the Stage-2 router resolves it and declines unknowns' }],
    side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'world:read' },
    returns: '{ ok, topic, label, narration, worldRead:{ topic, headline, signals[], detail[], asOf, sourceView }, viewOpened, asOf, degraded, declined? }',
    note: 'Dual-dispatch (eyes+ears): opens the topic view (desktop app by default) + reads live numbers over Tailscale from the self-hosted WorldMonitor on GEX131 (+ Open-Meteo for weather). '
      + 'Read-only — never invents a figure; says plainly if a feed is unreachable or the topic is untracked. '
      + 'Lives in electron/services/world/ (source → world-read normalizer → router → world-narrator). Nothing downstream knows the source is WorldMonitor.' },
  { name: 'world.crypto', domain: 'world',
    description: "What's happening with crypto: opens the WorldMonitor crypto/finance view AND returns one spoken, filtered read (prices + mood + stablecoin peg health).",
    params: [], side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN,
    via: { channel: 'world:crypto' },
    returns: '{ ok, topic, narration, worldRead:{ topic, headline, signals[], detail[], asOf, sourceView }, viewOpened, asOf, degraded }',
    note: 'Dual-dispatch (eyes+ears): opens the finance view like any URL + reads live numbers over Tailscale from the self-hosted WorldMonitor on GEX131. '
      + 'Read-only — never invents a figure; says plainly if a feed is unreachable. Crypto topic is hard-coded in Stage 1; the topic router is Stage 2. '
      + 'Lives in electron/services/world/ (source → world-read normalizer → world-narrator). Nothing downstream knows the source is WorldMonitor.' },

  // ═══════════════════════ CLAUDE CODE SESSIONS ═══════════════════════
  { name: 'cc.getSessions', domain: 'agents',
    description: 'Snapshot of live Claude Code sessions tracked by the cc-ingest listener.',
    params: [], side_effect: SIDE_EFFECT.READ, executor: EXECUTOR.MAIN, via: { channel: 'cc:getSessions' },
    note: 'Populated by inbound n8n→cc-ingest events; this is a read of that in-memory state.' },
];

// ─────────────────────────── accessors ───────────────────────────
function getTool(name) { return TOOLS.find((t) => t.name === name) || null; }
function byDomain(domain) { return TOOLS.filter((t) => t.domain === domain); }
function bySideEffect(se) { return TOOLS.filter((t) => t.side_effect === se); }
function readTools() { return bySideEffect(SIDE_EFFECT.READ); }
function writeTools() { return bySideEffect(SIDE_EFFECT.WRITE); }
function isWrite(name) { const t = getTool(name); return !!t && t.side_effect === SIDE_EFFECT.WRITE; }
function toolNames() { return TOOLS.map((t) => t.name); }
// Tools the Planner is allowed to compose (planner_safe !== false).
function plannerTools() { return TOOLS.filter((t) => t.planner_safe !== false); }
// Whether Stage 4's gate must prompt before this tool runs.
function confirmRequired(name) { const t = getTool(name); return !!t && t.confirm === true; }

// Pretty-print the whole catalog (used by `node catalog.js` and Stage-1 verification).
function printCatalog() {
  const pad = (s, n) => String(s).padEnd(n);
  const groups = [...new Set(TOOLS.map((t) => t.domain))];
  const writes = writeTools();
  const confirmYes = writes.filter((t) => t.confirm === true).length;
  const confirmNo = writes.filter((t) => t.confirm === false).length;
  const unsafe = TOOLS.filter((t) => t.planner_safe === false);
  let out = `TOOL CATALOG — ${TOOLS.length} tools `
    + `(${readTools().length} read, ${writes.length} write)\n`
    + `  writes needing confirmation: ${confirmYes}  ·  housekeeping (no confirm): ${confirmNo}\n`
    + `  planner-safe: ${plannerTools().length}  ·  planner-EXCLUDED: ${unsafe.map((t) => t.name).join(', ') || 'none'}\n`
    + `  legend: [WRITE+C] = confirm before run · [WRITE  ] = housekeeping · [read ] = safe · ⚠ = not planner-composable\n`;
  for (const g of groups) {
    out += `\n── ${g.toUpperCase()} ──\n`;
    for (const t of byDomain(g)) {
      const flag = t.side_effect === SIDE_EFFECT.WRITE
        ? (t.confirm === true ? 'WRITE+C' : 'WRITE  ')
        : 'read   ';
      const mark = t.planner_safe === false ? ' ⚠' : '  ';
      const ps = t.params.map((p) => p.required ? p.name : `${p.name}?`).join(', ');
      out += ` [${flag}]${mark} ${pad(t.name, 26)} ${pad(t.executor, 18)} (${ps})\n`;
      out += `            ${t.description}\n`;
    }
  }
  return out;
}

// Honest record of what does NOT exist as a callable action (so nobody re-discovers it).
const NOTES = {
  supabase: 'No Supabase query action exists. "supabase" is only a Chrome bookmark (browser.bookmark). '
    + 'Nothing authenticates to or reads from a Supabase project.',
  n8n: 'n8n is inbound-only. electron/services/cc-ingest.js receives Claude Code session events pushed '
    + 'FROM n8n; Hannibal never calls out to an n8n workflow. cc.getSessions reads that received state.',
  executors_in_catalog: 'Tools run in electron-main (most), electron-renderer (memory.* + translate.text), '
    + 'or over ssh (gex131.metrics). There are zero n8n-executed tools.',
};

module.exports = {
  TOOLS, SIDE_EFFECT, EXECUTOR, NOTES,
  getTool, byDomain, bySideEffect, readTools, writeTools, isWrite, toolNames,
  plannerTools, confirmRequired, printCatalog,
};

// `node electron/services/agent/catalog.js` prints the catalog (no app needed).
if (require.main === module) { process.stdout.write(printCatalog()); }
