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

  // Every step is logged (deps.log) and returned in `steps`, so a failure says
  // exactly where it stopped: activate, focus, paste, verify or send.
  const steps = [];
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const step = (name, ok, info) => { const e = { step: name, ok: !!ok }; if (info) e.info = String(info).slice(0, 200); steps.push(e); try { log(name, !!ok, info || '', c.label); } catch (_) {} };
  const fail = (name, error, extra = {}) => ({ ok: false, verified: false, session: c.label, failed_step: name, steps, error, ...extra });
  const stoppedNow = (note) => ({ ok: false, stopped: true, session: c.label, steps, error: `Fred said stop${note ? ` (${note})` : ''}` });
  const POLL = Math.max(10, Number(deps.pollMs) || 150);
  // Poll fn() until it gives something truthy, for about `ms`.
  async function waitFor(fn, ms) {
    const n = Math.max(1, Math.ceil(ms / POLL));
    for (let i = 0; i <= n; i++) {
      if (deps.aborted()) return null;
      const v = await fn();
      if (v) return v;
      if (i < n) await deps.sleep(POLL);
    }
    return null;
  }
  let sent = false;   // Enter is pressed at most once per call, ever

  if (c.where === 'desktop') {
    const isBox = (el, frame) => {
      if (!el || !/^AXText(Area|Field)$/.test(el.role || '')) return false;
      if (PROMPT_BOX.test(`${el.description || ''} ${el.title || ''} ${el.placeholder || ''}`)) return true;
      const f = el.frame;
      return !!(f && frame && f.x < frame.x + frame.w && frame.x < f.x + f.w && f.y < frame.y + frame.h && frame.y < f.y + f.h);
    };
    let boxFrame = c.composer.box.frame;
    // Is Claude in front with its prompt box focused? → 'yes' | 'unknown' (no AX focus info) | reason string
    const focusState = async () => {
      const fo = await deps.hands.call('focused').catch(() => ({}));
      if (Number(fo.pid) !== Number(c.pid)) return `${fo.app || 'another app'} is in front, not Claude`;
      if (!fo.element || !fo.element.role) return 'unknown';
      return isBox(fo.element, boxFrame) ? 'yes' : `the focus is on ${fo.element.role}${fo.element.description ? ` “${fo.element.description}”` : ''}, not the prompt box`;
    };

    // 2. bring Claude to the front and WAIT until it really is frontmost
    const activate = async () => {
      await deps.osa(`tell application id "${DESKTOP_BUNDLE}" to activate`).catch(() => '');
      await deps.hands.call('raise', { pid: c.pid, title: '' }).catch(() => ({}));
      let last = {};
      const fr = await waitFor(async () => { last = await deps.hands.call('front').catch(() => ({})); return Number(last.pid) === Number(c.pid) ? last : null; }, 3000);
      if (deps.aborted()) return 'stopped';
      step('activate', !!fr, fr ? '' : `${last.app || 'another app'} stayed in front`);
      return fr ? null : `Could not bring the Claude app to the front (${last.app || 'another app'} stayed in front), so nothing was pasted.`;
    };
    // 3. click into the prompt box until it has the focus (fresh frame each time)
    const focus = async () => {
      let why = '';
      for (let attempt = 1; attempt <= 3; attempt++) {
        const st = await desktopState(deps, c.pid).catch(() => ({}));
        if (st.composer) boxFrame = st.composer.box.frame;
        if (deps.aborted()) return 'stopped';
        await deps.hands.call('click', { x: boxFrame.x + Math.min(40, boxFrame.w / 2), y: boxFrame.y + boxFrame.h / 2, button: 'left', count: 1 });
        const got = await waitFor(async () => { const s = await focusState(); why = s; return s === 'yes' || s === 'unknown' ? s : null; }, 1500);
        if (deps.aborted()) return 'stopped';
        if (got) { step('focus', true, `${got === 'unknown' ? 'Claude in front (focus not reported)' : 'prompt box focused'}${attempt > 1 ? `, after ${attempt} clicks` : ''}`); return null; }
      }
      step('focus', false, why);
      return `Could not put the cursor in the Claude Code prompt box (${why}), so nothing was pasted.`;
    };
    // Safety re-check (as in every computer action): right before a keystroke,
    // Claude must still be in front with the prompt box focused.
    const guard = async (what) => {
      const s = await focusState();
      if (s === 'yes' || s === 'unknown') return null;
      step(`guard:${what}`, false, s);
      return `Stopped before ${what}: ${s}. Nothing was ${what === 'send' ? 'sent' : 'pasted'} there.`;
    };
    const read = () => desktopState(deps, c.pid).catch(() => ({}));
    const dupes = (v) => {
      const val = String(v || '');
      const markers = (val.match(/\[pasted text/gi) || []).length;
      const p = norm(probe(body)).slice(0, 24);
      const count = (h) => (p ? norm(h).split(p).length - 1 : 0);
      // more copies than the brief itself holds (its opening may repeat inside it)
      return markers > 1 || count(val) > Math.max(1, count(body));
    };

    let err = await activate();
    if (err === 'stopped') return stoppedNow();
    if (err) return fail('activate', err);
    err = await focus();
    if (err === 'stopped') return stoppedNow();
    if (err) return fail('focus', err);

    // What the conversation looked like before pasting: only NEW evidence counts as "sent".
    const base = await read();
    const baseText = String(base.text || '');
    const sentSince = (st) => !!(st.composer && ((st.composer.busy && !(base.composer && base.composer.busy))
      || (appears(st.text, body) && !appears(baseText, body) && st.text !== baseText)));
    let landed = null;
    for (let attempt = 1; attempt <= 2 && !landed; attempt++) {
      if (attempt === 2) {
        // Before trying again: make sure the first try did not send it already…
        const st = await read();
        if (sentSince(st) && !appears(st.composer.box.value, body)) {
          step('verify', true, 'the first paste had already been sent');
          return { ok: true, verified: true, where: c.where, session: c.label, steps, message: `Sent to Claude Code (${c.label}); checked: it is already in the conversation (not sent twice).` };
        }
        // …then clear the box and paste once more.
        err = await activate();
        if (err === 'stopped') return stoppedNow();
        if (err) return fail('activate', err);
        err = await focus();
        if (err === 'stopped') return stoppedNow();
        if (err) return fail('focus', err);
        err = await guard('clearing the box');
        if (err) return fail('focus', err);
        if (deps.aborted()) return stoppedNow();
        await deps.hands.call('key', { code: 0, mods: ['cmd'] });        // cmd+a
        if (deps.aborted()) return stoppedNow('the box may be selected but nothing was deleted or sent');
        await deps.hands.call('key', { code: 51, mods: [] });            // delete
        await deps.sleep(150);
        step('clear', true, 'emptied the prompt box for a second try');
      }
      if (deps.aborted()) return stoppedNow();
      err = await guard('paste');
      if (err) return fail('focus', err);
      const p = await deps.paste(body);
      if (p && p.stopped) return stoppedNow('nothing was pasted');
      if (!p || !p.ok) { step('paste', false, (p && p.error) || 'unknown'); return fail('paste', `paste failed: ${(p && p.error) || 'unknown'}`); }
      step('paste', true, attempt > 1 ? 'second try' : '');
      // 4. verify: poll up to ~3 s for the text to show in the box
      landed = await waitFor(async () => { const st = await read(); return st.composer && appears(st.composer.box.value, body) ? st : null; }, 3000);
      if (deps.aborted()) return stoppedNow('the text may be in the prompt box but was not sent');
      step('verify', !!landed, landed ? 'text is in the prompt box' : `not in the prompt box after 3 s${attempt === 1 ? ', trying once more' : ''}`);
    }
    if (!landed) return fail('verify', 'The text did not show up in the Claude Code prompt (tried twice), so it was NOT sent. Look at the screen (computer.screen) before trying again.');
    if (dupes(landed.composer.box.value)) { step('verify', false, 'the text is in the box twice'); return fail('verify', 'The text shows up twice in the Claude Code prompt box, so it was NOT sent. Clear the box (or ask Fred) before trying again.'); }
    if (deps.aborted()) return stoppedNow('the text is in the prompt box but was not sent');

    // 5. send (once) and verify
    err = await guard('send');
    if (err) return fail('send', err);
    if (deps.aborted()) return stoppedNow('the text is in the prompt box but was not sent');
    if (sent) return fail('send', 'already sent once');
    sent = true;
    await deps.hands.call('key', { code: 36, mods: [] });
    step('send', true, 'pressed Enter once');
    let how = '';
    const ok = await waitFor(async () => {
      const st = await read();
      const boxEmpty = st.composer && !appears(st.composer.box.value, body);
      if (boxEmpty && (st.composer.busy || appears(st.text, body))) { how = st.composer.busy ? 'prompt box emptied and Claude Code started working' : 'the brief shows in the conversation'; return true; }
      return null;
    }, 5600);
    step('confirm', !!ok, ok ? how : 'could not see it picked up');
    return { ok: true, verified: !!ok, where: c.where, session: c.label, steps,
      message: ok ? `Sent to Claude Code (${c.label}); checked: ${how}.` : 'Pressed Enter, but could not confirm Claude Code picked it up. Look at the screen before telling Fred it is done.' };
  }

  // ── Terminal / iTerm2 ──
  const termFront = async () => { const f = await deps.hands.call('front').catch(() => ({})); return norm(f.app).includes(norm(c.app === 'iTerm2' ? 'iterm' : 'terminal')) ? f : null; };
  const before = await terminalContents(deps, c);
  let landed = false;
  for (let attempt = 1; attempt <= 2 && !landed; attempt++) {
    await focusTerminal(deps, c).catch(() => {});
    const fr = await waitFor(termFront, 3000);
    if (deps.aborted()) return stoppedNow();
    step('activate', !!fr, fr ? '' : `${c.app} did not come to the front`);
    if (!fr) return fail('activate', `Could not bring ${c.app} to the front, so nothing was pasted.`);
    const p = await deps.paste(body);
    if (p && p.stopped) return stoppedNow('nothing was pasted');
    if (!p || !p.ok) { step('paste', false, (p && p.error) || 'unknown'); return fail('paste', `paste failed: ${(p && p.error) || 'unknown'}`); }
    step('paste', true, attempt > 1 ? 'second try' : '');
    let nowText = before;
    landed = !!(await waitFor(async () => { nowText = await terminalContents(deps, c); return appears(nowText.slice(Math.max(0, nowText.length - 6000)), body) && nowText !== before; }, 3000));
    if (deps.aborted()) return stoppedNow('the text may be in the prompt but was not sent');
    step('verify', landed, landed ? 'text is in the prompt' : 'not in the prompt after 3 s');
    // Only paste again if NOTHING arrived (a half-arrived paste is never doubled).
    if (!landed && nowText !== before) return fail('verify', 'Something changed in the terminal but the text is not clearly in the Claude Code prompt, so it was NOT sent. Look at the screen first.');
  }
  if (!landed) return fail('verify', 'The text did not show up in the Claude Code prompt (tried twice), so it was NOT sent. Look at the screen (computer.screen) before trying again.');
  if (deps.aborted()) return stoppedNow('the text is in the prompt but was not sent');
  if (!(await termFront())) { step('guard:send', false, `${c.app} is no longer in front`); return fail('send', `Stopped before sending: ${c.app} is no longer in front.`); }
  if (deps.aborted()) return stoppedNow('the text is in the prompt but was not sent');
  sent = true;
  await deps.hands.call('key', { code: 36, mods: [] });
  step('send', true, 'pressed Enter once');
  const ok = await waitFor(async () => terminalBusy(await terminalContents(deps, c)), 5600);
  step('confirm', !!ok, ok ? 'Claude Code started working on it' : 'could not see it picked up');
  return { ok: true, verified: !!ok, where: c.where, session: c.label, steps,
    message: ok ? `Sent to Claude Code (${c.label}); checked: Claude Code started working on it.` : 'Pressed Enter, but could not confirm Claude Code picked it up. Look at the screen before telling Fred it is done.' };
}

module.exports = { pasteToClaudeCode, terminalBusy, desktopComposers, desktopSessions, parseTerminalList, pickSession, appears, probe, DESKTOP_BUNDLE };
