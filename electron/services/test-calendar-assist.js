// ─────────────────────────────────────────────────────────────────────────
// TEST: Fred's calendar brief (22 Nov 2026), one block per point.
//   1 past times   2 clashes   3 default calendar   4 the read-back question
//   5 find by description   6 linked reminders   7 repeating events
//   8 every write read back   9 relative dates in Fred's time zone
// Offline: a fake iCloud store, a pinned clock (Sunday 22 Nov 2026, 14:34 in
// Bussum), temp reminder files. Runs the way Claude does: claude-tools →
// calendar preflight → yes/no gate → handler → CalDAV → read back.
// Run:  node electron/services/test-calendar-assist.js
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.HANNIBAL_TZ = 'Europe/Amsterdam';   // Fred's clock; the test machine itself runs in another zone (UTC)
const A = require('./calendar-assist');
const claudeTools = require('./claude-tools');
const { makeIpcInvoker, summarizeAction } = require('./agent/executor');
const { createPermissionStore } = require('./agent/permission-store');
const { createReminderTools, createLinkedReminders } = require('./proactive');

const TZ = 'Europe/Amsterdam';
const NOW = Date.parse('2026-11-22T13:34:00Z');           // Sunday 22 Nov 2026, 14:34 CET
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hannibal-cal-'));
let seq = 0;

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n`, e); process.exitCode = 1; }
}

// ── a fake iCloud ───────────────────────────────────────────────────────────
const utc = (iso) => new Date(Date.parse(iso)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
// one event at Fred's local time "2026-11-23T11:00"
function obj(uid, title, localStart, mins = 60, extra = '') {
  const s = A.resolveWhen(localStart, { now: NOW, tz: TZ }).ms;
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART:${utc(new Date(s).toISOString())}\r\nDTEND:${utc(new Date(s + mins * 60000).toISOString())}\r\nSUMMARY:${title}\r\n${extra}END:VEVENT\r\nEND:VCALENDAR\r\n`;
}
function world({ store = {}, expand = {}, noReadBack = false, changeTitle = false } = {}) {
  const seen = [];
  const account = { get: async () => ({ kind: 'icloud', auth: 'Basic x',
    read: [{ url: 'https://c/home/', name: 'Home', writable: true }, { url: 'https://c/werk/', name: 'Werk', writable: true },
      { url: 'https://c/prive/', name: 'Privé', writable: true }, { url: 'https://c/shared/', name: 'Family (shared)', writable: false }],
    write: { url: 'https://c/home/', name: 'Home', writable: true } }), forget: () => {} };
  const fetchImpl = async (url, o = {}) => {
    const p = new URL(url).pathname;
    const method = o.method || 'GET';
    seen.push({ method, path: p, body: o.body, headers: o.headers || {} });
    if (method === 'REPORT') {
      const inner = Object.keys(store).filter((k) => k.startsWith(p)).map((k) => {
        const data = expand[k] || store[k];
        return `<d:response><d:href>${k}</d:href><d:propstat><d:prop><c:calendar-data><![CDATA[${data}]]></c:calendar-data></d:prop></d:propstat></d:response>`;
      }).join('');
      return { ok: false, status: 207, text: async () => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${inner}</d:multistatus>` };
    }
    if (method === 'GET') {
      if (noReadBack && seen.some((x) => x.method !== 'GET' && x.method !== 'REPORT')) throw new Error('network down');
      return store[p] ? { ok: true, status: 200, headers: { get: () => `"e-${p}"` }, text: async () => (changeTitle ? store[p].replace(/SUMMARY:.*/, 'SUMMARY:Something else') : store[p]) }
        : { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
    }
    if (method === 'PUT') { store[p] = o.body; delete expand[p]; return { ok: true, status: 201, text: async () => '' }; }
    if (method === 'DELETE') { delete store[p]; return { ok: true, status: 204, text: async () => '' }; }
    return { ok: false, status: 405, text: async () => '' };
  };
  return { store, expand, seen, account, fetchImpl, puts: () => seen.filter((x) => x.method === 'PUT'), deletes: () => seen.filter((x) => x.method === 'DELETE') };
}

// The whole desk (or server) side, wired like main.js does it.
function desk(w, { answer = true, remote = null } = {}) {
  const handlers = {};
  const ipc = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const remFile = path.join(TMP, `r${seq++}.json`);
  const reminders = createReminderTools({ filePath: remFile, now: () => NOW });
  const linked = createLinkedReminders({ local: reminders, remote, now: () => NOW });
  const info = require('./info-handlers').registerInfo(ipc, { calendarAccount: w.account, python: 'python3', env: process.env, now: () => NOW, reminders: linked });
  const asked = [];
  claudeTools.setPreflight(info.calendarPreflight, 'calendar');
  const opts = {
    permissions: createPermissionStore({ filePath: path.join(TMP, `p${seq++}.json`), noLoad: true, entries: [] }),
    emit: () => {},
    invoke: makeIpcInvoker(handlers),
    confirmer: async (_step, summary) => { asked.push(summary); return typeof answer === 'function' ? answer(summary) : answer; },
  };
  const run = async (tool, input) => {
    const r = await claudeTools.runTool(`calendar__${tool}`, input, opts);
    let out = r.content; try { out = JSON.parse(r.content); } catch (_) {}
    return { ...r, out };
  };
  return { handlers, reminders, linked, asked, run, info, remFile };
}

async function withFetch(w, fn) {
  const real = global.fetch;
  global.fetch = w.fetchImpl;
  try { return await fn(); } finally { global.fetch = real; claudeTools.setPreflight(null, 'calendar'); }
}

(async () => {
  console.log('1. a time that already passed is never moved by itself');
  await t('"2pm" said at 14:34: Hannibal asks tomorrow or later today', () => {
    const q = A.pastTimeQuestion({ start: '2026-11-22T14:00', said: '2pm', now: NOW, tz: TZ });
    assert.strictEqual(q.ask, '14:00 today has already passed. Do you mean tomorrow, Monday 23 November, at 14:00, or later today?');
    assert.strictEqual(q.options.tomorrow, '2026-11-23T14:00');
    assert.strictEqual(A.pastTimeQuestion({ start: '2026-11-22T16:00', said: '4pm', now: NOW, tz: TZ }), null, 'later today is fine');
    assert.strictEqual(A.pastTimeQuestion({ start: '2026-11-23T14:00', said: 'tomorrow at 2pm', now: NOW, tz: TZ }), null, 'Fred said tomorrow himself');
  });
  await t('the silent next-day move is caught: Fred said "2pm", the start handed in is tomorrow 14:00', async () => {
    const w = world();
    await withFetch(w, async () => {
      const d = desk(w);
      const r = await d.run('add', { title: 'Call with Jay', start: '2026-11-23T14:00', said: '2pm', remind_minutes: 0 });
      assert.strictEqual(r.status, 'question', JSON.stringify(r));
      assert.match(r.out.ask, /14:00 today has already passed\. Do you mean tomorrow, Monday 23 November, at 14:00, or later today\?/);
      assert.strictEqual(d.asked.length, 0, 'no yes/no question yet');
      assert.strictEqual(w.puts().length, 0, 'nothing booked');
      // the same with today's date
      const r2 = await d.run('add', { title: 'Call with Jay', start: '2026-11-22T14:00', remind_minutes: 0 });
      assert.strictEqual(r2.status, 'question');
      assert.strictEqual(w.puts().length, 0);
      // Fred answers "tomorrow": now it is asked and booked
      const r3 = await d.run('add', { title: 'Call with Jay', start: '2026-11-23T14:00', said: 'tomorrow at 2pm', remind_minutes: 0 });
      assert.strictEqual(r3.status, 'ok', JSON.stringify(r3));
      assert.strictEqual(w.puts().length, 1);
    });
  });
  await t('"Sunday at 11" said on Sunday afternoon: next Sunday or later today?', () => {
    const q = A.pastTimeQuestion({ start: '2026-11-22T11:00', said: 'Sunday at 11', now: NOW, tz: TZ });
    assert.match(q.ask, /11:00 today has already passed\. Do you mean next week, Sunday 29 November, at 11:00, or later today\?/);
  });
  await t('the booking itself refuses a past time too (planner path), and says to ask', () => {
    const { buildEvent } = require('./info-handlers');
    const r = buildEvent({ title: 'x', start: '2026-11-22T14:00', now: NOW, tz: TZ });
    assert.ok(!r.ok && /ask Fred which day/.test(r.error));
  });

  console.log('2. clash check before every add and move');
  const busyTomorrow = () => ({
    '/werk/team.ics': obj('team', 'Team call', '2026-11-23T14:00', 60),
    '/prive/lunch.ics': obj('lunch', 'Lunch with Mandy', '2026-11-23T15:00', 30),
    '/prive/bday.ics': 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:bd\r\nDTSTART;VALUE=DATE:20261123\r\nDTEND;VALUE=DATE:20261124\r\nSUMMARY:Gaian birthday\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
  });
  await t('add: names the clash and offers the next free slot (all-day events never clash)', async () => {
    const w = world({ store: busyTomorrow() });
    await withFetch(w, async () => {
      const d = desk(w);
      const r = await d.run('add', { title: 'Call with Jay', start: '2026-11-23T14:30', minutes: 30, remind_minutes: 0 });
      assert.strictEqual(r.status, 'question', JSON.stringify(r));
      assert.strictEqual(r.out.ask, 'That clashes with “Team call” (14:00 to 15:00) on Monday 23 November. The next free slot is at 15:30. Book that instead, or keep 14:30 anyway?');
      assert.strictEqual(r.out.next_free, '2026-11-23T15:30');
      assert.strictEqual(w.puts().length, 0);
      // Fred: "keep it anyway"
      const r2 = await d.run('add', { title: 'Call with Jay', start: '2026-11-23T14:30', minutes: 30, remind_minutes: 0, allow_clash: true });
      assert.strictEqual(r2.status, 'ok', JSON.stringify(r2));
      // a free time goes straight to the question (the birthday does not count)
      const r3 = await d.run('add', { title: 'Gym', start: '2026-11-23T10:00', remind_minutes: 0 });
      assert.strictEqual(r3.status, 'ok', JSON.stringify(r3));
    });
  });
  await t('move: the new slot is checked too, and the event never clashes with itself', async () => {
    const w = world({ store: { ...busyTomorrow(), '/werk/jay.ics': obj('jay', 'Call with Jay', '2026-11-23T11:00', 30) } });
    await withFetch(w, async () => {
      const d = desk(w);
      const r = await d.run('move', { id: '/werk/jay.ics', title: 'Call with Jay', start: '2026-11-23T14:15' });
      assert.strictEqual(r.status, 'question', JSON.stringify(r));
      assert.match(r.out.ask, /clashes with “Team call”.*next free slot is at 15:30\. Move it there instead/);
      const r2 = await d.run('move', { id: '/werk/jay.ics', title: 'Call with Jay', start: '2026-11-23T11:15' });
      assert.strictEqual(r2.status, 'ok', 'overlapping its own old slot is fine: ' + JSON.stringify(r2));
    });
  });
  await t('next free slot: skips back-to-back events, stays inside Fred\'s day, rolls to the next morning', () => {
    const ev = (iso, mins) => { const s = A.resolveWhen(iso, { now: NOW, tz: TZ }).ms; return { ts: s, endTs: s + mins * 60000, title: iso }; };
    const evs = [ev('2026-11-23T19:00', 60), ev('2026-11-23T20:00', 60)];
    const free = A.nextFreeSlot(evs, A.resolveWhen('2026-11-23T19:30', { now: NOW, tz: TZ }).ms, 60, { tz: TZ, now: NOW });
    assert.strictEqual(A.isoLocal(free, TZ), '2026-11-24T08:00', '21:00 would end after Fred\'s day');
  });

  await t('an event that started earlier and is still going counts as a clash', async () => {
    const w = world({ store: { '/werk/long.ics': obj('long', 'Workshop', '2026-11-22T13:00', 180) } });
    await withFetch(w, async () => {
      const d = desk(w);
      const r = await d.run('add', { title: 'Call with Jay', start: '2026-11-22T15:00', minutes: 30, remind_minutes: 0 });
      assert.strictEqual(r.status, 'question', JSON.stringify(r));
      assert.match(r.out.ask, /clashes with “Workshop” \(13:00 to 16:00\)/);
    });
  });
  await t('moving a 2-day event keeps it 2 days (its own length is not forced into minutes)', async () => {
    const w = world({ store: { '/werk/trip.ics': obj('trip', 'Ibiza trip', '2026-11-24T10:00', 48 * 60) } });
    await withFetch(w, async () => {
      const d = desk(w);
      const r = await d.run('move', { id: '/werk/trip.ics', title: 'Ibiza trip', start: '2026-11-26T10:00', allow_clash: true });
      assert.strictEqual(r.status, 'ok', JSON.stringify(r));
      assert.match(d.asked[0], /for 48 hours/);
      assert.match(w.store['/werk/trip.ics'], /DTSTART:20261126T090000Z\r\nDTEND:20261128T090000Z/);
    });
  });

  console.log('3. "Werk" unless Fred names another calendar');
  await t('no calendar named: Werk (even though the account\'s own default is Home), and the question says so', async () => {
    const w = world();
    await withFetch(w, async () => {
      const d = desk(w);
      const r = await d.run('add', { title: 'Call with Jay', start: '2026-11-23T16:00', minutes: 30, remind_minutes: 0 });
      assert.strictEqual(r.status, 'ok', JSON.stringify(r));
      assert.match(d.asked[0], /in your Werk calendar/);
      assert.match(w.puts()[0].path, /^\/werk\//);
      assert.strictEqual(r.out.calendar, 'Werk');
    });
  });
  await t('Fred names one ("private", "Privé", "prive"): that one; an unknown or read-only one is refused', async () => {
    const w = world();
    await withFetch(w, async () => {
      const d = desk(w);
      for (const [i, name] of ['private', 'Privé', 'prive'].entries()) {
        const r = await d.run('add', { title: `Dinner ${name}`, start: `2026-11-2${3 + i}T19:00`, remind_minutes: 0, calendar: name });
        assert.strictEqual(r.status, 'ok', JSON.stringify(r));
        assert.match(d.asked[d.asked.length - 1], /in your Privé calendar/);
      }
      assert.ok(w.puts().every((p) => p.path.startsWith('/prive/')));
      const bad = await d.run('add', { title: 'Golf', start: '2026-11-23T10:00', remind_minutes: 0, calendar: 'Golf' });
      assert.ok(bad.is_error && /no calendar called "Golf".*Werk/.test(bad.out.error), bad.content);
      const ro = await d.run('add', { title: 'Golf', start: '2026-11-23T10:00', remind_minutes: 0, calendar: 'Family (shared)' });
      assert.ok(ro.is_error && /can only read/.test(ro.out.error), ro.content);
    });
  });

  console.log('4. the question reads back title, weekday + date, time, length, calendar');
  await t('booking, all-day booking, move and delete questions', async () => {
    const w = world({ store: { '/werk/jay.ics': obj('jay', 'Call with Jay', '2026-11-23T11:00', 30) } });
    await withFetch(w, async () => {
      const d = desk(w);
      await d.run('add', { title: 'Call with Jean-Marc', start: '2026-11-24T16:00', minutes: 30, remind_minutes: 15 });
      assert.strictEqual(d.asked[0], 'Book “Call with Jean-Marc” on Tuesday 24 November at 16:00 for 30 minutes in your Werk calendar, with a reminder at 15:45 (15 minutes before) — book it?');
      await d.run('add', { title: 'Ibiza', start: '2026-11-28' });
      assert.strictEqual(d.asked[1], 'Book “Ibiza” on Saturday 28 November, all day in your Werk calendar — book it?');
      await d.run('move', { id: '/werk/jay.ics', title: 'Call with Jay', start: '2026-11-24T10:00' });
      assert.strictEqual(d.asked[2], 'Move “Call with Jay” in your Werk calendar from Monday 23 November at 11:00 to Tuesday 24 November at 10:00 for 30 minutes — move it?');
    });
    // the fallback wording (no preflight, e.g. the Ollama planner) says it all too
    assert.strictEqual(summarizeAction({ tool: 'calendar.add' }, { title: 'Call Jay', start: '2026-11-23T16:00', minutes: 90 }),
      'Book “Call Jay” on Monday 23 November at 16:00 for 1 hour 30 minutes in your Werk calendar — book it?');
  });

  console.log('5. cancel or move by description');
  const jayDay = () => ({
    '/werk/jay.ics': obj('jay', 'Call with Jay', '2026-11-23T11:00', 30),
    '/prive/dinner.ics': obj('dinner', 'Dinner with Jay', '2026-11-23T19:00', 120),
    '/werk/mandy.ics': obj('mandy', 'Call with Mandy', '2026-11-23T11:00', 30),
    '/werk/jay2.ics': obj('jay2', 'Call with Jay', '2026-11-25T11:00', 30),
  });
  await t('"cancel my call with Jay tomorrow": finds the one, asks with its details, deletes it', async () => {
    const w = world({ store: jayDay() });
    await withFetch(w, async () => {
      const d = desk(w);
      const r = await d.run('delete', { find: 'my call with Jay', day: 'tomorrow' });
      assert.strictEqual(r.status, 'ok', JSON.stringify(r));
      assert.strictEqual(d.asked[0], 'Delete “Call with Jay” on Monday 23 November at 11:00 from your Werk calendar — delete it?');
      assert.ok(!w.store['/werk/jay.ics'] && w.store['/werk/jay2.ics'] && w.store['/prive/dinner.ics'], 'only that one');
    });
  });
  await t('several match: Hannibal asks which, and changes nothing', async () => {
    const w = world({ store: jayDay() });
    await withFetch(w, async () => {
      const d = desk(w);
      const r = await d.run('delete', { find: 'Jay', day: 'tomorrow' });
      assert.strictEqual(r.status, 'question', JSON.stringify(r));
      assert.strictEqual(r.out.ask, 'I found 2 on Monday 23 November: “Call with Jay” at 11:00, or “Dinner with Jay” at 19:00. Which one?');
      assert.strictEqual(r.out.matches.length, 2);
      const r2 = await d.run('delete', { find: 'call', day: 'tomorrow at 11' });
      assert.strictEqual(r2.status, 'question', 'Jay and Mandy both at 11');
      const r3 = await d.run('delete', { find: 'call with Jay' });           // no day: tomorrow and Wednesday
      assert.strictEqual(r3.status, 'question');
      assert.match(r3.out.ask, /on Monday 23 November.*on Wednesday 25 November/);
      assert.strictEqual(d.asked.length, 0); assert.strictEqual(w.deletes().length, 0);
    });
  });
  await t('nothing matches: says so plainly; move by description works the same way', async () => {
    const w = world({ store: jayDay() });
    await withFetch(w, async () => {
      const d = desk(w);
      const r = await d.run('delete', { find: 'call with Robert', day: 'tomorrow' });
      assert.ok(r.is_error && /nothing in the calendar matches “call with Robert” on Monday 23 November/.test(r.content), r.content);
      const m = await d.run('move', { find: 'dinner with Jay', day: 'tomorrow', start: '2026-11-23T20:00' });
      assert.strictEqual(m.status, 'ok', JSON.stringify(m));
      assert.match(d.asked[0], /^Move “Dinner with Jay” in your Privé calendar from Monday 23 November at 19:00 to Monday 23 November at 20:00 for 2 hours — move it\?$/);
    });
  });

  console.log('6. a reminder linked to the event');
  await t('booking offers a reminder first; 15 minutes before is set and linked', async () => {
    const w = world();
    await withFetch(w, async () => {
      const d = desk(w);
      const q = await d.run('add', { title: 'Call with Jay', start: '2026-11-23T11:00', minutes: 30 });
      assert.strictEqual(q.status, 'question');
      assert.strictEqual(q.out.ask, 'Do you want a reminder before “Call with Jay”, say 15 minutes before?');
      assert.strictEqual(w.puts().length, 0);
      const r = await d.run('add', { title: 'Call with Jay', start: '2026-11-23T11:00', minutes: 30, remind_minutes: 15 });
      assert.strictEqual(r.status, 'ok', JSON.stringify(r));
      assert.strictEqual(r.out.reminder, '10:45 (15 minutes before)');
      const up = d.reminders.upcoming().reminders;
      assert.strictEqual(up.length, 1);
      assert.strictEqual(up[0].eventId, r.out.id);
      assert.strictEqual(A.isoLocal(up[0].triggerTs, TZ), '2026-11-23T10:45');
      // calendar.events shows it next to the event
      const ev = await d.handlers['calendar:events']({}, 3);
      assert.strictEqual(ev.events.find((e) => e.title === 'Call with Jay').reminder, '10:45');
    });
  });
  await t('the brief\'s case: "cancel my call with Jay at 11 tomorrow" cancels the 10:45 reminder with it', async () => {
    const w = world();
    await withFetch(w, async () => {
      const d = desk(w);
      await d.run('add', { title: 'Call with Jay', start: '2026-11-23T11:00', minutes: 30, remind_minutes: 15 });
      const r = await d.run('delete', { find: 'my call with Jay', day: 'tomorrow at 11' });
      assert.strictEqual(r.status, 'ok', JSON.stringify(r));
      assert.match(d.asked[1], /Delete “Call with Jay” on Monday 23 November at 11:00 from your Werk calendar, and its reminder at 10:45 — delete it\?/);
      assert.match(r.out.reminder, /cancelled/);
      assert.strictEqual(d.reminders.upcoming().reminders.length, 0, 'no reminder left behind');
    });
  });
  await t('moving the event moves its reminder (the question says where to)', async () => {
    const w = world();
    await withFetch(w, async () => {
      const d = desk(w);
      const b = await d.run('add', { title: 'Call with Jay', start: '2026-11-23T11:00', minutes: 30, remind_minutes: 15 });
      const r = await d.run('move', { id: b.out.id, title: 'Call with Jay', start: '2026-11-24T16:00' });
      assert.strictEqual(r.status, 'ok', JSON.stringify(r));
      assert.match(d.asked[1], /to Tuesday 24 November at 16:00 for 30 minutes; its reminder moves to 15:45 — move it\?$/);
      assert.match(r.out.reminder, /moved to 15:45/);
      const up = d.reminders.upcoming().reminders;
      assert.strictEqual(up.length, 1); assert.strictEqual(A.isoLocal(up[0].triggerTs, TZ), '2026-11-24T15:45');
    });
  });
  await t('the booked event carries its own alarms, so the phone and Mac calendar ring too (at the start and at the reminder)', async () => {
    const w = world();
    await withFetch(w, async () => {
      const d = desk(w);
      const b = await d.run('add', { title: 'Appointment with Robert', start: '2026-11-23T15:00', minutes: 60, remind_minutes: 15 });
      assert.strictEqual(b.status, 'ok', JSON.stringify(b));
      const ics = w.store[Object.keys(w.store).find((k) => /Robert/.test(w.store[k]))];
      assert.strictEqual((ics.match(/BEGIN:VALARM/g) || []).length, 2, ics);
      assert.match(ics, /TRIGGER;RELATED=START:PT0M/);
      assert.match(ics, /TRIGGER;RELATED=START:-PT15M/);
      assert.match(ics, /BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Appointment with Robert/);
      const ev = await d.handlers['calendar:events']({}, 3);
      assert.strictEqual(ev.events.find((e) => e.title === 'Appointment with Robert').time, '15:00', 'alarms do not confuse reading it back');
      // moving keeps the alarms (they are relative to the start)
      await d.run('move', { id: b.out.id, title: 'Appointment with Robert', start: '2026-11-24T16:00' });
      const moved = w.store[Object.keys(w.store).find((k) => /Robert/.test(w.store[k]))];
      assert.strictEqual((moved.match(/BEGIN:VALARM/g) || []).length, 2, moved);
      assert.match(moved, /DTSTART:20261124T150000Z/);
    });
    const { buildEvent } = require('./info-handlers');
    const noRem = buildEvent({ title: 'x', start: '2026-11-23T11:00', now: NOW, tz: TZ, alarms: [0] }).ics;
    assert.strictEqual((noRem.match(/BEGIN:VALARM/g) || []).length, 1, 'no reminder chosen: still rings at the start');
    assert.ok(!/VALARM/.test(buildEvent({ title: 'Ibiza', start: '2026-11-28', now: NOW, tz: TZ, alarms: [0, 15] }).ics), 'all-day: no midnight alarm');
  });
  await t('the reverse: cancelling only the reminder says the event is still in the calendar', async () => {
    const w = world();
    await withFetch(w, async () => {
      const d = desk(w);
      await d.run('add', { title: 'Call with Jay', start: '2026-11-23T11:00', minutes: 30, remind_minutes: 15 });
      const c = d.reminders.cancel('call with jay');
      assert.ok(c.ok && /still in the calendar.*calendar\.delete/.test(c.note), JSON.stringify(c));
      assert.ok(Object.keys(w.store).length === 1, 'the event stays');
    });
  });
  await t('a reminder that already fired or was cancelled is never mentioned', async () => {
    const w = world();
    await withFetch(w, async () => {
      const d = desk(w);
      const b = await d.run('add', { title: 'Call with Jay', start: '2026-11-23T11:00', minutes: 30, remind_minutes: 15 });
      const file = JSON.parse(fs.readFileSync(d.remFile, 'utf8'));
      file.reminders.forEach((x) => { x.fired = true; x.firedTs = NOW; });
      fs.writeFileSync(d.remFile, JSON.stringify(file));
      const ev = await d.handlers['calendar:events']({}, 3);
      assert.strictEqual(ev.events.find((e) => e.title === 'Call with Jay').reminder, undefined, 'fired: not shown');
      const r = await d.run('delete', { id: b.out.id, title: 'Call with Jay' });
      assert.ok(!/reminder/.test(d.asked[1]), d.asked[1]);
      assert.strictEqual(r.out.reminder, undefined);
      assert.ok(!/reminder/.test(r.out.done), r.out.done);
    });
  });
  await t('a reminder that lives on the other side (booked from the phone) is cancelled through the link', async () => {
    const w = world({ store: { '/werk/jay.ics': obj('jay', 'Call with Jay', '2026-11-23T11:00', 30) } });
    const there = [{ id: 'r-phone', message: 'Call with Jay', triggerTs: A.resolveWhen('2026-11-23T10:45', { now: NOW, tz: TZ }).ms, eventId: '/werk/jay.ics', offsetMin: 15, when: 'x' }];
    const remote = { list: async () => there.slice(), cancel: async (id) => { const i = there.findIndex((x) => x.id === id); if (i >= 0) there.splice(i, 1); return { ok: true }; } };
    await withFetch(w, async () => {
      const d = desk(w, { remote });
      const r = await d.run('delete', { find: 'call with Jay', day: 'tomorrow' });
      assert.strictEqual(r.status, 'ok', JSON.stringify(r));
      assert.match(d.asked[0], /and its reminder at 10:45/);
      assert.strictEqual(there.length, 0);
    });
  });

  console.log('7. repeating events: always "just this one or the whole series"');
  const standup = () => ['BEGIN:VCALENDAR', 'BEGIN:VTIMEZONE', 'TZID:Europe/Madrid', 'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'UID:standup', 'DTSTART;TZID=Europe/Madrid:20261102T090000', 'DTEND;TZID=Europe/Madrid:20261102T091500', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Team standup', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  // what iCloud hands back for tomorrow's repeat (expanded)
  const standupTomorrow = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:standup\r\nRECURRENCE-ID:20261123T080000Z\r\nDTSTART:20261123T080000Z\r\nDTEND:20261123T081500Z\r\nSUMMARY:Team standup\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  await t('delete or move a repeat without Fred\'s choice: he is asked, nothing changes', async () => {
    const w = world({ store: { '/werk/standup.ics': standup() }, expand: { '/werk/standup.ics': standupTomorrow } });
    await withFetch(w, async () => {
      const d = desk(w);
      const r = await d.run('delete', { find: 'standup', day: 'tomorrow' });
      assert.strictEqual(r.status, 'question', JSON.stringify(r));
      assert.strictEqual(r.out.ask, '“Team standup” repeats. Should I delete just this one (Monday 23 November at 09:00) or the whole series?');
      const m = await d.run('move', { find: 'standup', day: 'tomorrow', start: '2026-11-23T10:00' });
      assert.strictEqual(m.status, 'question');
      assert.match(m.out.ask, /Should I move just this one .* or the whole series\?/);
      // even with an occurrence, no scope = no silent "this one"
      const h = await d.handlers['calendar:delete']({}, '/werk/standup.ics', 'Team standup', 'x', '20261123T080000Z');
      assert.ok(!h.ok && /just this one or the whole series/.test(h.error), JSON.stringify(h));
      assert.strictEqual(d.asked.length, 0); assert.strictEqual(w.puts().length + w.deletes().length, 0);
    });
  });
  await t('"just this one" skips only that repeat; "the whole series" moves every repeat (in its own time zone)', async () => {
    const w = world({ store: { '/werk/standup.ics': standup() }, expand: { '/werk/standup.ics': standupTomorrow } });
    await withFetch(w, async () => {
      const d = desk(w);
      const r = await d.run('delete', { find: 'standup', day: 'tomorrow', scope: 'this' });
      assert.strictEqual(r.status, 'ok', JSON.stringify(r));
      assert.match(d.asked[0], /Delete only this one “Team standup” \(Monday 23 November at 09:00\); the other repeats stay/);
      assert.match(w.store['/werk/standup.ics'], /EXDATE;TZID=Europe\/Madrid:20261123T090000/);
      w.expand['/werk/standup.ics'] = standupTomorrow.replace(/20261123/g, '20261130');
      const m = await d.run('move', { find: 'standup', day: '30 November', start: '2026-11-30T10:00', scope: 'all' });
      assert.strictEqual(m.status, 'ok', JSON.stringify(m));
      assert.match(d.asked[1], /\(the whole series, every repeat\)/);
      const s = w.store['/werk/standup.ics'];
      assert.match(s, /DTSTART;TZID=Europe\/Madrid:20261102T100000/); assert.match(s, /DTEND;TZID=Europe\/Madrid:20261102T101500/);
      assert.match(s, /EXDATE;TZID=Europe\/Madrid:20261123T100000/, 'the skipped repeat stays skipped');
      assert.match(s, /RRULE:FREQ=WEEKLY/);
      assert.strictEqual(m.out.verified, true);
    });
  });
  await t('a series on named weekdays is not moved to another day by accident', () => {
    const { moveSeries } = require('./info-handlers');
    const ics = standup().replace('RRULE:FREQ=WEEKLY', 'RRULE:FREQ=WEEKLY;BYDAY=MO');
    const r = moveSeries(ics, '20261123T080000Z', { start: '2026-11-24T09:00', now: NOW, tz: TZ });
    assert.ok(!r.ok && /repeat rule/.test(r.error));
  });

  await t('a series with hand-added dates (RDATE) is not moved as a whole: refused, nothing written', () => {
    const { moveSeries } = require('./info-handlers');
    const ics = standup().replace('RRULE:FREQ=WEEKLY', 'RRULE:FREQ=WEEKLY\r\nRDATE;TZID=Europe/Madrid:20261126T090000');
    const r = moveSeries(ics, '20261123T080000Z', { start: '2026-11-23T10:00', now: NOW, tz: TZ });
    assert.ok(!r.ok && /Calendar app/.test(r.error), JSON.stringify(r));
  });

  console.log('8. every write is read back; done only when verified');
  await t('booked but the read-back fails: not done, verified false, and "do NOT book it again"', async () => {
    const w = world({ noReadBack: true });
    await withFetch(w, async () => {
      const d = desk(w);
      const r = await d.run('add', { title: 'Call with Jay', start: '2026-11-23T16:00', remind_minutes: 0 });
      assert.strictEqual(r.status, 'error');
      assert.match(r.content, /do NOT book it again/);
      const h = await d.handlers['calendar:add']({}, 'Call with Jay 2', '2026-11-23T17:00', 30);
      assert.strictEqual(h.ok, false); assert.strictEqual(h.verified, false); assert.strictEqual(h.could_not_check, true);
    });
  });
  await t('the calendar shows a different title than booked: not done', async () => {
    const w = world({ changeTitle: true });
    await withFetch(w, async () => {
      const d = desk(w);
      const h = await d.handlers['calendar:add']({}, 'Call with Jay', '2026-11-23T16:00', 30);
      assert.ok(!h.ok && h.verified === false && /not with the time or title/.test(h.error), JSON.stringify(h));
    });
  });
  await t('verified results carry what really happened; only those are logged as done', async () => {
    const w = world();
    await withFetch(w, async () => {
      const d = desk(w);
      const r = await d.run('add', { title: 'Call with Jay', start: '2026-11-23T16:00', minutes: 30, remind_minutes: 15 });
      assert.strictEqual(r.out.verified, true);
      assert.strictEqual(r.out.done, 'Booked “Call with Jay” Monday 23 November at 16:00 (30 min) in Werk, reminder at 15:45 (15 minutes before) (checked in the calendar)');
      const brain = require('./claude-brain');
      assert.match(brain.doneLine({ tool: 'calendar.add', content: r.content }), /^calendar\.add: Booked “Call with Jay” Monday 23 November at 16:00/);
      assert.strictEqual(brain.doneLine({ tool: 'calendar.add', content: JSON.stringify({ ...r.out, verified: false }) }), null);
    });
  });
  await t('a question is not an error and not a "done": status "question", nothing ran', async () => {
    const w = world();
    await withFetch(w, async () => {
      const d = desk(w);
      const r = await d.run('add', { title: 'Call with Jay', start: '2026-11-23T16:00' });
      assert.strictEqual(r.status, 'question'); assert.strictEqual(r.is_error, false);
      assert.match(r.out.instruction, /Nothing was booked yet/);
    });
  });

  console.log('9. relative dates in Fred\'s own time zone');
  await t('"tomorrow", "next Friday", "Sunday at 11" and friends, said on Sunday 22 Nov at 14:34', () => {
    const cases = {
      'tomorrow at 2pm': 'Monday 23 November at 14:00',
      'tomorrow 11': 'Monday 23 November at 11:00',
      'next Friday at 10': 'Friday 27 November at 10:00',
      'Friday next week at 9:30': 'Friday 27 November at 09:30',
      'Sunday at 11': 'Sunday 22 November at 11:00',
      'next Sunday at 11': 'Sunday 29 November at 11:00',
      'Monday at 3': 'Monday 23 November at 15:00',
      'maandag om 10 uur': 'Monday 23 November at 10:00',
      'overmorgen om 3 uur': 'Tuesday 24 November at 15:00',
      '1 December at 9am': 'Tuesday 1 December at 09:00',
      'in 2 hours': 'Sunday 22 November at 16:34',
      'today at 16:30': 'Sunday 22 November at 16:30',
    };
    for (const [said, want] of Object.entries(cases)) {
      const r = A.resolveWhen(said, { now: NOW, tz: TZ });
      assert.ok(r.ok, `${said}: ${r.error}`);
      assert.strictEqual(A.fmtWhen(r.ms, TZ), want, said);
    }
    const fri = A.resolveWhen('next Friday', { now: NOW, tz: TZ });
    assert.ok(fri.allDay && fri.iso === '2026-11-27');
  });
  await t('"tomorrow at 11" is 11:00 on Fred\'s clock whatever zone the machine runs in (winter and summer, Bussum and Ibiza)', () => {
    const { buildEvent } = require('./info-handlers');
    assert.match(buildEvent({ title: 'x', start: '2026-11-23T11:00', now: NOW, tz: 'Europe/Amsterdam' }).ics, /DTSTART:20261123T100000Z/);
    assert.match(buildEvent({ title: 'x', start: '2026-11-23T11:00', now: NOW, tz: 'Europe/Madrid' }).ics, /DTSTART:20261123T100000Z/);
    assert.match(buildEvent({ title: 'x', start: '2027-07-01T11:00', now: NOW, tz: 'Europe/Madrid' }).ics, /DTSTART:20270701T090000Z/, 'summer time');
    const lateSat = Date.parse('2026-11-21T23:30:00Z');   // Sunday 00:30 in Bussum, still Saturday in UTC
    assert.strictEqual(A.resolveWhen('tomorrow at 10', { now: lateSat, tz: TZ }).iso, '2026-11-23T10:00');
  });
  await t('Hannibal\'s own "Now:" line is on Fred\'s clock', () => {
    const brain = require('./claude-brain');
    assert.strictEqual(brain.nowStamp(new Date(NOW)), 'Sunday 2026-11-22 14:34 (Europe/Amsterdam)');
  });
  await t('calendar.events days and times are on Fred\'s clock too', async () => {
    const w = world({ store: { '/werk/late.ics': obj('late', 'Late call', '2026-11-23T00:30', 30) } });
    await withFetch(w, async () => {
      const d = desk(w);
      const ev = await d.handlers['calendar:events']({}, 3);
      const e = ev.events.find((x) => x.title === 'Late call');
      assert.strictEqual(e.day, 'tomorrow'); assert.strictEqual(e.time, '00:30');
      assert.strictEqual(e.endTs - e.ts, 30 * 60000);
    });
  });

  console.log(`calendar brief: ${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
