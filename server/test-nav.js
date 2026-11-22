// TEST — navigation: Google Maps routes, drive times from the phone, "time to leave".
// Run: node server/test-nav.js
'use strict';
const assert = require('assert');
const { createNav, mapsUrl, fmtMinutes } = require('./nav');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.stack || e.message}`); process.exitCode = 1; }
}

(async () => {
  console.log('nav');
  const T0 = Date.parse('2026-11-23T09:00:00Z');

  await test('Google Maps link and readable minutes', () => {
    assert.strictEqual(mapsUrl('Ibiza airport'), 'https://www.google.com/maps/dir/?api=1&destination=Ibiza%20airport&travelmode=driving&dir_action=navigate');
    assert.strictEqual(fmtMinutes(23), '23 min');
    assert.strictEqual(fmtMinutes(90), '1 h 30 min');
  });

  await test('go: opened on the phone, or a link when it is unreachable', () => {
    let where = 'opened';
    const nav = createNav({ phone: { navigate: () => where, ask: async () => null } });
    assert.match(nav.go('Ibiza airport').note, /opening/);
    where = 'none';
    const r = nav.go('Ibiza airport');
    assert.ok(r.ok && /maps\/dir/.test(r.url) && /not reachable/.test(r.note));
    assert.strictEqual(nav.go('').ok, false);
  });

  await test('eta: the phone answers with minutes; no answer is said plainly', async () => {
    let ans = { ok: true, minutes: 23.4, km: 18.27, place: 'Home' };
    const nav = createNav({ phone: { navigate: () => 'none', ask: async (k, p) => (k === 'eta' && p.destination === 'Home' ? ans : null) }, now: () => T0, tz: () => 'Europe/Madrid' });
    const r = await nav.eta('Home');
    assert.strictEqual(r.minutes, 23); assert.strictEqual(r.drive, '23 min'); assert.strictEqual(r.km, 18.3); assert.strictEqual(r.arriveAt, '10:23');
    ans = null;
    assert.match((await nav.eta('Home')).error, /could not reach/);
  });

  await test('time to leave: told once, with the route; late is said as late', async () => {
    let t = T0;
    const told = [];
    let minutes = 30;
    const ev = { ts: T0 + 90 * 60e3, title: 'Lunch with Jay', time: '11:30', location: 'Can Pujol, Sant Josep', uid: 'u1' };
    const nav = createNav({
      phone: { navigate: () => 'none', ask: async () => ({ ok: true, minutes }) },
      events: async () => ({ ok: true, events: [ev, { ts: T0 + 60e3, title: 'Call', time: '10:01' }, { ...ev, uid: 'u2', allDay: true }] }),
      notify: async (text, o) => told.push([text, o.url]),
      now: () => t,
    });
    await nav.tick();                       // leave at 10:50 local: too early
    assert.strictEqual(told.length, 0);
    t = T0 + 52 * 60e3; await nav.tick();   // past 10:50
    assert.strictEqual(told.length, 1);
    assert.match(told[0][0], /Time to leave for "Lunch with Jay" at 11:30: 30 min/);
    assert.match(told[0][1], /Can%20Pujol/);
    t += 5 * 60e3; await nav.tick();
    assert.strictEqual(told.length, 1, 'only once');
    // Another appointment, already too late.
    ev.uid = 'u3'; minutes = 60; await nav.tick();
    assert.strictEqual(told.length, 2);
    assert.match(told[1][0], /You'll be late for "Lunch with Jay"/);
  });

  await test('already there (a few minutes away): no warning', async () => {
    const told = [];
    const nav = createNav({
      phone: { navigate: () => 'none', ask: async () => ({ ok: true, minutes: 2 }) },
      events: async () => ({ ok: true, events: [{ ts: T0 + 5 * 60e3, title: 'Meeting', time: '10:05', location: 'Office', uid: 'm' }] }),
      notify: async (text) => told.push(text), now: () => T0,
    });
    await nav.tick();
    assert.strictEqual(told.length, 0);
  });

  console.log(process.exitCode ? 'some FAILED' : `${passed} passed`);
})();
