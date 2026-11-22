// ─────────────────────────────────────────────────────────────────────────
// TEST — Hannibal's hands (computer.* tools). Offline and deterministic: a
// fake native helper, fake screen/clipboard, Fred's real display layout.
// Covers the brief's tests:
//   • "Paste the brief into Claude Code" → finds the session, waits if busy, pastes, sends, verifies
//   • "Open Notes and write 'test'" → works without coordinates guessed blind
//   • a click on "Send" in Mail → the voice confirm is asked first
//   • "Hannibal stop" mid-task → stops within 1 second (also Esc×3, wake word)
//   • multi-display: clicking on the right-hand screen hits the right spot
//   • a key combo that moves focus (cmd+tab, cmd+space …) never lets the next
//     step land unchecked; focus changing between check and action aborts
// Run:  node electron/services/computer/test-computer.js
// ─────────────────────────────────────────────────────────────────────────
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === '@anthropic-ai/sdk' ? function Anthropic() {} : origLoad.call(this, req, ...rest); };

const keys = require('./keys');
const safety = require('./safety');
const geo = require('./geometry');
const match = require('./text-match');
const cc = require('./claude-code');
const { createComputer } = require('./computer-control');
const catalog = require('../agent/catalog');
const claudeTools = require('../claude-tools');
const { createPermissionStore } = require('../agent/permission-store');
const DriveStop = require('../../../src/drive-stop');
const NameGate = require('../../../src/name-gate');

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// Fred's three displays (from NSScreen on his Mac, 2026-11-22): the MacBook at
// 0,0 (Retina 2x), Philips "(2)" above-left, Philips "(1)" above-right (1x).
const FRED_DISPLAYS = [
  { id: 1, bounds: { x: 0, y: 0, width: 1728, height: 1117 }, scaleFactor: 2, internal: true, label: 'Built-in Retina Display' },
  { id: 2, bounds: { x: 855, y: -1080, width: 1920, height: 1080 }, scaleFactor: 1, internal: false, label: 'PHL24E1N5300 (1)' },
  { id: 3, bounds: { x: -1065, y: -1080, width: 1920, height: 1080 }, scaleFactor: 1, internal: false, label: 'PHL24E1N5300 (2)' },
];

// ── a fake world: apps, focused element, AX items, OCR lines ──
function fakeWorld(over = {}) {
  const w = {
    front: { app: 'Notes', bundle: 'com.apple.Notes', pid: 501 },
    element: { role: 'AXTextArea', value: '' },
    windowFrame: { x: 100, y: 100, w: 1200, h: 800 },
    axItems: [], axAt: {}, ocr: [], calls: [], typed: [], clipboard: 'Fred\'s own clipboard', frame: 0,
    ...over,
  };
  w.hands = {
    async start() {}, stopTyping() { w.stopTypingCalled = true; if (w.typingRelease) w.typingRelease(); },
    async call(cmd, a = {}) {
      w.calls.push({ cmd, ...a });
      switch (cmd) {
        case 'front': return { ...w.front };
        case 'focused': return { ...w.front, element: { ...w.element }, windowFrame: w.windowFrame };
        case 'axAt': return typeof w.axAt === 'function' ? w.axAt(a) : { ...w.axAt };
        case 'find': return { ok: true, items: w.axItems.filter((it) => match.norm(`${it.title} ${it.description}`).includes(match.norm(a.text))) };
        case 'dump': return { ok: true, items: typeof w.dump === 'function' ? w.dump(a) : (w.dump || []) };
        case 'ocr': return { lines: w.ocr };
        case 'click': w.frame++; if (w.onClick) w.onClick(a); return { ok: true };
        case 'key': w.frame++; if (w.onKey) w.onKey(a); return { ok: true };
        case 'type':
          if (w.slowType) { await new Promise((r) => { w.typingRelease = r; }); return { ok: false, stopped: true }; }
          w.typed.push(a.text); w.element.value = (w.element.value || '') + a.text; w.frame++; return { ok: true };
        case 'raise': case 'move': case 'scroll': w.frame++; return { ok: true };
        default: return { ok: true };
      }
    },
  };
  // Screenshots change whenever something was done (w.frame), so "changed" works.
  w.electron = {
    screen: { getAllDisplays: () => FRED_DISPLAYS },
    nativeImage: { createFromPath: () => ({ resize: () => ({ toJPEG: () => Buffer.from('/9j/4AAQ', 'base64'), toBitmap: () => Buffer.alloc(64 * 40 * 4, (w.frame * 40) % 250) }) }) },
    clipboard: {
      readText: () => w.clipboard, readHTML: () => '', readRTF: () => '', readImage: () => ({ isEmpty: () => true }),
      writeText: (t) => { w.clipboard = t; }, write: (o) => { w.clipboard = o.text; },
    },
  };
  w.run = async (cmd, args) => { if (/screencapture/.test(cmd)) fs.writeFileSync(args[args.length - 1], 'x'); return ''; };
  w.osa = async (script) => { w.calls.push({ cmd: 'osa', script }); if (w.onOsa) return w.onOsa(script); if (/unix id of/.test(script)) return String(w.front.pid); const m = script.match(/tell application "([^"]+)" to activate/); if (m) w.front = { app: m[1], bundle: `com.apple.${m[1]}`, pid: 600 }; return ''; };
  w.sh = async (c) => (w.onSh ? w.onSh(c) : '');
  return w;
}
function makeComputer(w, extra = {}) {
  const logFile = path.join(os.tmpdir(), `hannibal-computer-test-${process.pid}-${Math.random().toString(36).slice(2)}.log`);
  const c = createComputer({ hands: w.hands, electron: w.electron, run: w.run, osa: w.osa, sh: w.sh, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))), logFile, selfPid: 99999, ...extra });
  c._logFile = logFile;
  return c;
}
// Run a tool the way Claude does: claude-tools → preflight → gate → executor → handler.
function wire(computer, { confirm = true } = {}) {
  const asked = [];
  claudeTools.setPreflight((name, params) => computer.preflight(name.replace(/^computer\./, ''), params));
  const invoke = async (tool, params) => computer.act(tool.replace(/^computer\./, ''), params);
  const run = (name, input, opts = {}) => claudeTools.runTool(claudeTools.toApiName(name), input, {
    desk: true, invoke, permissions: createPermissionStore({ filePath: path.join(os.tmpdir(), `hp-${Math.random()}.json`), noLoad: true, entries: [] }),
    confirmer: async (step, summary) => { asked.push(summary); return { approved: confirm, answer: confirm ? 'yes' : 'no' }; },
    emit: () => {}, ...opts,
  });
  return { run, asked };
}

// ═════════════ pure parts ═════════════
test('keys: combos and sequences parse to the right key codes', () => {
  assert.deepStrictEqual(keys.parseCombo('cmd+v'), { code: 9, mods: ['cmd'], name: 'v', label: 'cmd+v' });
  assert.strictEqual(keys.parseCombo('Enter').code, 36);
  assert.deepStrictEqual(keys.parseCombo('cmd+shift+4').mods, ['shift', 'cmd']);
  assert.strictEqual(keys.parseCombo('⌘V').label, 'cmd+v');
  assert.strictEqual(keys.parseCombo('Command-Tab').label, 'cmd+tab');
  assert.strictEqual(keys.parseCombo('esc').code, 53);
  assert.deepStrictEqual(keys.parseKeys('cmd+a, delete').map((c) => c.label), ['cmd+a', 'delete']);
  assert.throws(() => keys.parseCombo('cmd+shift'), /only modifiers/);
  assert.throws(() => keys.parseCombo('cmd+blah'), /unknown key/);
});

test('safety: Send / Delete / Pay / Submit / Merge buttons are risky in EN, NL, FR, ES; ordinary ones are not', () => {
  for (const l of ['Send', 'Send now', 'Verstuur', 'Envoyer', 'Enviar', 'Delete', 'Verwijderen', 'Supprimer', 'Pay now', 'Betalen', 'Submit', 'Merge pull request', 'Squash and merge', 'Place order', 'Afrekenen']) {
    assert.ok(safety.riskyLabel(l).risky, `${l} should be risky`);
  }
  for (const l of ['New Note', 'Reply', 'Cancel', 'Open', 'Settings', 'Sender', 'Inbox', 'Paste', '']) {
    assert.ok(!safety.riskyLabel(l).risky, `${l} should not be risky`);
  }
  // a long text line that happens to mention "send" is not a button
  assert.ok(!safety.riskyLabel('Can you send me the numbers for HTS before Friday please').risky);
  assert.ok(safety.riskyElement({ role: 'AXStaticText', title: '', control: { role: 'AXButton', title: 'Send' } }).risky);
});

test('safety: Enter in chat apps / Terminal / unknown apps needs a yes; in Notes it does not', () => {
  const enter = keys.parseCombo('enter');
  assert.ok(safety.keyNeedsGate(enter, { app: 'Messages' }));
  assert.ok(/runs the command/.test(safety.keyNeedsGate(enter, { app: 'Terminal' })));
  assert.ok(safety.keyNeedsGate(enter, { app: 'WhatsApp' }));
  assert.strictEqual(safety.keyNeedsGate(enter, { app: 'Notes' }), null);
  assert.ok(safety.keyNeedsGate(keys.parseCombo('cmd+enter'), { app: 'Notes' }));
  assert.ok(safety.keyNeedsGate(keys.parseCombo('cmd+shift+d'), { app: 'Mail' }));
  assert.ok(safety.keyNeedsGate(keys.parseCombo('cmd+delete'), { app: 'Finder', element: { role: 'AXOutline' } }));
  assert.strictEqual(safety.keyNeedsGate(keys.parseCombo('delete'), { app: 'Mail', element: { role: 'AXTextArea' } }), null);
  assert.ok(safety.keyNeedsGate(keys.parseCombo('delete'), { app: 'Mail', element: { role: 'AXTable' } }));
  assert.strictEqual(safety.keyNeedsGate(keys.parseCombo('cmd+n'), { app: 'Notes' }), null);
  assert.ok(safety.typeNeedsGate('ls\nrm -rf x', { app: 'Terminal' }));
  assert.strictEqual(safety.typeNeedsGate('test', { app: 'Terminal' }), null);
  assert.strictEqual(safety.typeNeedsGate('line one\nline two', { app: 'Notes' }), null);
});

test('safety: passwords and keys are recognised and masked; normal text is not', () => {
  for (const s of ['sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx', 'ghp_1234567890abcdefghijABCDEFGHIJ', 'Wachtw00rd!x', 'password: hunter2', '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ']) {
    assert.ok(safety.looksSecret(s), `${s} should look secret`);
    assert.ok(!safety.mask(`my key ${s} ok`).includes(s.split(' ').pop()), `${s} should be masked`);
  }
  for (const s of ['test', 'Hello Jay, see you at 8', 'https://revalisgroup.com/pricing', 'fred@example.com', 'Revalis Housing launch']) {
    assert.ok(!safety.looksSecret(s), `${s} should not look secret`);
  }
});

test('safety: System Settings, Keychain and password managers are protected', () => {
  assert.ok(safety.protectedApp('System Settings'));
  assert.ok(safety.protectedApp('Systeeminstellingen'));
  assert.ok(safety.protectedApp('Keychain Access'));
  assert.ok(safety.protectedApp('1Password 8'));
  assert.ok(safety.protectedApp('', 'com.apple.Passwords'));
  assert.ok(!safety.protectedApp('Notes', 'com.apple.Notes'));
});

test('multi-display: displays are numbered left to right and a click on the right-hand screen lands there', () => {
  const ds = geo.normalizeDisplays(FRED_DISPLAYS);
  assert.deepStrictEqual(ds.map((d) => d.label || 'laptop'), ['PHL24E1N5300 (2)', 'Built-in Retina Display', 'PHL24E1N5300 (1)']);
  const right = geo.pickDisplay(ds, 'right');
  assert.strictEqual(right.label, 'PHL24E1N5300 (1)');
  assert.strictEqual(geo.pickDisplay(ds, 'laptop').internal, true);
  assert.strictEqual(geo.pickDisplay(ds, '3'), right);
  // Claude saw a 1440x810 picture of the right screen and points at its centre.
  const shot = geo.shotSize(right);
  assert.deepStrictEqual(shot, { width: 1440, height: 810 });
  const p = geo.imageToGlobal(right, shot, 720, 405);
  assert.deepStrictEqual(p, { x: 855 + 960, y: -1080 + 540 });
  assert.strictEqual(geo.displayAt(ds, p), right);
  // The laptop (Retina): a 1440-wide picture of 1728 points.
  const lap = geo.pickDisplay(ds, 'laptop');
  const q = geo.imageToGlobal(lap, geo.shotSize(lap), 1440 - 1, 0);
  assert.ok(Math.abs(q.x - 1726.8) < 0.2 && q.y === 0);
  // round trip
  assert.deepStrictEqual(geo.globalToImage(right, shot, p), { x: 720, y: 405 });
  // OCR box (normalised, top-left) in a region of the left screen
  const g = geo.ocrBoxToGlobal({ x: 0.5, y: 0.5, w: 0.1, h: 0.02 }, { x: -1065, y: -1080, width: 1920, height: 1080 });
  assert.deepStrictEqual(g.center, { x: -1065 + 960 + 96, y: -1080 + 540 + 10.8 });
});

test('text match: the real "Send" button beats a sentence that mentions sending', () => {
  const items = [
    { role: 'AXStaticText', value: 'I will send the numbers tomorrow', frame: { x: 10, y: 10, w: 300, h: 20 } },
    { role: 'AXButton', title: 'Send', frame: { x: 900, y: 60, w: 40, h: 24 } },
  ];
  const r = match.choose(match.rankAx(items, 'send'));
  assert.ok(r.found && r.target.label === 'Send' && r.target.center.x === 920);
  const two = match.choose(match.rankAx([{ role: 'AXButton', title: 'Send', frame: { x: 0, y: 0, w: 40, h: 20 } }, { role: 'AXButton', title: 'Send', frame: { x: 600, y: 0, w: 40, h: 20 } }], 'Send'));
  assert.ok(two.ambiguous && two.options.length === 2);
  const ocr = match.rankOcr([{ text: 'Cancel   Send', conf: 0.9, rect: { x: 100, y: 100, width: 130, height: 20 }, center: { x: 165, y: 110 } }], 'Send');
  assert.ok(ocr[0].center.x > 165, 'the slice for "Send" is on the right of the line');
});

test('drive stop: "Hannibal stop" and a bare "stop" stop him; other talk does not', () => {
  const opt = { mentionsName: NameGate.mentionsName };
  for (const s of ['Hannibal stop', 'Hannibal, stop!', 'Stop.', 'stop stop', 'Hannibal wacht', 'Arrête Hannibal', 'Hannibal para', 'Annable stop', 'Hold on!']) {
    assert.ok(DriveStop.decide(s, opt).stop, `${s} should stop`);
  }
  for (const s of ['', 'the bus stop is around the corner from the office', 'open the notes app please', 'Jay said we should stop the old pricing next month']) {
    assert.ok(!DriveStop.decide(s, opt).stop, `${s} should not stop`);
  }
});

// ═════════════ the service, end to end through the gate ═════════════
test('brief test: a click on "Send" in Mail asks the voice confirm first (and does not click on "no")', async () => {
  const w = fakeWorld({ front: { app: 'Mail', bundle: 'com.apple.mail', pid: 700 },
    axItems: [{ role: 'AXButton', title: 'Send', frame: { x: 400, y: 200, w: 60, h: 24 } }],
    axAt: { found: true, role: 'AXButton', title: 'Send', app: 'Mail', bundle: 'com.apple.mail' } });
  const c = makeComputer(w);
  const no = wire(c, { confirm: false });
  const r = await no.run('computer.clickText', { text: 'Send', app: 'Mail' });
  assert.strictEqual(no.asked.length, 1, 'Fred was asked');
  assert.ok(/Send/.test(no.asked[0]) && /go ahead\?$/.test(no.asked[0]), no.asked[0]);
  assert.strictEqual(r.status, 'declined');
  assert.ok(!w.calls.some((x) => x.cmd === 'click'), 'nothing was clicked');
  // …and with a yes it clicks exactly that button.
  const yes = wire(c, { confirm: true });
  const r2 = await yes.run('computer.clickText', { text: 'Send', app: 'Mail' });
  assert.strictEqual(yes.asked.length, 1);
  assert.strictEqual(r2.status, 'ok');
  const click = w.calls.find((x) => x.cmd === 'click');
  assert.deepStrictEqual([click.x, click.y], [430, 212]);
  // a click by POSITION on the same button is gated too
  const w2 = fakeWorld({ front: { app: 'Mail', pid: 700 }, axAt: { found: true, role: 'AXStaticText', app: 'Mail', control: { role: 'AXButton', title: 'Send' } } });
  const c2 = makeComputer(w2);
  const g2 = wire(c2, { confirm: false });
  await g2.run('computer.screen', { display: 'laptop' });
  await g2.run('computer.click', { x: 300, y: 150, display: '2' });
  assert.strictEqual(g2.asked.length, 1);
  assert.ok(!w2.calls.some((x) => x.cmd === 'click'));
});

test('an ordinary click needs no yes, and on the right-hand screen hits the right global point', async () => {
  const w = fakeWorld({ axAt: { found: true, role: 'AXButton', title: 'New Note', app: 'Notes' } });
  const c = makeComputer(w);
  const g = wire(c);
  const s = await g.run('computer.screen', { display: 'right' });
  assert.strictEqual(s.status, 'ok', JSON.stringify(s).slice(0, 300));
  const text = s.content.find((b) => b.type === "text").text;
  assert.ok(/"display":3/.test(text) && /1440x810/.test(text), text.slice(0, 300));
  const r = await g.run('computer.click', { x: 720, y: 405, display: '3' });
  assert.strictEqual(g.asked.length, 0, 'no confirm for a plain button');
  assert.strictEqual(r.status, 'ok');
  const click = w.calls.find((x) => x.cmd === 'click');
  assert.deepStrictEqual([click.x, click.y], [1815, -540]);
  assert.ok(/"verified":true/.test(r.content.find((b) => b.type === 'text').text));
});

test('brief test: "Open Notes and write test" — new note by shortcut, typed, verified from the field', async () => {
  const w = fakeWorld({ front: { app: 'Finder', pid: 300 } });
  w.onKey = (a) => { if (a.code === keys.CODES.n && a.mods.includes('cmd')) w.element = { role: 'AXTextArea', value: '' }; };
  const c = makeComputer(w);
  const g = wire(c);
  const k = await g.run('computer.key', { keys: 'cmd+n', app: 'Notes' });
  assert.strictEqual(k.status, 'ok');
  assert.ok(w.calls.some((x) => x.cmd === 'osa' && /tell application "Notes" to activate/.test(x.script)), 'Notes brought forward');
  const t = await g.run('computer.type', { text: 'test', app: 'Notes' });
  assert.strictEqual(t.status, 'ok');
  assert.deepStrictEqual(w.typed, ['test']);
  assert.ok(/"verified":true/.test(typeof t.content === 'string' ? t.content : t.content.find((b) => b.type === 'text').text));
  assert.strictEqual(g.asked.length, 0);
  // Enter in Messages would be asked first
  w.front = { app: 'Messages', pid: 800 };
  const e = await g.run('computer.key', { keys: 'enter' });
  assert.strictEqual(g.asked.length, 1);
  assert.ok(/Messages/.test(g.asked[0]));
  assert.strictEqual(e.status, 'ok');
});

test('passwords are refused unless Fred said so; protected apps are refused unless explicitly asked', async () => {
  const w = fakeWorld({ element: { role: 'AXTextField', subrole: 'AXSecureTextField', secure: true } });
  const c = makeComputer(w);
  const g = wire(c);
  const r = await g.run('computer.type', { text: 'something' });
  assert.strictEqual(r.status, 'blocked');
  assert.strictEqual(w.typed.length, 0);
  const r2 = await g.run('computer.type', { text: 'something', secret_ok: true });
  assert.strictEqual(r2.status, 'ok');
  assert.strictEqual(g.asked.length, 1, 'even then, confirmed');
  assert.ok(!g.asked[0].includes('something'), 'the password itself is not spoken');
  const log = fs.readFileSync(c._logFile, 'utf8');
  assert.ok(!/something/.test(log) || /secret/.test(log));
  const w2 = fakeWorld({ front: { app: 'System Settings', bundle: 'com.apple.systempreferences', pid: 900 } });
  const c2 = makeComputer(w2);
  const g2 = wire(c2);
  assert.strictEqual((await g2.run('computer.key', { keys: 'cmd+f' })).status, 'blocked');
  assert.strictEqual((await g2.run('computer.key', { keys: 'cmd+f', fred_asked_explicitly: true })).status, 'ok');
  assert.strictEqual(g2.asked.length, 1);
});

test('brief test: "Hannibal stop" mid-task stops within 1 second, and nothing more runs this task', async () => {
  const w = fakeWorld({ slowType: true });
  const c = makeComputer(w);
  const g = wire(c);
  const long = 'x'.repeat(40);
  const t0 = Date.now();
  const pending = g.run('computer.type', { text: long });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(c.driving, 'he is driving');
  assert.strictEqual(c.abort('Fred said "Hannibal stop"'), true);
  const r = await pending;
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `stopped in ${ms} ms`);
  assert.strictEqual(r.status, 'stopped');
  assert.ok(w.stopTypingCalled, 'the typing itself was cut');
  assert.ok(!c.driving, 'the pill is gone');
  const next = await g.run('computer.clickText', { text: 'New Note' });
  assert.strictEqual(next.status, 'stopped', 'later steps in the same task are refused');
  c.newTask();
  w.slowType = false;
  assert.strictEqual((await g.run('computer.type', { text: 'ok' })).status, 'ok', 'a new request works again');
});

test('Fred\'s test: cmd+tab then Enter into a chat app stops and goes to the yes/no (never pressed blind)', async () => {
  const w = fakeWorld();   // Notes in front, where Enter alone is harmless
  w.onKey = (a) => { if (a.code === keys.CODES.tab && a.mods.includes('cmd')) { w.front = { app: 'Messages', bundle: 'com.apple.MobileSMS', pid: 800 }; w.element = { role: 'AXTextArea', value: 'hi' }; } };
  const c = makeComputer(w);
  const g = wire(c, { confirm: false });
  const r = await g.run('computer.key', { keys: 'cmd+tab, enter' });
  const keysSent = () => w.calls.filter((x) => x.cmd === 'key');
  assert.strictEqual(keysSent().length, 1, 'only cmd+tab was pressed');
  assert.strictEqual(keysSent()[0].code, keys.CODES.tab);
  assert.notStrictEqual(r.status, 'ok');
  const msg = JSON.stringify(r);
  assert.ok(/Messages/.test(msg) && /yes\/no/.test(msg), msg.slice(0, 400));
  // Claude follows the advice: just "enter" → now the normal confirm, naming Messages
  const r2 = await g.run('computer.key', { keys: 'enter' });
  assert.strictEqual(g.asked.length, 1, 'Fred was asked');
  assert.ok(/Messages/.test(g.asked[0]), g.asked[0]);
  assert.strictEqual(r2.status, 'declined');
  assert.strictEqual(keysSent().length, 1, 'Enter never went to Messages');
  // the static check for the planned app alone also holds: cmd+tab into Terminal
  const w3 = fakeWorld();
  w3.onKey = (a) => { if (a.code === keys.CODES.tab) { w3.front = { app: 'Terminal', bundle: 'com.apple.Terminal', pid: 810 }; } };
  const g3 = wire(makeComputer(w3), { confirm: true });
  await g3.run('computer.key', { keys: 'cmd+tab, enter' });
  assert.strictEqual(w3.calls.filter((x) => x.cmd === 'key').length, 1, 'Enter not run in Terminal without its own yes');
});

test('Fred\'s test: cmd+space then typing "System Settings" + Enter is refused', async () => {
  const w = fakeWorld();
  const c = makeComputer(w);
  const g = wire(c, { confirm: true });
  assert.strictEqual((await g.run('computer.key', { keys: 'cmd+space' })).status, 'ok');
  // typed with the Enter in one go
  const t = await g.run('computer.type', { text: 'System Settings\n' });
  assert.notStrictEqual(t.status, 'ok', JSON.stringify(t).slice(0, 300));
  assert.ok(!w.calls.some((x) => x.cmd === 'type' || (x.cmd === 'key' && x.code === keys.CODES.v)), 'nothing typed');
  // typed, then Enter as its own key
  assert.strictEqual((await g.run('computer.type', { text: 'System Settings' })).status, 'ok');
  const k = await g.run('computer.key', { keys: 'enter' });
  assert.notStrictEqual(k.status, 'ok', JSON.stringify(k).slice(0, 300));
  assert.ok(!w.calls.some((x) => x.cmd === 'key' && x.code === keys.CODES.return), 'Enter not pressed');
  // and as one sequence after typing: "cmd+space" then type then "enter" inside a sequence
  const w2 = fakeWorld();
  const g2 = wire(makeComputer(w2), { confirm: true });
  await g2.run('computer.key', { keys: 'cmd+space' });
  await g2.run('computer.type', { text: 'Keychain Access' });
  const k2 = await g2.run('computer.key', { keys: 'down, enter' });
  assert.notStrictEqual(k2.status, 'ok');
  assert.ok(!w2.calls.some((x) => x.cmd === 'key' && x.code === keys.CODES.return));
  // an ordinary app from Spotlight still opens
  const w4 = fakeWorld();
  const g4 = wire(makeComputer(w4), { confirm: true });
  await g4.run('computer.key', { keys: 'cmd+space' });
  await g4.run('computer.type', { text: 'Notes' });
  assert.strictEqual((await g4.run('computer.key', { keys: 'enter' })).status, 'ok');
  assert.strictEqual(g4.asked.length, 0);
});

test('Fred\'s test: a normal "cmd+a, delete" inside a text box still runs without a yes', async () => {
  const w = fakeWorld({ front: { app: 'Safari', bundle: 'com.apple.Safari', pid: 900 }, element: { role: 'AXTextField', value: 'old text' } });
  const c = makeComputer(w);
  const g = wire(c, { confirm: false });
  const r = await g.run('computer.key', { keys: 'cmd+a, delete' });
  assert.strictEqual(r.status, 'ok', JSON.stringify(r).slice(0, 300));
  assert.strictEqual(g.asked.length, 0);
  assert.strictEqual(w.calls.filter((x) => x.cmd === 'key').length, 2);
  // …but if cmd+a moved focus off the text box, Delete stops for a yes
  const w2 = fakeWorld({ front: { app: 'Mail', bundle: 'com.apple.mail', pid: 901 }, element: { role: 'AXTextField', value: 'name' } });
  w2.onKey = (a) => { if (a.code === keys.CODES.a) w2.element = { role: 'AXList' }; };
  const g2 = wire(makeComputer(w2), { confirm: false });
  const r2 = await g2.run('computer.key', { keys: 'cmd+a, delete' });
  assert.notStrictEqual(r2.status, 'ok');
  assert.strictEqual(w2.calls.filter((x) => x.cmd === 'key').length, 1, 'Delete not pressed on the message list');
});

test('Fred\'s test: focus changing between the check and the typing aborts (nothing typed blind)', async () => {
  const w = fakeWorld();   // Notes checked…
  const c = makeComputer(w);
  const pre = await c.preflight('type', { text: 'hello' });
  assert.ok(!pre.block && !pre.confirm);
  w.front = { app: 'Messages', bundle: 'com.apple.MobileSMS', pid: 800 };   // …then Messages jumps in front
  const r = await c.act('type', { text: 'hello', ...pre.extra });
  assert.strictEqual(r.ok, false);
  assert.ok(r.focus_changed && /Messages/.test(r.error), r.error);
  assert.ok(!w.calls.some((x) => x.cmd === 'type'), 'nothing typed');
  // a password field appearing in between aborts too
  const w2 = fakeWorld();
  const c2 = makeComputer(w2);
  const pre2 = await c2.preflight('type', { text: 'hello' });
  w2.element = { role: 'AXTextField', secure: true };
  const r2 = await c2.act('type', { text: 'hello', ...pre2.extra });
  assert.strictEqual(r2.ok, false);
  assert.ok(!w2.calls.some((x) => x.cmd === 'type'));
  // a click whose spot now belongs to another app aborts
  const w3 = fakeWorld({ axAt: { found: true, role: 'AXButton', title: 'New Note', app: 'Notes' } });
  const c3 = makeComputer(w3);
  await c3.act('screen', { display: 'laptop', _pass: (await c3.preflight('screen', {})).extra._pass });
  const pre3 = await c3.preflight('click', { x: 100, y: 100, display: '2' });
  w3.axAt = { found: true, role: 'AXButton', title: 'Send', app: 'Mail' };
  const r3 = await c3.act('click', { x: 100, y: 100, display: '2', ...pre3.extra });
  assert.strictEqual(r3.ok, false);
  assert.ok(!w3.calls.some((x) => x.cmd === 'click'), 'not clicked');
});

test('"Hannibal stop" freezes a multi-step key sequence in the middle', async () => {
  const w = fakeWorld();
  const c = makeComputer(w);
  w.onKey = () => { if (w.calls.filter((x) => x.cmd === 'key').length === 2) c.abort('Fred said "Hannibal stop"'); };
  const g = wire(c);
  const r = await g.run('computer.key', { keys: 'down, down, down, down, down' });
  assert.strictEqual(r.status, 'stopped');
  assert.strictEqual(w.calls.filter((x) => x.cmd === 'key').length, 2, 'nothing after the stop');
});

test('stop during a paste: Cmd+V is never sent and Fred\'s clipboard is put back', async () => {
  const w = fakeWorld();
  let c;
  // "Hannibal stop" arrives while the clipboard is being prepared (the 80 ms wait)
  c = makeComputer(w, { sleep: async (ms) => { if (ms === 80) c.abort('Fred said "Hannibal stop"'); } });
  const g = wire(c);
  const r = await g.run('computer.type', { text: 'echo one\necho two and a long line of text that goes through the clipboard' });
  assert.strictEqual(r.status, 'stopped', JSON.stringify(r).slice(0, 300));
  assert.ok(!w.calls.some((x) => x.cmd === 'key'), 'no Cmd+V after the stop');
  assert.strictEqual(w.clipboard, 'Fred\'s own clipboard');
});

test('clickText with a display only picks accessibility matches on that display', async () => {
  const w = fakeWorld({ front: { app: 'Mail', pid: 700 },
    axItems: [
      { role: 'AXButton', title: 'Archive', frame: { x: 400, y: 200, w: 60, h: 24 } },          // laptop
      { role: 'AXButton', title: 'Archive', frame: { x: 1500, y: -600, w: 60, h: 24 } },        // right Philips
    ],
    ocr: [] });
  const c = makeComputer(w);
  const f = await c.findText({ text: 'Archive', display: 'right' });
  assert.ok(f.found, JSON.stringify(f).slice(0, 300));
  assert.ok(f.target.center.x > 1400 && f.target.center.y < 0, JSON.stringify(f));
});

test('Esc pressed 3 times while driving stops; Esc when idle does nothing', async () => {
  let stopped = null;
  const w = fakeWorld();
  const c = makeComputer(w, { onAbort: (why) => { stopped = why; } });
  assert.strictEqual(c.onEsc(1000) || c.onEsc(1100) || c.onEsc(1200), false, 'not driving: ignored');
  const g = wire(c);
  await g.run('computer.screen', {});
  assert.ok(c.driving);
  c.onEsc(5000); c.onEsc(5400);
  assert.strictEqual(stopped, null);
  assert.strictEqual(c.onEsc(5900), true);
  assert.ok(/Esc/.test(stopped));
});

test('only Claude at the desk can drive: no token, the phone, or the planner are refused', async () => {
  const w = fakeWorld();
  const c = makeComputer(w);
  const direct = await c.act('type', { text: 'hello' });
  assert.ok(!direct.ok && /only runs through/.test(direct.error));
  assert.strictEqual(w.typed.length, 0);
  const g = wire(c);
  const phone = await g.run('computer.type', { text: 'hello' }, { desk: false });
  assert.strictEqual(phone.status, 'unavailable');
  assert.ok(!catalog.plannerTools().some((t) => t.domain === 'computer'), 'not in the planner');
  assert.ok(claudeTools.toolDefinitions().some((d) => d.name === 'computer__pasteToClaudeCode'), 'offered to Claude');
});

test('step limit: after 25 actions in one task he stops and reports', async () => {
  const w = fakeWorld();
  const c = makeComputer(w);
  const g = wire(c);
  let last;
  for (let i = 0; i < 26; i++) last = await g.run('computer.key', { keys: 'down' });
  assert.ok(/Step limit/.test(last.content));
});

test('every action is logged with app, action, target and result', async () => {
  const w = fakeWorld();
  const c = makeComputer(w);
  const g = wire(c);
  await g.run('computer.type', { text: 'hello there', app: 'Notes' });
  const lines = fs.readFileSync(c._logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const l = lines[lines.length - 1];
  assert.strictEqual(l.action, 'type');
  assert.strictEqual(l.app, 'Notes');
  assert.strictEqual(l.result, 'ok');
  assert.strictEqual(l.text, 'hello there');
});

// ═════════════ Claude Code ═════════════
// The Claude desktop app's accessibility tree, as seen on Fred's Mac.
function desktopTree({ busy, boxValue = '', convo = '' }) {
  return [
    { role: 'AXButton', title: 'hannibal' + (busy ? ', Running' : ''), frame: { x: 8, y: 339, w: 234, h: 32 } },
    { role: 'AXButton', title: 'revalisplatform', frame: { x: 8, y: 373, w: 234, h: 32 } },
    { role: 'AXTextArea', description: 'Write your prompt to Claude', placeholder: 'Ask Claude…', value: boxValue, frame: { x: 308, y: 981, w: 183, h: 21 } },
    { role: 'AXButton', title: busy ? 'Stop' : 'Send', frame: { x: 499, y: 977, w: 28, h: 28 } },
    ...(convo ? [{ role: 'AXStaticText', value: convo, frame: { x: 300, y: 300, w: 400, h: 20 } }] : []),
  ];
}

test('claude code helpers: busy screen, composer + button, sidebar sessions, terminal list', () => {
  assert.ok(cc.terminalBusy('… Working (12s · esc to interrupt)'));
  assert.ok(!cc.terminalBusy('> \n  ? for shortcuts'));
  const comps = cc.desktopComposers(desktopTree({ busy: true }));
  assert.strictEqual(comps.length, 1);
  assert.ok(comps[0].busy && comps[0].button === 'stop');
  assert.ok(!cc.desktopComposers(desktopTree({ busy: false }))[0].busy);
  const ss = cc.desktopSessions(desktopTree({ busy: true }));
  assert.deepStrictEqual(ss.map((s) => [s.name, s.running]), [['hannibal', true], ['revalisplatform', false]]);
  const t = cc.parseTerminalList('123\t1\t/dev/ttys004\tfalse\tclaude — hannibal\n');
  assert.deepStrictEqual(t[0], { app: 'Terminal', win: '123', tab: '1', tty: 'ttys004', title: 'claude — hannibal' });
  assert.ok(cc.appears('[Pasted text #1 +40 lines]', 'BRIEF FOR CLAUDE CODE\nmore'));
  assert.ok(cc.appears('BRIEF FOR CLAUDE CODE: Full computer control', 'BRIEF FOR CLAUDE CODE: Full computer control for Hannibal'));
});

test('brief test: "Paste the brief into Claude Code" — finds the session, waits while busy, pastes, sends, verifies', async () => {
  const BRIEF = 'BRIEF FOR CLAUDE CODE: Full computer control for Hannibal ("hands")\nGOAL\n...';
  const w = fakeWorld({ front: { app: 'Claude', pid: 701 } });
  let busyChecks = 0, sent = false, box = '';
  w.onSh = (cmd) => (/pgrep/.test(cmd) ? '701\n' : '');
  w.onOsa = (s) => (/exists \(first process/.test(s) ? 'false' : '');
  w.dump = () => {
    if (!sent) busyChecks++;
    const busy = !sent ? busyChecks <= 2 : true;   // busy for the first two looks, then idle; working again after the send
    return desktopTree({ busy, boxValue: box, convo: sent ? BRIEF.split('\n')[0] : '' });
  };
  w.onKey = (a) => {
    if (a.code === keys.CODES.v && a.mods.includes('cmd')) box = w.clipboard;   // the paste lands in the box
    if (a.code === keys.CODES.return && !a.mods.length) { sent = true; box = ''; }
  };
  w.onClick = () => { w.element = PROMPT_EL(); };
  const c = makeComputer(w);
  const g = wire(c);
  // 1st call: busy, no wait → told it is busy, nothing pasted
  const r1 = await g.run('computer.pasteToClaudeCode', { text: BRIEF });
  assert.strictEqual(r1.status, 'error');
  assert.ok(/busy/i.test(r1.content), r1.content);
  assert.ok(!w.calls.some((x) => x.cmd === 'key'), 'nothing pasted while busy');
  // 2nd call with wait → waits for idle, pastes, sends, verifies
  const r2 = await g.run('computer.pasteToClaudeCode', { text: BRIEF, wait_seconds: 60 });
  assert.strictEqual(r2.status, 'ok', r2.content);
  const out = JSON.parse(typeof r2.content === 'string' ? r2.content : r2.content[0].text);
  assert.strictEqual(out.verified, true);
  assert.ok(sent, 'Enter was pressed');
  assert.strictEqual(w.clipboard, 'Fred\'s own clipboard', 'Fred\'s clipboard was put back');
  assert.strictEqual(g.asked.length, 0, 'Fred asked for it: no extra confirm');
  const clicked = w.calls.find((x) => x.cmd === 'click');
  assert.ok(clicked && clicked.y === 981 + 10.5, 'clicked into the prompt box');
});

test('Claude Code: several sessions → Fred is asked which; a named one is picked', async () => {
  const w = fakeWorld();
  w.onSh = (cmd) => (/pgrep/.test(cmd) ? '701\n' : /ps -t ttys00[45]/.test(cmd) ? 'claude\n' : '');
  w.onOsa = (s) => {
    if (/exists \(first process whose name is "Terminal"/.test(s)) return 'true';
    if (/exists \(first process/.test(s)) return 'false';
    if (/tab & \(index of t\)/.test(s)) return '11\t1\t/dev/ttys004\tfalse\tclaude — revalis\n12\t1\t/dev/ttys005\tfalse\tclaude — hannibal-v2\n';
    return '';
  };
  w.dump = () => desktopTree({ busy: false });
  const c = makeComputer(w);
  const g = wire(c);
  const r = await g.run('computer.pasteToClaudeCode', { text: 'hello' });
  assert.ok(/several Claude Code sessions/.test(r.content) && /Terminal: claude — hannibal-v2/.test(r.content), r.content);
  assert.ok(!w.calls.some((x) => x.cmd === 'key'));
});

// A Claude desktop app that can be slow: to come to the front, to take the
// focus, to show pasted text. Knobs: frontAfter (front() polls before Claude is
// frontmost), focusAfterClicks, renderAfter (dumps before the paste shows),
// lostPastes (pastes that never arrive), sendsOnPaste (a paste that sends).
function slowClaude(knobs = {}) {
  const k = { frontAfter: 0, focusAfterClicks: 1, renderAfter: 0, lostPastes: 0, ...knobs };
  const w = fakeWorld({ front: { app: 'Notes', bundle: 'com.apple.Notes', pid: 501 }, element: { role: 'AXTextArea', value: '' } });
  const st = { box: '', pending: null, sent: 0, convo: '', busy: false, clicks: 0, fronts: 0, activated: false, pastes: 0 };
  w.st = st;
  w.onSh = (cmd) => (/pgrep/.test(cmd) ? '701\n' : '');
  w.onOsa = (s) => {
    if (/exists \(first process/.test(s)) return 'false';
    if (/to activate/.test(s)) st.activated = true;
    return '';
  };
  const hcall = w.hands.call;
  w.hands.call = async (cmd, a = {}) => {
    if (cmd === 'front' && st.activated) { st.fronts++; if (st.fronts > k.frontAfter) w.front = { app: 'Claude', bundle: 'com.anthropic.claudefordesktop', pid: 701 }; }
    if (cmd === 'raise') st.activated = true;
    if (cmd === 'focused' && st.activated && st.fronts > k.frontAfter) w.front = { app: 'Claude', bundle: 'com.anthropic.claudefordesktop', pid: 701 };
    return hcall(cmd, a);
  };
  w.onClick = () => { st.clicks++; if (st.clicks >= k.focusAfterClicks && w.front.pid === 701) w.element = PROMPT_EL(); };
  w.dump = () => {
    if (st.pending && --st.pending.wait <= 0) { st.box += st.pending.text; st.pending = null; }
    return desktopTree({ busy: st.busy, boxValue: st.box, convo: st.convo });
  };
  w.onKey = (a) => {
    if (w.front.pid !== 701) return;
    if (a.code === keys.CODES.v && a.mods.includes('cmd')) {
      st.pastes++;
      if (st.pastes <= k.lostPastes) return;                          // this paste never arrives
      if (k.sendsOnPaste && st.pastes === 1) { st.convo = w.clipboard.split('\n')[0]; st.busy = true; return; }
      st.pending = { text: w.clipboard, wait: k.renderAfter };
      if (k.renderAfter <= 0) { st.box += st.pending.text; st.pending = null; }
    }
    if (a.code === keys.CODES.a && a.mods.includes('cmd')) st.selAll = true;
    if (a.code === keys.CODES.delete && st.selAll) { st.box = ''; st.selAll = false; }
    if (a.code === keys.CODES.return && !a.mods.length) { st.sent++; st.convo = st.box.split('\n')[0]; st.box = ''; st.busy = true; }
  };
  return w;
}
const PROMPT_EL = () => ({ role: 'AXTextArea', description: 'Write your prompt to Claude', value: '', frame: { x: 308, y: 981, w: 183, h: 21 } });
const BRIEF2 = 'BRIEF: fix the first-try paste\nsteps…';
const parseOut = (r) => { try { return JSON.parse(typeof r.content === 'string' ? r.content : r.content[0].text); } catch (_) { return {}; } };
const enters = (w) => w.calls.filter((x) => x.cmd === 'key' && x.code === keys.CODES.return && !(x.mods || []).length).length;

test('Fred\'s test: Claude not in front at the start → waits until it is frontmost and focused, then pastes', async () => {
  const w = slowClaude({ frontAfter: 4 });
  const c = makeComputer(w);
  const g = wire(c);
  const r = await g.run('computer.pasteToClaudeCode', { text: BRIEF2 });
  assert.strictEqual(r.status, 'ok', r.content);
  assert.strictEqual(parseOut(r).verified, true);
  assert.strictEqual(enters(w), 1, 'sent exactly once');
  // the fake only counts a paste that arrives while Claude is in front: one, on the first try
  assert.strictEqual(w.st.pastes, 1, 'pasted once, first try, into Claude');
  assert.ok(w.st.fronts > 4, 'it waited for Claude to come to the front');
  assert.ok(w.calls.some((x) => x.cmd === 'osa' && /tell application id "com\.anthropic\.claudefordesktop" to activate/.test(x.script)), 'activated by bundle id');
  // every step is in the log
  const log = fs.readFileSync(c._logFile, 'utf8');
  for (const s of ['activate', 'focus', 'paste', 'verify', 'send', 'confirm']) assert.ok(log.includes(`pasteToClaudeCode.${s}`), `logged ${s}`);
});

test('Fred\'s test: slow focus → clicks into the box again until it has the focus', async () => {
  const w = slowClaude({ focusAfterClicks: 3 });
  const g = wire(makeComputer(w));
  const r = await g.run('computer.pasteToClaudeCode', { text: BRIEF2 });
  assert.strictEqual(r.status, 'ok', r.content);
  assert.strictEqual(w.st.clicks, 3);
  assert.strictEqual(w.st.pastes, 1);
  assert.strictEqual(enters(w), 1);
});

test('Fred\'s test: slow render of the pasted text → polled, found, sent once (no retry)', async () => {
  const w = slowClaude({ renderAfter: 6 });
  const g = wire(makeComputer(w));
  const r = await g.run('computer.pasteToClaudeCode', { text: BRIEF2 });
  assert.strictEqual(r.status, 'ok', r.content);
  assert.strictEqual(w.st.pastes, 1, 'no second paste');
  assert.strictEqual(enters(w), 1);
  assert.strictEqual(parseOut(r).verified, true);
});

test('Fred\'s test: retry never double-sends', async () => {
  // a lost first paste → box cleared, pasted again, Enter exactly once
  const w = slowClaude({ lostPastes: 1 });
  const g = wire(makeComputer(w));
  const r = await g.run('computer.pasteToClaudeCode', { text: BRIEF2 });
  assert.strictEqual(r.status, 'ok', r.content);
  assert.strictEqual(w.st.pastes, 2);
  assert.strictEqual(enters(w), 1, 'Enter once');
  assert.strictEqual(w.st.sent, 1);
  assert.ok(parseOut(r).steps.some((s) => s.step === 'clear'), 'the box was cleared before the second try');
  // the first paste actually went out on its own → no second paste, no Enter at all
  const w2 = slowClaude({ sendsOnPaste: true });
  const g2 = wire(makeComputer(w2));
  const r2 = await g2.run('computer.pasteToClaudeCode', { text: BRIEF2 });
  assert.strictEqual(r2.status, 'ok', r2.content);
  assert.strictEqual(w2.st.pastes, 1);
  assert.strictEqual(enters(w2), 0, 'not sent again');
  // a paste that never shows → reported, never sent
  const w3 = slowClaude({ lostPastes: 5 });
  const g3 = wire(makeComputer(w3));
  const r3 = await g3.run('computer.pasteToClaudeCode', { text: BRIEF2 });
  assert.notStrictEqual(r3.status, 'ok');
  assert.ok(/NOT sent/.test(r3.content) && /tried twice/.test(r3.content), r3.content);
  assert.strictEqual(enters(w3), 0);
  // text in the box twice (a very late first paste) → not sent
  const w4 = slowClaude({ lostPastes: 0 });
  const c4 = makeComputer(w4);
  w4.st.box = BRIEF2;   // already there from an earlier, late paste
  const r4 = await wire(c4).run('computer.pasteToClaudeCode', { text: BRIEF2 });
  assert.notStrictEqual(r4.status, 'ok');
  assert.strictEqual(enters(w4), 0);
});

test('paste into Claude Code keeps the focus re-check: focus moved away before Enter → not sent', async () => {
  const w = slowClaude();
  const orig = w.onKey;
  w.onKey = (a) => { orig(a); if (a.code === keys.CODES.v) { w.front = { app: 'Messages', bundle: 'com.apple.MobileSMS', pid: 800 }; w.st.activated = false; } };
  const g = wire(makeComputer(w));
  const r = await g.run('computer.pasteToClaudeCode', { text: BRIEF2 });
  assert.notStrictEqual(r.status, 'ok');
  assert.strictEqual(enters(w), 0, 'Enter never pressed in Messages');
});

(async () => {
  for (const t of tests) {
    try { await t.fn(); passed++; console.log(`  ✓ ${t.name}`); }
    catch (e) { console.error(`  ✗ ${t.name}\n    ${e.stack.split('\n').slice(0, 4).join('\n    ')}`); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
  process.exit(process.exitCode || 0);
})();
