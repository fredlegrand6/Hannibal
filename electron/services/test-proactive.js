// ─────────────────────────────────────────────────────────────────────────
// TEST — proactive layer: reminders Claude can set + the morning-brief schedule.
// Offline, temp files, fixed clocks. Run:  node electron/services/test-proactive.js
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const fakeSdk = function Anthropic() {};
fakeSdk.APIError = class extends Error {};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === '@anthropic-ai/sdk' ? fakeSdk : origLoad.call(this, req, ...rest); };

const { createReminderTools, createBriefScheduler, createReminderFirer, registerProactive } = require('./proactive');
const claudeTools = require('./claude-tools');
const brain = require('./claude-brain');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hannibal-proactive-'));
let seq = 0;
const tmp = (n) => path.join(TMP, `${n}${seq++}.json`);

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.stack || e.message}`); process.exitCode = 1; }
}

(async () => {
  console.log('Reminders Claude can set');
  const NOW = Date.parse('2026-11-17T21:00:00');
  await test('add writes the same shape the voice reminders use, and notifies the renderer', () => {
    let notified = 0;
    const file = tmp('rem');
    const r = createReminderTools({ filePath: file, notify: () => notified++, now: () => NOW });
    const out = r.add('call Jay about the Mutuele launch', '2026-11-19T10:00');
    assert(out.ok, out.error);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')).reminders[0];
    assert.strictEqual(saved.message, 'call Jay about the Mutuele launch');
    assert.strictEqual(saved.triggerTs, Date.parse('2026-11-19T10:00'));
    assert.strictEqual(saved.fired, false);
    assert.strictEqual(notified, 1);
    assert(/Thursday/.test(out.when), out.when);
  });
  await test('past times and unreadable times are refused', () => {
    const r = createReminderTools({ filePath: tmp('rem'), now: () => NOW });
    assert.strictEqual(r.add('x', '2026-11-16T10:00').ok, false);
    assert.strictEqual(r.add('x', 'next-ish week').ok, false);
    assert.strictEqual(r.add('', '2026-11-19T10:00').ok, false);
  });
  await test('upcoming lists unfired reminders soonest first; cancel by words', () => {
    const r = createReminderTools({ filePath: tmp('rem'), now: () => NOW });
    r.add('pay the Hetzner invoice', '2026-11-20T09:00');
    r.add('call HTS', '2026-11-18T11:00');
    assert.deepStrictEqual(r.upcoming().reminders.map((x) => x.message), ['call HTS', 'pay the Hetzner invoice']);
    assert.strictEqual(r.cancel('hetzner').ok, true);
    assert.strictEqual(r.upcoming().reminders.length, 1);
  });
  await test('cancel refuses an ambiguous match', () => {
    const r = createReminderTools({ filePath: tmp('rem'), now: () => NOW });
    r.add('call Jay', '2026-11-18T09:00');
    r.add('call Jay again', '2026-11-18T15:00');
    const out = r.cancel('jay');
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.matches.length, 2);
    assert.strictEqual(r.upcoming().reminders.length, 2);
  });
  await test('add and cancel check their own work; recent shows what went off and what was missed', () => {
    let t = NOW;
    const f = tmp('rem');
    const r = createReminderTools({ filePath: f, now: () => t });
    const a = r.add('call Jay', '2026-11-18T09:00');
    assert.strictEqual(a.verified, true);
    r.add('pay Hetzner', '2026-11-18T10:00');
    assert.strictEqual(r.cancel('hetzner').verified, true);
    r.add('fly to Ibiza', '2026-11-18T12:00');
    t = Date.parse('2026-11-18T09:30');
    assert.deepStrictEqual(r.takeDue().map((x) => x.message), ['call Jay']);
    // the desk fires its own and writes firedAt; one stays unfired past its time
    const list = JSON.parse(fs.readFileSync(f, 'utf8')).reminders;
    list.push({ id: 'r-desk', message: 'stretch', triggerTs: Date.parse('2026-11-18T09:00'), fired: true, firedAt: Date.parse('2026-11-18T09:00') });
    fs.writeFileSync(f, JSON.stringify({ reminders: list }));
    t = Date.parse('2026-11-18T13:00');
    const rec = r.recent();
    assert.deepStrictEqual(rec.wentOff.map((x) => x.message).sort(), ['call Jay', 'stretch']);
    assert.deepStrictEqual(rec.missed.map((x) => x.message), ['fly to Ibiza']);
    // the server tried to send one but Telegram failed: that is not "went off"
    r.markDelivered(a.id, false, 'fetch failed');
    const rec2 = r.recent();
    assert.deepStrictEqual(rec2.wentOff.map((x) => x.message), ['stretch']);
    assert.ok(rec2.missed.some((x) => x.message === 'call Jay' && /sending it failed/.test(x.why)));
  });
  await test('notes: add, find and remove one at a time, each checked after saving', () => {
    const { createNoteTools } = require('./proactive');
    let told = 0;
    const f = tmp('notes');
    fs.writeFileSync(f, JSON.stringify({ notes: [{ id: 'n-1', text: 'HTS wants a demo in January', ts: NOW - 86400000 }] }));
    const n = createNoteTools({ filePath: f, notify: () => told++, now: () => NOW });
    const a = n.add('Mutuele launch: ask Jay about the App Store review');
    assert.ok(a.ok && a.verified, JSON.stringify(a));
    assert.strictEqual(n.find().total, 2);
    assert.deepStrictEqual(n.find('hts').notes.map((x) => x.id), ['n-1']);
    assert.strictEqual(n.find().notes[0].id, a.id, 'newest first');
    n.add('Call HTS about the invoice');
    const amb = n.remove('hts');
    assert.ok(!amb.ok && amb.matches.length === 2, 'two notes match: nothing removed');
    const r = n.remove('n-1');
    assert.ok(r.ok && r.verified && /demo/.test(r.removed.text));
    assert.strictEqual(n.find().total, 2);
    assert.ok(!n.add('  ').ok);
    assert.strictEqual(told, 3, 'the desk reloads after every change');
    const { summarizeAction } = require('./agent/executor');
    assert.match(summarizeAction({ tool: 'notes.remove' }, { query: 'HTS demo' }), /Remove the note “HTS demo” — remove it\?/);
  });
  await test('the whole-list replace tools are NOT given to Claude; add/cancel/upcoming are', () => {
    const names = new Set(claudeTools.toolDefinitions().map((d) => claudeTools.fromApiName(d.name)));
    for (const n of ['reminders.save', 'timers.save', 'notes.save']) assert(!names.has(n), n);
    for (const n of ['reminders.add', 'reminders.cancel', 'reminders.upcoming', 'reminders.recent', 'notes.add', 'notes.find', 'notes.remove']) assert(names.has(n), n);
  });

  console.log('Morning brief schedule');
  const at = (hhmm, day = '2026-11-18') => () => new Date(`${day}T${hhmm}:00`);
  await test('nothing before 08:00; one send from 08:00 on, catch-up later that day', () => {
    const sent = [];
    let clock = at('07:59');
    const b = createBriefScheduler({ send: (j) => sent.push(j), statePath: tmp('st'), now: () => clock(), env: {} });
    assert.strictEqual(b.tick(), 'too-early');
    clock = at('08:00');
    assert.strictEqual(b.tick(), 'sent');
    assert.strictEqual(sent[0].kind, 'morning-brief');
    assert(/read-only/.test(sent[0].prompt));
    const late = createBriefScheduler({ send: () => {}, statePath: tmp('st'), now: at('18:30'), env: {} });
    assert.strictEqual(late.tick(), 'sent', 'Mac was off at 08:00: still once that day');
  });
  await test('waits for the renderer; only a spoken brief marks the day done', () => {
    const sent = [];
    let clock = at('08:05');
    const statePath = tmp('st');
    const b = createBriefScheduler({ send: (j) => sent.push(j), statePath, now: () => clock(), env: {} });
    b.tick();
    clock = at('08:06');
    assert.strictEqual(b.tick(), 'waiting');
    b.done({ kind: 'morning-brief', day: '2026-11-18', ok: false });   // not quiet → retry, after 15 min
    assert.strictEqual(b.tick(), 'waiting');
    clock = at('08:21');
    assert.strictEqual(b.tick(), 'sent');
    b.done({ kind: 'morning-brief', day: '2026-11-18', ok: true });
    assert.strictEqual(b.tick(), 'done-today');
    const again = createBriefScheduler({ send: () => {}, statePath, now: () => clock(), env: {} });
    assert.strictEqual(again.tick(), 'done-today', 'survives a restart');
    const tomorrow = createBriefScheduler({ send: () => {}, statePath, now: at('09:00', '2026-11-19'), env: {} });
    assert.strictEqual(tomorrow.tick(), 'sent');
  });
  await test('a lost renderer answer is retried after 15 minutes', () => {
    let clock = at('08:00');
    const b = createBriefScheduler({ send: () => {}, statePath: tmp('st'), now: () => clock(), env: {} });
    b.tick();
    clock = at('08:14');
    assert.strictEqual(b.tick(), 'waiting');
    clock = at('08:16');
    assert.strictEqual(b.tick(), 'sent');
  });
  await test('custom times and the off switch', () => {
    const env = { HANNIBAL_BRIEF_TIME: '07:30', HANNIBAL_BRIEF_UNTIL: '10:00' };
    const b = createBriefScheduler({ send: () => {}, statePath: tmp('st'), now: at('07:45'), env });
    assert.strictEqual(b.tick(), 'sent');
    const off = createBriefScheduler({ send: () => {}, statePath: tmp('st'), now: at('09:00'), env: { HANNIBAL_BRIEF: '0' } });
    assert.strictEqual(off.tick(), 'disabled');
  });

  console.log('Claude knows the time');
  await test('every turn starts its context with the exact local date and time', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    let req = null;
    brain._setClient({ beta: { messages: { stream: (r) => { req = r; return {
      on: () => {}, finalMessage: async () => ({ model: 'fake', usage: {}, stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ok.' }] }),
    }; } } } });
    brain._setFactStore({ renderForPrompt: () => '' });
    await brain.chat({ system: 'S', context: 'mood: fine', user: 'remind me thursday' }, () => {});
    const note = req.messages[req.messages.length - 1];
    assert.strictEqual(note.role, 'system');
    assert(/^Now: \w+day \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(/.test(note.content), note.content);
    assert(/mood: fine/.test(note.content));
  });

  await test("Fred's brief rules: 08:00 local, once a day on disk, restarts and reloads never repeat it", () => {
    const statePath = tmp('brief');
    const day = (t, d = '2026-11-22') => () => new Date(`${d}T${t}:00`);
    let sent = 0;
    const mk = (clock) => createBriefScheduler({ statePath, now: clock, env: {}, send: () => sent++ });
    // nothing before 08:00, even though Fred is up at 06:00
    assert.strictEqual(mk(day('06:00')).tick(), 'too-early');
    assert.strictEqual(mk(day('07:59')).tick(), 'too-early');
    // 1. lastBrief = yesterday, start after 08:00 -> runs once (catch-up, even at 15:00)
    fs.writeFileSync(statePath, JSON.stringify({ lastBrief: '2026-11-21' }));
    let b = mk(day('15:00'));
    assert.strictEqual(b.tick(), 'sent');
    assert.strictEqual(b.tick(), 'waiting', 'no second copy while the page waits for a quiet moment');
    b.done({ kind: 'morning-brief', day: '2026-11-22', started: true });
    assert.strictEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).lastBrief, '2026-11-22', 'written to disk when he starts speaking');
    // 2. restart -> no brief
    assert.strictEqual(mk(day('15:05')).tick(), 'done-today');
    // 3. renderer reload: the page asks nothing itself, and main stays done
    b.done({ kind: 'morning-brief', day: '2026-11-22', ok: false });
    assert.strictEqual(b.tick(), 'done-today');
    // 4. next day 08:00 -> runs once
    const next = mk(day('08:00', '2026-11-23'));
    assert.strictEqual(next.tick(), 'sent');
    next.done({ kind: 'morning-brief', day: '2026-11-23', started: true });
    assert.strictEqual(mk(day('08:01', '2026-11-23')).tick(), 'done-today');
    assert.strictEqual(sent, 2);
  });
  await test('a restart before he started speaking does bring it (it was never heard)', () => {
    const statePath = tmp('brief');
    const clock = () => new Date('2026-11-22T09:00:00');
    assert.strictEqual(createBriefScheduler({ statePath, now: clock, env: {}, send: () => {} }).tick(), 'sent');
    assert.strictEqual(createBriefScheduler({ statePath, now: clock, env: {}, send: () => {} }).tick(), 'sent');
  });
  await test('only one scheduler per app run', () => {
    const handlers = new Map();
    const ipc = { handle: (ch, fn) => { if (handlers.has(ch)) throw new Error(`second handler for ${ch}`); handlers.set(ch, fn); } };
    const quiet = console.warn; console.warn = () => {};
    const opts = { getWindow: () => null, statePath: tmp('st'), remindersPath: tmp('rem'), notesPath: tmp('notes') };
    try {
      const one = registerProactive(ipc, opts);
      const two = registerProactive(ipc, opts);
      assert.strictEqual(one, two);
      one.stop();
    } finally { console.warn = quiet; }
  });
  await test('main fires due reminders itself: banner, page, phone, once, late ones marked', async () => {
    let t = Date.parse('2026-11-18T07:00:00');
    const file = tmp('fire');
    const r = createReminderTools({ filePath: file, now: () => t });
    r.add('check GEX131', '2026-11-18T08:00');
    r.add('call Jay', '2026-11-22T10:00');
    const banners = [], page = [], phone = [];
    const fire = createReminderFirer({ reminders: r, now: () => t,
      banner: (title, body) => banners.push(body), toRenderer: (ch, x) => page.push([ch, x.message]), onReminder: async (m) => { phone.push(m); return true; } });
    assert.strictEqual(fire().length, 0, 'nothing due yet');
    t = Date.parse('2026-11-22T09:00:00');
    const quiet = console.log; console.log = () => {};
    try { assert.strictEqual(fire().length, 1); assert.strictEqual(fire().length, 0, 'only once'); } finally { console.log = quiet; }
    await new Promise((res) => setTimeout(res, 10));
    assert(/check GEX131 \(this was due .*I missed it\)/.test(banners[0]), banners[0]);
    assert.deepStrictEqual(page[0][0], 'reminders:due');
    assert.strictEqual(phone.length, 1);
    const rec = r.recent(200);
    assert.strictEqual(rec.wentOff.length, 1, JSON.stringify(rec));
    assert.strictEqual(rec.missed.length, 0);
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
