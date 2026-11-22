// ─────────────────────────────────────────────────────────────────────────
// COMPUTER CONTROL — Hannibal's hands: keyboard + mouse on ANY app on Fred's
// Mac, with eyes (screenshots, OCR, the accessibility tree) to check his work.
//
// Tools (catalog domain "computer", IPC channel 'computer'):
//   computer.screen            look at one display (or all), with the numbers
//                              needed to click on it correctly
//   computer.click             click a spot in the last screenshot of a display
//   computer.clickText         click on-screen text (accessibility first, OCR next)
//   computer.type              type / paste text, optionally into a given app
//   computer.key               key combos ("cmd+v", "enter", "cmd+tab", "esc")
//   computer.scroll            scroll up/down/left/right
//   computer.pasteToClaudeCode find the Claude Code session, wait till idle,
//                              paste, send, verify
//
// LOOP: Claude looks (computer.screen), does ONE action, and every action comes
// back with verified true/false read from the screen afterwards (plus a fresh
// screenshot), so it checks before the next step. Max 25 actions per task.
//
// SAFETY (see safety.js):
//   • preflight() runs before the voice gate for every call. Send / Delete /
//     Pay / Submit / Merge targets, Enter in chat apps and Terminal, cmd+Enter…
//     become confirm-first writes (the SAME yes/no gate as mail and WhatsApp).
//   • System Settings, Keychain and password managers: refused unless Fred
//     explicitly asked (fred_asked_explicitly) and even then confirmed.
//   • passwords / secrets: refused unless Fred explicitly said to type it
//     (secret_ok), confirmed, and masked in the log.
//   • the handler only runs calls that came through preflight (a per-run
//     token): the Ollama planner, the presence loop, taught skills and the
//     phone/server link can't drive the Mac.
//   • STOP: "Hannibal stop" (renderer, see src/drive-stop.js), Esc pressed 3
//     times, or the wake word while driving → abort() at once: the running
//     action is cut, Claude's turn is interrupted, nothing more runs this turn.
//   • a small "Hannibal is driving" pill shows on every display while he acts
//     (hidden from his own screenshots).
//   • every action → data/computer-actions.log (app, action, target, result).
// ─────────────────────────────────────────────────────────────────────────
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const geo = require('./geometry');
const safety = require('./safety');
const keys = require('./keys');
const match = require('./text-match');
const claudeCode = require('./claude-code');

const MAX_ACTIONS = () => parseInt(process.env.HANNIBAL_COMPUTER_MAX_STEPS || '25', 10);
const IDLE_MS = 8000;                 // the pill goes away this long after the last action
const SHOT_MAX_W = 1440;

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));
function runDefault(cmd, args, timeout = 15000) {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 },
    (e, so, se) => (e ? reject(new Error(String(se || e.message).trim().split('\n')[0])) : resolve(String(so || '')))));
}
const asStr = (s) => `"${String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function createComputer(deps = {}) {
  const hands = deps.hands;
  const electron = deps.electron || {};
  const run = deps.run || runDefault;
  const osa = deps.osa || ((script) => run('/usr/bin/osascript', ['-e', script]));
  const sh = deps.sh || ((cmd) => run('/bin/sh', ['-c', cmd]));
  const sleep = deps.sleep || sleepDefault;
  const now = deps.now || Date.now;
  const logFile = deps.logFile || path.join(__dirname, '..', '..', '..', 'data', 'computer-actions.log');
  const onAbort = deps.onAbort || (() => {});
  const onDriving = deps.onDriving || (() => {});
  const indicator = deps.indicator || { show() {}, hide() {} };
  const selfPid = deps.selfPid || process.pid;
  const TOKEN = crypto.randomBytes(16).toString('hex');

  const state = { aborted: false, abortWhy: '', actions: 0, driving: false, idleTimer: null, escTimes: [], busy: 0 };
  const lastShots = new Map();   // display index → { width, height }

  // ── log ──
  function logAction(entry) {
    const line = { at: new Date(now()).toISOString(), ...entry };
    if (line.text != null) line.text = safety.mask(String(line.text)).slice(0, 300);
    if (line.target != null) line.target = safety.mask(String(line.target)).slice(0, 200);
    try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, JSON.stringify(line) + '\n'); } catch (_) {}
  }

  // ── driving state / stop ──
  function setDriving(on) {
    if (state.driving === on) return;
    state.driving = on;
    try { on ? indicator.show() : indicator.hide(); } catch (_) {}
    try { onDriving(on); } catch (_) {}
  }
  function touch() {
    setDriving(true);
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => { if (!state.busy) setDriving(false); }, IDLE_MS);
  }
  function abort(why = 'stop') {
    if (!state.driving && !state.busy) return false;
    state.aborted = true; state.abortWhy = why;
    try { hands && hands.stopTyping(); } catch (_) {}
    if (state.idleTimer) clearTimeout(state.idleTimer);
    setDriving(false);
    logAction({ action: 'STOP', target: why, result: 'aborted' });
    try { onAbort(why); } catch (_) {}
    return true;
  }
  // A new request from Fred = a new task: fresh step budget, stop cleared.
  function newTask() { state.aborted = false; state.abortWhy = ''; state.actions = 0; }
  function endTask() { if (!state.busy) { if (state.idleTimer) clearTimeout(state.idleTimer); setDriving(false); } }
  // Esc pressed by Fred (not by us): three within 1.5 s while driving = stop.
  function onEsc(t = now()) {
    state.escTimes = state.escTimes.filter((x) => t - x < 1500).concat(t);
    if (state.escTimes.length >= 3 && (state.driving || state.busy)) { state.escTimes = []; return abort('Esc pressed 3 times'); }
    return false;
  }
  const stopped = () => ({ ok: false, stopped: true, error: `Fred said stop (${state.abortWhy}). Nothing more was done. Do not continue; tell him in a few words that you stopped.` });

  // ── displays + screenshots ──
  const displays = () => geo.normalizeDisplays(electron.screen ? electron.screen.getAllDisplays() : (deps.displays || []));
  const tmp = (name) => path.join(os.tmpdir(), `hannibal-hands-${process.pid}-${name}-${crypto.randomBytes(3).toString('hex')}`);
  async function captureRect(r, fmt = 'png') {
    const f = `${tmp('cap')}.${fmt}`;
    await run('/usr/sbin/screencapture', ['-x', '-t', fmt, '-R', `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`, f]);
    return f;
  }
  // One display → a JPEG Claude can look at, sized so pixel maths stays exact.
  async function snap(d) {
    const f = await captureRect(d.bounds, 'jpg');
    try {
      const size = geo.shotSize(d, SHOT_MAX_W);
      let b64;
      if (electron.nativeImage) {
        const img = electron.nativeImage.createFromPath(f);
        b64 = img.resize({ width: size.width, height: size.height, quality: 'good' }).toJPEG(70).toString('base64');
      } else {
        const out = `${f}.small.jpg`;
        await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-z', String(size.height), String(size.width), f, '--out', out]);
        b64 = fs.readFileSync(out).toString('base64'); fs.unlink(out, () => {});
      }
      lastShots.set(d.index, size);
      return { b64, ...size };
    } finally { fs.unlink(f, () => {}); }
  }
  // Tiny grey thumbnail to tell whether something changed on screen.
  async function signature(r) {
    if (!electron.nativeImage) return null;
    const f = await captureRect(r, 'jpg');
    try {
      const bmp = electron.nativeImage.createFromPath(f).resize({ width: 64, height: 40 }).toBitmap();
      const g = new Uint8Array(64 * 40);
      for (let i = 0; i < g.length; i++) g[i] = (bmp[i * 4] + bmp[i * 4 + 1] + bmp[i * 4 + 2]) / 3;
      return g;
    } catch (_) { return null; } finally { fs.unlink(f, () => {}); }
  }
  function changed(a, b) {
    if (!a || !b) return null;
    let diff = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 12) diff++;
    return diff / a.length > 0.004;
  }
  async function ocrRect(r, { fast = false } = {}) {
    const f = await captureRect(r, 'png');
    try {
      const res = await hands.call('ocr', { path: f, fast }, 20000);
      if (res.error) throw new Error(res.error);
      return (res.lines || []).map((ln) => {
        const g = geo.ocrBoxToGlobal(ln, r);
        return { text: ln.text, conf: ln.conf, rect: { x: g.x, y: g.y, width: g.width, height: g.height }, center: g.center };
      });
    } finally { fs.unlink(f, () => {}); }
  }

  // ── apps ──
  async function front() { return hands.call('front'); }
  async function focusedInfo() { return hands.call('focused'); }
  const isSelf = (info) => info && (Number(info.pid) === selfPid || /^(electron|hannibal)$/i.test(String(info.app || '')));
  async function activate(app) {
    if (!app) return front();
    await osa(`tell application ${asStr(app)} to activate`);
    for (let i = 0; i < 15; i++) {
      const f = await front();
      if (match.norm(f.app).includes(match.norm(app)) || match.norm(app).includes(match.norm(f.app))) return f;
      await sleep(100);
    }
    return front();
  }
  async function pidOf(app) {
    if (!app) return Number((await front()).pid) || 0;
    const out = await osa(`tell application "System Events" to return unix id of (first process whose name is ${asStr(app)})`).catch(() => '');
    return parseInt(String(out).trim(), 10) || 0;
  }

  // Clipboard paste that puts Fred's own clipboard back afterwards.
  async function paste(text) {
    const cb = electron.clipboard;
    if (!cb) return { ok: false, error: 'no clipboard' };
    let saved = null;
    try {
      const image = cb.readImage();
      saved = { text: cb.readText(), html: cb.readHTML(), rtf: cb.readRTF(), image: image && !image.isEmpty() ? image : undefined };
    } catch (_) {}
    cb.writeText(String(text));
    await sleep(80);
    const r = await hands.call('key', { code: keys.CODES.v, mods: ['cmd'] });
    await sleep(700);
    if (saved) {
      try { cb.write({ text: saved.text || '', ...(saved.html ? { html: saved.html } : {}), ...(saved.rtf ? { rtf: saved.rtf } : {}), ...(saved.image ? { image: saved.image } : {}) }); } catch (_) {}
    }
    return r && r.error ? { ok: false, error: r.error } : { ok: true };
  }

  function pickDisplayOrDefault(which, fallbackPoint) {
    const ds = displays();
    if (!ds.length) throw new Error('no displays found');
    const d = geo.pickDisplay(ds, which) || (fallbackPoint && geo.displayAt(ds, fallbackPoint))
      || ds.find((x) => x.bounds.x === 0 && x.bounds.y === 0) || ds[0];
    return { d, ds };
  }
  const summary = (d) => ({ display: d.index, name: d.name, points: `${d.bounds.width}x${d.bounds.height}`, scale: d.scaleFactor });
  const pointFor = (p) => {
    const { d } = pickDisplayOrDefault(p.display);
    const shot = lastShots.get(d.index) || geo.shotSize(d, SHOT_MAX_W);
    return { d, shot, point: geo.imageToGlobal(d, shot, p.x, p.y) };
  };

  // ═════════════ PREFLIGHT — decides block / confirm before the gate ═════════════
  // → { block } | { result } (answer straight back) | { confirm, extra } | { extra }
  async function preflight(action, p = {}) {
    if (state.aborted) return { result: stopped() };
    const extra = { _pass: TOKEN };
    const explicit = p.fred_asked_explicitly === true;
    const guardApp = (name, bundle) => {
      if (!safety.protectedApp(name, bundle)) return null;
      if (!explicit) return { block: `${name} is protected (settings, keychain or passwords). Hannibal does not touch it unless Fred explicitly asks; if he did ask for exactly this, call again with fred_asked_explicitly true.` };
      return { confirm: `Work in ${name}` };
    };

    if (action === 'screen' || action === 'pasteToClaudeCode') return { extra };

    if (action === 'click') {
      const { d, point } = pointFor(p);
      const info = await hands.call('axAt', point).catch(() => ({}));
      const g = guardApp(info.app, info.bundle);
      if (g && g.block) return g;
      let near = [];
      try {
        const r = geo.regionAround(displays(), point, 220, 56);
        if (r) near = (await ocrRect(r, { fast: true })).filter((ln) => Math.abs(ln.center.y - point.y) < 22 && ln.rect.x - 30 < point.x && point.x < ln.rect.x + ln.rect.width + 30).map((ln) => ln.text);
      } catch (_) {}
      const risk = safety.riskyElement(info, near);
      const label = (risk.label || safety.labelsOf(info)[0] || near[0] || '').slice(0, 60);
      extra._resolved = { point, display: d.index, label, app: info.app || '' };
      const what = `${p.double ? 'Double-click' : 'Click'} ${label ? `“${label}”` : `at ${Math.round(p.x)},${Math.round(p.y)}`} in ${info.app || 'the app'} on the ${d.name} screen`;
      if (risk.risky) return { confirm: `${what}. That ${risk.word === 'delete' || risk.word === 'remove' ? 'deletes something' : 'can send, pay or submit something'} — go ahead?`, extra };
      if (g && g.confirm) return { confirm: `${g.confirm}: ${what} — go ahead?`, extra };
      return { extra };
    }

    if (action === 'clickText') {
      const found = await findText(p);
      if (!found.found) return { result: { ok: false, ...found, error: found.ambiguous ? 'More than one match on screen. Ask Fred which one or call again with index (1 = first in this list).' : `Could not find “${p.text}” on screen.${found.near && found.near.length ? ` Closest: ${found.near.join(' | ')}` : ''} Look with computer.screen.` } };
      const t = found.target;
      const info = await hands.call('axAt', t.center).catch(() => ({}));
      const g = guardApp(info.app || found.app, info.bundle);
      if (g && g.block) return g;
      const risk = safety.riskyLabel(t.label).risky ? safety.riskyLabel(t.label) : safety.riskyLabel(p.text).risky ? safety.riskyLabel(p.text) : safety.riskyElement(info);
      const d = geo.displayAt(displays(), t.center);
      extra._resolved = { point: t.center, display: d ? d.index : null, label: t.label, app: info.app || found.app || '', source: t.source };
      const what = `Click “${String(t.label).slice(0, 60)}” in ${info.app || found.app || 'the app'}${d ? ` on the ${d.name} screen` : ''}`;
      if (risk.risky) return { confirm: `${what}. That can send, delete, pay or submit something — go ahead?`, extra };
      if (g && g.confirm) return { confirm: `${g.confirm}: ${what} — go ahead?`, extra };
      return { extra };
    }

    if (action === 'type' || action === 'key') {
      const fr = p.app ? await activate(p.app) : await front();
      if (!p.app && isSelf(fr)) return { block: "Hannibal's own window is in front. Say which app to type into (the app parameter)." };
      if (p.app && !(match.norm(fr.app).includes(match.norm(p.app)) || match.norm(p.app).includes(match.norm(fr.app)))) {
        return { block: `Could not bring ${p.app} to the front (${fr.app || 'something else'} is in front). Open it first with app.open.` };
      }
      const g = guardApp(fr.app, fr.bundle);
      if (g && g.block) return g;
      const foc = await focusedInfo().catch(() => ({}));
      const el = foc.element || {};
      const ctx = { app: fr.app, bundle: fr.bundle, element: el };
      extra._app = fr.app;
      if (action === 'type') {
        const text = String(p.text || '');
        const secret = el.secure || safety.looksSecret(text);
        if (secret && p.secret_ok !== true) return { block: 'That looks like a password or secret (or the field is a password field). Hannibal never types those unless Fred explicitly tells him to; if he did, call again with secret_ok true.' };
        const reason = safety.typeNeedsGate(text, ctx);
        const shown = secret ? `a password (${text.length} characters)` : `“${text.length > 140 ? text.slice(0, 140) + '…' : text}”`;
        if (secret) return { confirm: `Type ${shown} into ${fr.app}${el.secure ? ' (password field)' : ''} — go ahead?`, extra };
        if (reason) return { confirm: `Type ${shown} into ${fr.app}: ${reason} — go ahead?`, extra };
        if (g && g.confirm) return { confirm: `${g.confirm}: type ${shown} — go ahead?`, extra };
        return { extra };
      }
      let combos;
      try { combos = keys.parseKeys(p.keys); } catch (e) { return { block: e.message } }
      const reasons = combos.map((c) => safety.keyNeedsGate(c, ctx)).filter(Boolean);
      if (reasons.length) return { confirm: `Press ${combos.map((c) => c.label).join(', ')} in ${fr.app}: ${reasons[0]} — go ahead?`, extra };
      if (g && g.confirm) return { confirm: `${g.confirm}: press ${combos.map((c) => c.label).join(', ')} — go ahead?`, extra };
      return { extra };
    }

    if (action === 'scroll') {
      const fr = await front();
      const g = guardApp(fr.app, fr.bundle);
      if (g && g.block) return g;
      if (g && g.confirm) return { confirm: `${g.confirm}: scroll — go ahead?`, extra };
      return { extra };
    }
    return { block: `unknown computer action ${action}` };
  }

  // Accessibility first (exact controls, any display), OCR of the screen next.
  async function findText({ text, app, display, index }) {
    const q = String(text || '').trim();
    if (!q) return { found: false, error: 'no text given' };
    let appName = app || '';
    if (app) await activate(app).catch(() => {});
    const fr = await front();
    appName = appName || fr.app;
    const pid = app ? await pidOf(app) : Number(fr.pid);
    if (pid && !(pid === selfPid)) {
      const r = await hands.call('find', { pid, text: q, ms: 2500 }, 8000).catch(() => ({}));
      const ranked = match.rankAx(r.items || [], q).filter((c) => geo.displayAt(displays(), c.center));
      if (ranked.length && ranked[0].score >= 0.7) return { ...match.choose(ranked, { index }), app: appName };
    }
    const ds = displays();
    const want = geo.pickDisplay(ds, display);
    const list = want ? [want] : ds;
    let lines = [];
    for (const d of list) {
      try { lines = lines.concat((await ocrRect(d.bounds)).map((ln) => ({ ...ln, display: d.index }))); } catch (_) {}
    }
    return { ...match.choose(match.rankOcr(lines, q), { index }), app: appName };
  }

  // ═════════════ ACTIONS (only after preflight + gate) ═════════════
  async function act(action, p = {}) {
    if (!p || p._pass !== TOKEN) {
      return { ok: false, error: 'computer control only runs through Hannibal\'s own chat at the desk (with its safety checks).' };
    }
    if (state.aborted) return stopped();
    const isAction = action !== 'screen';
    if (isAction && state.actions >= MAX_ACTIONS()) {
      return { ok: false, limit: true, error: `Step limit reached (${MAX_ACTIONS()} actions in one task). Stop here and tell Fred what is done and what is left.` };
    }
    if (isAction) state.actions++;
    state.busy++;
    touch();
    const t0 = now();
    let res, app = p._app || (p._resolved && p._resolved.app) || '';
    try {
      res = await perform(action, p);
    } catch (e) {
      res = { ok: false, error: e.message };
    } finally {
      state.busy--;
      if (!state.aborted) touch();
    }
    if (state.aborted && res && !res.stopped) res = { ...stopped(), partial: true };
    logAction({ app: app || (res && res.app) || '', action, target: targetOf(action, p), text: action === 'type' ? (p.secret_ok ? `[secret, ${String(p.text || '').length} chars]` : p.text) : undefined,
      result: res && res.ok ? 'ok' : `failed: ${res && (res.error || res.message) || ''}`.slice(0, 200), verified: res ? res.verified : undefined, ms: now() - t0 });
    if (res && isAction) res.steps_left = Math.max(0, MAX_ACTIONS() - state.actions);
    // A failure reaches Claude only as its error text, so fold the useful details in.
    if (res && res.ok === false) {
      res.error = [res.error, res.message, res.sessions && `Sessions: ${res.sessions.join('; ')}`,
        res.options && `Options: ${res.options.map((o) => `${o.index}. ${o.label} (display ${o.display || '?'})`).join('; ')}`]
        .filter(Boolean).join(' ');
    }
    return res;
  }
  function targetOf(action, p) {
    if (action === 'click') return p._resolved ? `${p._resolved.label || ''} @${Math.round(p._resolved.point.x)},${Math.round(p._resolved.point.y)} (display ${p._resolved.display})` : `${p.x},${p.y}`;
    if (action === 'clickText') return p.text;
    if (action === 'key') return p.keys;
    if (action === 'scroll') return `${p.direction} ${p.amount || ''}`;
    if (action === 'pasteToClaudeCode') return `Claude Code${p.session ? ` (${p.session})` : ''}: ${String(p.text || '').slice(0, 60)}`;
    if (action === 'screen') return p.display || 'default';
    return '';
  }

  async function lookAfter(d) {
    try { const s = await snap(d); return { b64: s.b64, image: { width: s.width, height: s.height }, display: d.index }; } catch (_) { return {}; }
  }
  async function frontDisplay() {
    const foc = await focusedInfo().catch(() => ({}));
    const f = foc.windowFrame;
    const ds = displays();
    const d = f ? geo.displayAt(ds, { x: f.x + f.w / 2, y: f.y + Math.min(f.h / 2, 40) }) : null;
    return { d: d || ds.find((x) => x.bounds.x === 0 && x.bounds.y === 0) || ds[0], foc };
  }

  async function perform(action, p) {
    switch (action) {
      case 'screen': {
        const ds = displays();
        if (String(p.display || '').toLowerCase() === 'all') {
          const shots = [];
          for (const d of ds) { const s = await snap(d); shots.push({ ...summary(d), image: { width: s.width, height: s.height }, b64: s.b64 }); }
          const fr = await front().catch(() => ({}));
          return { ok: true, front_app: fr.app, displays: ds.map(summary), images: shots.map((s) => s.b64),
            shots: shots.map(({ b64, ...rest }) => rest), how_to_click: 'Images are in display order (1 = leftmost). Click with computer.click {display, x, y}, x/y in pixels of that display\'s image.' };
        }
        const d = geo.pickDisplay(ds, p.display) || (await frontDisplay()).d;
        const s = await snap(d);
        const fr = await front().catch(() => ({}));
        return { ok: true, display: d.index, display_name: d.name, image: { width: s.width, height: s.height }, b64: s.b64,
          front_app: fr.app, displays: ds.map(summary),
          how_to_click: `To click something in this picture: computer.click {display: ${d.index}, x, y} with x/y in pixels of THIS image (${s.width}x${s.height}). Prefer computer.clickText when the target has a label.` };
      }

      case 'click':
      case 'clickText': {
        const r = p._resolved;
        if (!r || !r.point) return { ok: false, error: 'no target' };
        const ds = displays();
        const d = geo.displayAt(ds, r.point);
        if (!d) return { ok: false, error: `that point (${Math.round(r.point.x)},${Math.round(r.point.y)}) is not on any screen` };
        const region = geo.regionAround(ds, r.point, Math.min(900, d.bounds.width), Math.min(600, d.bounds.height)) || d.bounds;
        const before = await signature(region);
        if (state.aborted) return stopped();
        const c = await hands.call('click', { x: r.point.x, y: r.point.y, button: p.button === 'right' ? 'right' : 'left', count: p.double ? 2 : 1 });
        if (c.error) return { ok: false, error: c.error };
        await sleep(550);
        const after = await signature(region);
        const ch = changed(before, after);
        const look = await lookAfter(d);
        return { ok: true, verified: ch === true, screen_changed: ch, clicked: { label: r.label || null, display: d.index, display_name: d.name, at_points: { x: Math.round(r.point.x), y: Math.round(r.point.y) } },
          ...look, note: ch === false ? 'Nothing visibly changed after the click. Look at the screenshot: it may have missed.' : 'Check the screenshot to confirm the click did what you wanted.' };
      }

      case 'type': {
        const text = String(p.text || '');
        const { d } = await frontDisplay();
        const foc0 = await focusedInfo().catch(() => ({}));
        const before = d ? await signature(d.bounds) : null;
        if (text.length <= 60 && !/[\r\n]/.test(text)) {
          const r = await hands.call('type', { text }, 30000);
          if (r.stopped || state.aborted) return stopped();
          if (r.error) return { ok: false, error: r.error };
        } else {
          const r = await paste(text);
          if (!r.ok) return r;
        }
        await sleep(350);
        if (state.aborted) return stopped();
        const foc = await focusedInfo().catch(() => ({}));
        const el = foc.element || {};
        let verified = null, how = '';
        if (typeof el.value === 'string' && !el.secure) {
          verified = claudeCode.appears(el.value, text); how = verified ? 'the text is in the focused field' : 'the focused field does not show the text';
        }
        if (verified !== true && d) {
          try {
            const lines = await ocrRect(d.bounds, { fast: false });
            if (claudeCode.appears(lines.map((l) => l.text).join('\n'), text)) { verified = true; how = 'the text is visible on screen'; }
          } catch (_) {}
        }
        if (verified == null) { const ch = changed(before, d ? await signature(d.bounds) : null); verified = ch === true; how = ch ? 'the screen changed' : 'nothing visible changed'; }
        const look = verified ? {} : (d ? await lookAfter(d) : {});
        return { ok: true, verified, how, app: foc.app || foc0.app, field: el.role || null, ...look };
      }

      case 'key': {
        const combos = keys.parseKeys(p.keys);
        const { d } = await frontDisplay();
        const before = d ? await signature(d.bounds) : null;
        const fr0 = await front().catch(() => ({}));
        for (const c of combos) {
          if (state.aborted) return stopped();
          const r = await hands.call('key', { code: c.code, mods: c.mods });
          if (r.error) return { ok: false, error: r.error };
          await sleep(120);
        }
        await sleep(450);
        const fr = await front().catch(() => ({}));
        const ch = changed(before, d ? await signature(d.bounds) : null);
        const look = d ? await lookAfter(d) : {};
        const appChanged = fr0.app && fr.app && fr0.app !== fr.app;
        return { ok: true, verified: ch === true || appChanged, screen_changed: ch, pressed: combos.map((c) => c.label), front_app: fr.app, ...look };
      }

      case 'scroll': {
        const dir = String(p.direction || 'down').toLowerCase();
        const n = Math.max(1, Math.min(50, Math.round(Number(p.amount) || 5)));
        const ds = displays();
        let point;
        if (p.x != null && p.y != null) point = pointFor(p).point;
        else {
          const { foc } = await frontDisplay();
          const f = foc.windowFrame;
          point = f ? { x: f.x + f.w / 2, y: f.y + f.h / 2 } : (() => { const { d } = pickDisplayOrDefault(p.display); return { x: d.bounds.x + d.bounds.width / 2, y: d.bounds.y + d.bounds.height / 2 }; })();
        }
        const d = geo.displayAt(ds, point) || ds[0];
        const before = await signature(d.bounds);
        await hands.call('move', point);
        await sleep(60);
        const dy = dir === 'up' ? n : dir === 'down' ? -n : 0, dx = dir === 'left' ? n : dir === 'right' ? -n : 0;
        await hands.call('scroll', { dx, dy });
        await sleep(400);
        const ch = changed(before, await signature(d.bounds));
        const look = await lookAfter(d);
        return { ok: true, verified: ch === true, screen_changed: ch, note: ch === false ? 'Nothing moved: probably already at the end, or the pointer is not over a scrollable area.' : undefined, ...look };
      }

      case 'pasteToClaudeCode': {
        const r = await claudeCode.pasteToClaudeCode({ hands, osa, sh, sleep, paste, aborted: () => state.aborted }, p);
        if (r.stopped) return stopped();
        return r;
      }
      default:
        return { ok: false, error: `unknown action ${action}` };
    }
  }

  // ── IPC ──
  function register(ipcMain) {
    ipcMain.handle('computer', (_e, action, params) => act(action, params || {}));
    ipcMain.handle('computer:stop', (_e, why) => ({ ok: abort(why || 'voice') }));
    ipcMain.handle('computer:status', () => ({ driving: state.driving, actions: state.actions, aborted: state.aborted }));
  }
  // Start the helper (and the Esc watch) in the background; ask for the
  // Accessibility grant if it is missing.
  async function warm() {
    try {
      await hands.start();
      const t = await hands.call('trusted', { prompt: true });
      if (!t.trusted) console.warn('[computer] Accessibility permission missing: System Settings → Privacy & Security → Accessibility → turn on Electron (Hannibal)');
      const w = await hands.call('watchEsc');
      if (!w.ok) console.warn('[computer] Esc×3 stop not available (needs Accessibility / Input Monitoring)');
      return { trusted: !!t.trusted, esc: !!w.ok };
    } catch (e) { console.warn('[computer] hands helper unavailable:', e.message); return { error: e.message }; }
  }

  return { preflight, act, abort, onEsc, newTask, endTask, register, warm, paste, findText,
    get driving() { return state.driving || state.busy > 0; }, _state: state, _token: TOKEN, _lastShots: lastShots };
}

// The "Hannibal is driving" pill: one small click-through window per display,
// excluded from screen captures so it never ends up in his own screenshots.
function createIndicator(electron) {
  const { BrowserWindow, screen } = electron;
  let wins = [];
  const html = `<html><body style="margin:0;background:transparent;-webkit-user-select:none;font:600 13px -apple-system,Helvetica">
<div style="margin:3px auto;width:max-content;padding:6px 14px;border-radius:16px;background:rgba(200,30,30,.92);color:#fff;box-shadow:0 2px 10px rgba(0,0,0,.35)">
● Hannibal is driving · say “Hannibal stop” or press Esc 3×</div></body></html>`;
  function show() {
    hide();
    for (const d of screen.getAllDisplays()) {
      const w = 420, h = 40;
      const win = new BrowserWindow({
        x: Math.round(d.bounds.x + (d.bounds.width - w) / 2), y: Math.round(d.workArea.y + 6), width: w, height: h,
        frame: false, transparent: true, resizable: false, movable: false, focusable: false, skipTaskbar: true,
        hasShadow: false, alwaysOnTop: true, show: false, type: 'panel', webPreferences: { sandbox: true },
      });
      try { win.setAlwaysOnTop(true, 'screen-saver'); } catch (_) {}
      try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {}
      try { win.setIgnoreMouseEvents(true); } catch (_) {}
      try { win.setContentProtection(true); } catch (_) {}
      win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).then(() => { try { win.showInactive(); } catch (_) {} }).catch(() => {});
      wins.push(win);
    }
  }
  function hide() { for (const w of wins) { try { w.destroy(); } catch (_) {} } wins = []; }
  return { show, hide };
}

module.exports = { createComputer, createIndicator };
