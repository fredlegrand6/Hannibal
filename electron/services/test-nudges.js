// ─────────────────────────────────────────────────────────────────────────
// TEST: nudges (nudges.js) and calendar booking (info-handlers buildEvent).
// Offline, temp files only. Run:  node electron/services/test-nudges.js
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createNudger, createZoneWatcher, findNudges, knownPeople } = require('./nudges');
const { buildEvent } = require('./info-handlers');
const catalog = require('./agent/catalog');
const { summarizeAction } = require('./agent/executor');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hannibal-nudges-'));
let seq = 0;
const NOW = new Date(2026, 10, 21, 14, 0);   // Saturday 14:00 local
const MIN = 60000; const H = 60 * MIN;
const jm = { uid: '77', from: 'Jean-Marc Dubois', from_email: 'jm@hts.example', subject: 'Contract HTS', age_hours: 50, to_me_directly: true, newsletter: false, preview: 'Can you confirm?' };
const stranger = { uid: '78', from: 'Pat Seller', from_email: 'pat@vendor.example', subject: 'Offer', age_hours: 60, to_me_directly: true, newsletter: false };
const facts = 'Jean-Marc runs HTS, the first Revalis Hospitality client.\nJay is Fred\'s son.';

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n`, e); process.exitCode = 1; }
}

(async () => {
  await t('a meeting in 20 minutes comes first, then a trip, then a person\'s mail', () => {
    const list = findNudges({ now: NOW.getTime(), isKnown: knownPeople(facts), mail: [jm], events: [
      { ts: NOW.getTime() + 20 * MIN, time: '14:20', title: 'Call with Jay' },
      { ts: NOW.getTime() + 20 * H, time: '10:00', title: 'Flight HV 5123 to Ibiza' },
    ] });
    assert.deepStrictEqual(list.map((n) => n.rank), [0, 1, 2]);
    assert.ok(list[2].prompt.includes('uid 77') && list[2].text.includes('Jean-Marc'));
  });

  await t("only Fred's people after 2 days; strangers wait 4; newsletters and no-reply never", () => {
    const isKnown = knownPeople(facts);
    assert.strictEqual(findNudges({ now: NOW.getTime(), isKnown, mail: [stranger] }).length, 0);
    assert.strictEqual(findNudges({ now: NOW.getTime(), isKnown, mail: [{ ...stranger, age_hours: 100 }] }).length, 1);
    assert.strictEqual(findNudges({ now: NOW.getTime(), isKnown, mail: [{ ...jm, from_email: 'noreply@x.com' }] }).length, 0);
    assert.strictEqual(findNudges({ now: NOW.getTime(), isKnown, mail: [{ ...jm, newsletter: true }] }).length, 0);
  });

  await t('a trip: once a few days ahead, once the day before; ordinary events never', () => {
    const at = (h, title) => findNudges({ now: NOW.getTime(), events: [{ ts: NOW.getTime() + h * H, title }] });
    assert.ok(at(5 * 24, 'Fly to Ibiza ✈')[0].key.startsWith('trip7:'));
    assert.ok(at(30, 'KL1234 Amsterdam')[0].key.startsWith('trip1:'));
    assert.strictEqual(at(30, 'Volume planning').length, 0);
    assert.strictEqual(at(3, 'Lunch at 1500 Bistro').length, 0);
  });

  const nudger = (over = {}) => {
    let clock = NOW;
    const said = [];
    const n = createNudger({ statePath: path.join(TMP, `n${seq++}.json`), now: () => clock, env: {},
      getEvents: async () => ({ events: [] }), getMail: async () => ({ messages: [jm] }), isKnown: knownPeople(facts),
      deliver: async (x) => { said.push(x); return true; }, ...over });
    return { n, said, step: (ms) => { clock = new Date(clock.getTime() + ms); } };
  };

  await t('each thing once; checks every 20 minutes; quiet at night', async () => {
    const { n, said, step } = nudger();
    assert.strictEqual(await n.tick(), 'said');
    assert.strictEqual(await n.tick(), 'not-yet');
    step(21 * MIN);
    assert.strictEqual(await n.tick(), 'nothing');
    assert.strictEqual(said.length, 1);
    const night = nudger({ now: () => new Date(2026, 10, 21, 23, 0) });
    assert.strictEqual(await night.n.tick(), 'outside-hours');
  });

  await t('in the zone: held, except a meeting about to start goes to the phone quietly', async () => {
    const quiet = [];
    const held = nudger({ zone: () => ({ zone: true, why: 'on a call' }), quietText: async (x) => { quiet.push(x); return true; } });
    assert.strictEqual(await held.n.tick(), 'held');
    assert.strictEqual(held.said.length + quiet.length, 0);
    const soon = nudger({ zone: () => ({ zone: true, why: 'on a call' }), quietText: async (x) => { quiet.push(x); return true; },
      getMail: async () => ({ messages: [] }), getEvents: async () => ({ events: [{ ts: NOW.getTime() + 15 * MIN, time: '14:15', title: 'HTS call' }] }) });
    assert.strictEqual(await soon.n.tick(), 'said');
    assert.strictEqual(quiet.length, 1);
    assert.strictEqual(soon.said.length, 0);
  });

  await t('the zone: a call app, or 10 busy minutes in a work app', async () => {
    let s = { app: 'zoom.us', title: '', idle: 300 };
    const z = createZoneWatcher({ sample: async () => s });
    await z.poll();
    assert.strictEqual(z.status().zone, true);
    const z2 = createZoneWatcher({ sample: async () => s });
    s = { app: 'Cursor', title: 'hannibal', idle: 5 };
    for (let i = 0; i < 7; i++) await z2.poll();
    assert.strictEqual(z2.status().zone, false);  // not 10 minutes yet
    for (let i = 0; i < 3; i++) await z2.poll();
    assert.strictEqual(z2.status().zone, true);
    s = { app: 'Safari', title: '', idle: 5 };
    for (let i = 0; i < 3; i++) await z2.poll();
    assert.strictEqual(z2.status().zone, false);
  });

  await t('not said yet (Fred mid-topic): kept in line and tried again in 2 minutes, most urgent first', async () => {
    let ok = false;
    const tried = [];
    const q = nudger({ deliver: async (x) => { tried.push(x.key); return ok; },
      getEvents: async () => ({ events: [{ ts: NOW.getTime() + 30 * MIN, time: '14:30', title: 'HTS call' }] }) });
    assert.strictEqual(await q.n.tick(), 'not-delivered');
    q.step(1 * MIN); assert.strictEqual(await q.n.tick(), 'not-yet');
    q.step(1 * MIN); ok = true; assert.strictEqual(await q.n.tick(), 'said');
    assert.deepStrictEqual(tried.map((k) => k.split(':')[0]), ['soon', 'soon'], 'the meeting first, both times');
    q.step(21 * MIN); assert.strictEqual(await q.n.tick(), 'said', 'then the mail, in a later gap');
    assert.ok(tried[2].startsWith('mail:'));
    q.step(21 * MIN); assert.strictEqual(await q.n.tick(), 'nothing', 'never the same one twice');
  });

  await t('a meeting in under 5 minutes is urgent', () => {
    const at = (m) => findNudges({ now: NOW.getTime(), events: [{ ts: NOW.getTime() + m * MIN, title: 'HTS call' }] })[0];
    assert.strictEqual(at(4).urgent, true);
    assert.strictEqual(at(20).urgent, false);
  });

  await t('the desk and the server share what was said', () => {
    const { n } = nudger();
    assert.strictEqual(n.markSaid(['mail:a', 'mail:b']), 2);
    assert.strictEqual(n.markSaid(['mail:a']), 0);
    assert.ok(n.said().includes('mail:b'));
  });

  await t('calendar.add: always asks Fred, and the question says what and when', () => {
    const tool = catalog.TOOLS ? catalog.TOOLS.find((x) => x.name === 'calendar.add') : (catalog.byName ? catalog.byName('calendar.add') : null)
      || (catalog.CATALOG || catalog.tools || []).find((x) => x.name === 'calendar.add');
    assert.ok(tool && tool.confirm === true && tool.permission.ceiling === 'never');
    const q = summarizeAction({ tool: 'calendar.add' }, { title: 'Call Jean-Marc', start: '2026-11-25T10:00', minutes: 30, location: 'Zoom' });
    assert.ok(/Call Jean-Marc/.test(q) && /25 November/.test(q) && /30 minutes/.test(q) && /book it\?/.test(q), q);
  });

  await t('buildEvent: UTC times, escaped text, all-day, refuses the past', () => {
    const now = new Date(2026, 10, 21, 10, 0).getTime();
    const e = buildEvent({ title: 'Call, Jay; HTS', start: '2026-11-25T10:00', minutes: 30, now });
    assert.ok(e.ok && /SUMMARY:Call\\, Jay\\; HTS/.test(e.ics) && /DTSTART:\d{8}T\d{6}Z/.test(e.ics), e.ics);
    assert.strictEqual(Date.parse(e.ics.match(/DTEND:(\S+)/)[1].replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z'))
      - Date.parse(e.ics.match(/DTSTART:(\S+)/)[1].replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z')), 30 * MIN);
    assert.ok(/DTSTART;VALUE=DATE:20261128/.test(buildEvent({ title: 'Ibiza', start: '2026-11-28', now }).ics));
    assert.strictEqual(buildEvent({ title: 'x', start: '2026-11-01T10:00', now }).ok, false);
    assert.strictEqual(buildEvent({ title: '', start: '2026-11-25T10:00', now }).ok, false);
  });

  console.log(`${passed} passed`);
})();
