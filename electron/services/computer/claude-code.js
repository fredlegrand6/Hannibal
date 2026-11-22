// "Put this in Claude Code" — find Fred's Claude Code session, make sure it is
// idle, paste the brief, send it and check it really arrived.
//
// Where Claude Code runs, in order of preference:
//   1. the Claude desktop app (its Code view): found through the accessibility
//      tree — the prompt box ("Write your prompt to Claude") and the button next
//      to it, which reads "Send" when idle and "Stop" while Claude is working;
//   2. Terminal / iTerm2 tabs whose process is `claude`: found with AppleScript;
//      busy while the screen shows "esc to interrupt".
// More than one session and no `session` given → Fred is asked which one.
//
// deps: { hands, osa(script) → stdout, sh(cmd) → stdout, paste(text) → {ok}, sleep(ms), aborted() }
'use strict';
const { norm } = require('./text-match');

const DESKTOP_BUNDLE = 'com.anthropic.claudefordesktop';
const PROMPT_BOX = /write your prompt to claude|ask claude|message claude|reply to claude/i;

// ── pure helpers (tested) ──────────────────────────────────────────────────

// Claude Code's terminal UI shows "esc to interrupt" while it works.
function terminalBusy(contents) {
  const tail = String(contents || '').split('\n').slice(-25).join('\n');
  return /esc to interrupt|esc to cancel|\binterrupt\b.*\besc\b/i.test(tail);
}

// From the desktop app's AX dump: each prompt box with the button beside it.
// → [{ box, button:'send'|'stop'|null, busy }]
function desktopComposers(items) {
  const boxes = (items || []).filter((it) => it.role === 'AXTextArea' && it.frame && it.frame.w > 20
    && PROMPT_BOX.test(`${it.description} ${it.title} ${it.placeholder}`));
  const buttons = (items || []).filter((it) => it.role === 'AXButton' && it.frame && /^(send|stop|stop response|interrupt|cancel)$/i.test(String(it.title || it.description || '').trim()));
  return boxes.map((box) => {
    const near = buttons.filter((b) => Math.abs((b.frame.y + b.frame.h / 2) - (box.frame.y + box.frame.h / 2)) < 40
      && b.frame.x > box.frame.x && b.frame.x - (box.frame.x + box.frame.w) < 260)
      .sort((a, b) => a.frame.x - b.frame.x);
    const label = near.length ? String(near[0].title || near[0].description).toLowerCase() : '';
    const busy = near.some((b) => /stop|interrupt|cancel/i.test(String(b.title || b.description)));
    return { box, button: label ? (busy ? 'stop' : 'send') : null, busy, kind: /prompt/i.test(box.description || box.title) ? 'prompt' : 'reply' };
  });
}

// Sidebar entries of the desktop app: "hannibal, Running" → { name:'hannibal', running:true }
function desktopSessions(items) {
  return (items || []).filter((it) => it.role === 'AXButton' && it.frame && it.frame.x < 260 && it.frame.h > 8)
    .map((it) => {
      const raw = String(it.title || it.description || '').trim();
      const m = raw.match(/^(.*?),\s*(running|waiting|working|bezig)\b/i);
      return { name: (m ? m[1] : raw).trim(), running: !!m, frame: it.frame, raw };
    })
    .filter((s) => s.name && !/^(new|search|plugins|projects|artifacts|scheduled|pinned|help|hide sidebar|back|forward)\b/i.test(s.name) && !/^new session in /i.test(s.raw));
}

// Terminal listing lines "winId\ttabIndex\ttty\tbusy\ttitle" → objects.
function parseTerminalList(stdout, app = 'Terminal') {
  return String(stdout || '').split('\n').map((l) => l.split('\t')).filter((p) => p.length >= 4 && p[2])
    .map(([win, tab, tty, busy, ...title]) => ({ app, win: win.trim(), tab: tab.trim(), tty: tty.trim().replace(/^\/dev\//, ''), title: title.join(' ').trim() }));
}

// Which session does Fred mean? → { pick } | { choose:[labels] } | { none:true }
function pickSession(cands, wanted) {
  if (!cands.length) return { none: true };
  if (wanted) {
    const w = norm(wanted);
    const byIndex = /^\d+$/.test(String(wanted).trim()) ? cands[parseInt(wanted, 10) - 1] : null;
    if (byIndex) return { pick: byIndex };
    const hits = cands.filter((c) => norm(c.label).includes(w));
    if (hits.length === 1) return { pick: hits[0] };
    if (hits.length > 1) return { choose: hits.map((c, i) => `${i + 1}. ${c.label}`) };
    return { choose: cands.map((c, i) => `${i + 1}. ${c.label}`), notFound: wanted };
  }
  if (cands.length === 1) return { pick: cands[0] };
  return { choose: cands.map((c, i) => `${i + 1}. ${c.label}`) };
}

// Did the pasted text land / get sent? Compare a short, distinctive prefix.
function probe(text) {
  const first = String(text || '').split('\n').map((l) => l.trim()).find((l) => l.length >= 3) || String(text || '').trim();
  return first.slice(0, 40);
}
function appears(hay, text) {
  const p = norm(probe(text));
  if (!p) return false;
  const h = norm(hay);
  return h.includes(p.slice(0, Math.min(p.length, 24))) || /pasted text|pasted \d+ lines|\[pasted/i.test(String(hay || ''));
}

// ── finding sessions on the Mac ────────────────────────────────────────────

async function running(deps, name) {
  const out = await deps.osa(`tell application "System Events" to return (exists (first process whose name is "${name}"))`).catch(() => 'false');
  return /true/.test(out);
}

async function desktopCandidates(deps) {
  const pidOut = await deps.sh(`/usr/bin/pgrep -f '/Applications/Claude.app/Contents/MacOS/Claude$' | head -1`).catch(() => '');
  const pid = parseInt(String(pidOut).trim(), 10);
  if (!pid) return [];
  // The first walk only switches on Chromium's accessibility tree; the second reads it.
  let r = await deps.hands.call('dump', { pid, roles: ['AXButton', 'AXTextArea'], ms: 4000, max: 30000 }, 9000);
  if (!desktopComposers(r.items).length) { await deps.sleep(700); r = await deps.hands.call('dump', { pid, roles: ['AXButton', 'AXTextArea'], ms: 4000, max: 30000 }, 9000); }
  const comps = desktopComposers(r.items).filter((c) => c.kind === 'prompt');
  const sessions = desktopSessions(r.items);
  if (!comps.length) return [];
  const runningOne = sessions.find((s) => s.running);
  return comps.map((c) => ({
    where: 'desktop', pid, composer: c, sessions,
    label: `Claude desktop app${runningOne ? ` (${runningOne.name} is running)` : ''}`,
  }));
}

const TERMINAL_LIST = `tell application "Terminal"
  set out to ""
  repeat with w in windows
    repeat with t in tabs of w
      set out to out & (id of w) & tab & (index of t) & tab & (tty of t) & tab & (busy of t) & tab & (name of w) & linefeed
    end repeat
  end repeat
  return out
end tell`;
const ITERM_LIST = `tell application "iTerm2"
  set out to ""
  repeat with w in windows
    set ti to 0
    repeat with t in tabs of w
      set ti to ti + 1
      repeat with s in sessions of t
        set out to out & (id of w) & tab & ti & "/" & (id of s) & tab & (tty of s) & tab & "x" & tab & (name of s) & linefeed
      end repeat
    end repeat
  end repeat
  return out
end tell`;

async function terminalCandidates(deps) {
  const found = [];
  for (const [app, script] of [['Terminal', TERMINAL_LIST], ['iTerm2', ITERM_LIST]]) {
    if (!(await running(deps, app))) continue;
    const list = parseTerminalList(await deps.osa(script).catch(() => ''), app);
    for (const t of list) {
      const ps = await deps.sh(`/bin/ps -t ${t.tty.replace(/[^a-z0-9]/gi, '')} -o comm= 2>/dev/null`).catch(() => '');
      if (/(^|\/)claude(\s|$)/m.test(ps) || /\bclaude\b/i.test(t.title)) found.push({ where: 'terminal', ...t, label: `${app}: ${t.title || t.tty}` });
    }
  }
  return found;
}

async function terminalContents(deps, c) {
  if (c.app === 'Terminal') return deps.osa(`tell application "Terminal" to return contents of tab ${Number(c.tab)} of (first window whose id is ${Number(c.win)})`).catch(() => '');
  const sid = String(c.tab).split('/')[1];
  return deps.osa(`tell application "iTerm2"\nrepeat with w in windows\nrepeat with t in tabs of w\nrepeat with s in sessions of t\nif (id of s) is "${sid.replace(/"/g, '')}" then return contents of s\nend repeat\nend repeat\nend repeat\nend tell`).catch(() => '');
}
async function focusTerminal(deps, c) {
  if (c.app === 'Terminal') {
    await deps.osa(`tell application "Terminal"\nset w to (first window whose id is ${Number(c.win)})\nset selected of tab ${Number(c.tab)} of w to true\nset index of w to 1\nactivate\nend tell`);
  } else {
    const sid = String(c.tab).split('/')[1].replace(/"/g, '');
    await deps.osa(`tell application "iTerm2"\nactivate\nrepeat with w in windows\nrepeat with t in tabs of w\nrepeat with s in sessions of t\nif (id of s) is "${sid}" then\nselect w\nselect t\nselect s\nend if\nend repeat\nend repeat\nend repeat\nend tell`);
  }
}

async function desktopState(deps, pid) {
  const r = await deps.hands.call('dump', { pid, roles: ['AXButton', 'AXTextArea', 'AXStaticText'], ms: 4000, max: 30000 }, 9000);
  const comps = desktopComposers(r.items).filter((c) => c.kind === 'prompt');
  const text = (r.items || []).filter((it) => it.role === 'AXStaticText').map((it) => it.value || it.title || '').join('\n');
  return { composer: comps[0] || null, text };
}

// ── the shortcut ────────────────────────────────────────────────────────────
// → { ok, verified, where, session, busy?, choose?, message }
async function pasteToClaudeCode(deps, { text, session, wait_seconds: waitS } = {}) {
  const body = String(text || '');
  if (!body.trim()) return { ok: false, error: 'nothing to paste' };
  const cands = [...await desktopCandidates(deps), ...await terminalCandidates(deps)];
  const choice = pickSession(cands, session);
  if (choice.none) return { ok: false, error: 'No Claude Code session found: not in the Claude desktop app (open its Code view) and no Terminal or iTerm tab running claude.' };
  if (!choice.pick) {
    return { ok: false, needs_choice: true, sessions: choice.choose,
      message: `${choice.notFound ? `No session matched "${choice.notFound}". ` : ''}There are several Claude Code sessions. Ask Fred which one, then call again with session set to its number or name.` };
  }
  const c = choice.pick;
  const waitMs = Math.max(0, Math.min(900, Number(waitS) || 0)) * 1000;

  // 1. idle?
  const isBusy = async () => (c.where === 'desktop'
    ? !!((await desktopState(deps, c.pid)).composer || {}).busy
    : terminalBusy(await terminalContents(deps, c)));
  let busy = c.where === 'desktop' ? !!c.composer.busy : terminalBusy(await terminalContents(deps, c));
  const t0 = Date.now();
  while (busy && Date.now() - t0 < waitMs) {
    if (deps.aborted()) return { ok: false, stopped: true, error: 'Fred said stop' };
    await deps.sleep(2000);
    busy = await isBusy();
  }
  if (busy) {
    return { ok: false, busy: true, session: c.label,
      message: waitMs ? `Claude Code was still busy after ${Math.round(waitMs / 1000)} seconds, so nothing was pasted.`
        : 'Claude Code is busy with a task right now, so nothing was pasted. Tell Fred it is busy and that you will wait, then call again with wait_seconds (e.g. 300).' };
  }
  if (deps.aborted()) return { ok: false, stopped: true, error: 'Fred said stop' };

  // 2. focus the prompt box
  if (c.where === 'desktop') {
    await deps.hands.call('raise', { pid: c.pid, title: '' });
    await deps.sleep(250);
    const f = c.composer.box.frame;
    await deps.hands.call('click', { x: f.x + Math.min(40, f.w / 2), y: f.y + f.h / 2, button: 'left', count: 1 });
  } else {
    await focusTerminal(deps, c);
  }
  await deps.sleep(350);

  // 3. paste and check it is in the box before sending
  const before = c.where === 'desktop' ? '' : await terminalContents(deps, c);
  const p = await deps.paste(body);
  if (!p || !p.ok) return { ok: false, error: `paste failed: ${(p && p.error) || 'unknown'}` };
  await deps.sleep(600);
  let landed;
  if (c.where === 'desktop') {
    const st = await desktopState(deps, c.pid);
    landed = !!(st.composer && appears(st.composer.box.value, body));
  } else {
    const now = await terminalContents(deps, c);
    landed = appears(now.slice(Math.max(0, now.length - 6000)), body) && now !== before;
  }
  if (!landed) return { ok: false, verified: false, session: c.label, error: 'The text did not show up in the Claude Code prompt, so it was NOT sent. Look at the screen (computer.screen) before trying again.' };
  if (deps.aborted()) return { ok: false, stopped: true, error: 'Fred said stop (the text is in the prompt box but was not sent)' };

  // 4. send and verify
  await deps.hands.call('key', { code: 36, mods: [] });
  let verified = false, how = '';
  for (let i = 0; i < 8 && !verified; i++) {
    await deps.sleep(700);
    if (c.where === 'desktop') {
      const st = await desktopState(deps, c.pid);
      const boxEmpty = st.composer && !appears(st.composer.box.value, body);
      if (boxEmpty && (st.composer.busy || appears(st.text, body))) { verified = true; how = st.composer.busy ? 'prompt box emptied and Claude Code started working' : 'the brief shows in the conversation'; }
    } else {
      const now = await terminalContents(deps, c);
      if (terminalBusy(now)) { verified = true; how = 'Claude Code started working on it'; }
    }
  }
  return { ok: true, verified, where: c.where, session: c.label,
    message: verified ? `Sent to Claude Code (${c.label}); checked: ${how}.` : 'Pressed Enter, but could not confirm Claude Code picked it up. Look at the screen before telling Fred it is done.' };
}

module.exports = { pasteToClaudeCode, terminalBusy, desktopComposers, desktopSessions, parseTerminalList, pickSession, appears, probe, DESKTOP_BUNDLE };
