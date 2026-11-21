// ─────────────────────────────────────────────────────────────────────────
// TEST: Apple Calendar over CalDAV (caldav.js + info-handlers calendar IPC).
// Offline: a fake iCloud answers. Run:  node electron/services/test-caldav.js
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const assert = require('assert');
const { createCalendarAccount, parseCalendars } = require('./caldav');

const ms = (inner) => `<?xml version="1.0"?><multistatus xmlns="DAV:">${inner}</multistatus>`;
const HOME_LIST = ms(`
<response><href>/123/calendars/</href><propstat><prop><resourcetype><collection/></resourcetype></prop></propstat></response>
<response><href>/123/calendars/home/</href><propstat><prop><displayname>Home</displayname><resourcetype><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype><supported-calendar-component-set xmlns="urn:ietf:params:xml:ns:caldav"><comp name="VEVENT"/></supported-calendar-component-set></prop></propstat></response>
<response><href>/123/calendars/work/</href><propstat><prop><displayname>Work &amp; Revalis</displayname><resourcetype><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype><supported-calendar-component-set xmlns="urn:ietf:params:xml:ns:caldav"><comp name="VEVENT"/><comp name="VTODO"/></supported-calendar-component-set></prop></propstat></response>
<response><href>/123/calendars/tasks/</href><propstat><prop><displayname>Reminders</displayname><resourcetype><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype><supported-calendar-component-set xmlns="urn:ietf:params:xml:ns:caldav"><comp name="VTODO"/></supported-calendar-component-set></prop></propstat></response>
<response><href>/123/calendars/inbox/</href><propstat><prop><resourcetype><collection/><schedule-inbox xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype></prop></propstat></response>`);

function fakeIcloud({ status = 207 } = {}) {
  const calls = [];
  const res = (text, st = 207, url) => ({ status: st, ok: st >= 200 && st < 300, url, text: async () => text });
  const impl = async (url, o) => {
    calls.push({ url, method: o.method, depth: o.headers.Depth, auth: o.headers.Authorization });
    if (status !== 207) return res('', status);
    if (url === 'https://caldav.icloud.com/') return res(ms('<response><href>/</href><propstat><prop><current-user-principal><href>/123/principal/</href></current-user-principal></prop></propstat></response>'), 207, 'https://p42-caldav.icloud.com/');
    if (url === 'https://p42-caldav.icloud.com/123/principal/') return res(ms('<response><href>/123/principal/</href><propstat><prop><C:calendar-home-set xmlns:C="urn:ietf:params:xml:ns:caldav"><href>https://p42-caldav.icloud.com/123/calendars/</href></C:calendar-home-set></prop></propstat></response>'));
    if (url === 'https://p42-caldav.icloud.com/123/calendars/') return res(HOME_LIST);
    return res('', 404);
  };
  return { impl, calls };
}

(async () => {
  let n = 0;
  const t = async (name, fn) => { await fn(); n += 1; console.log(`  ok  ${name}`); };

  await t('parseCalendars keeps only event calendars', () => {
    const c = parseCalendars(HOME_LIST, 'https://p42-caldav.icloud.com/123/calendars/');
    assert.deepStrictEqual(c.map((x) => x.name), ['Home', 'Work & Revalis']);
    assert.strictEqual(c[0].url, 'https://p42-caldav.icloud.com/123/calendars/home/');
  });

  await t('iCloud discovery: principal → home → calendars, bookings to ICLOUD_CALENDAR', async () => {
    const f = fakeIcloud();
    const acc = createCalendarAccount({ env: { ICLOUD_EMAIL: ' fred@example.com ', ICLOUD_APP_PW: 'abcd-efgh-ijkl-mnop', ICLOUD_CALENDAR: 'work & revalis' }, fetchImpl: f.impl });
    const a = await acc.get();
    assert.strictEqual(a.kind, 'icloud');
    assert.strictEqual(a.read.length, 2);
    assert.strictEqual(a.write.name, 'Work & Revalis');
    assert.strictEqual(a.auth, 'Basic ' + Buffer.from('fred@example.com:abcd-efgh-ijkl-mnop').toString('base64'));
    assert.deepStrictEqual(f.calls.map((c) => c.depth), ['0', '0', '1']);
    await acc.get();                                   // cached: no new calls
    assert.strictEqual(f.calls.length, 3);
  });

  await t('no ICLOUD_CALENDAR: first event calendar takes bookings', async () => {
    const a = await createCalendarAccount({ env: { ICLOUD_EMAIL: 'x@y.z', ICLOUD_APP_PW: 'p' }, fetchImpl: fakeIcloud().impl }).get();
    assert.strictEqual(a.write.name, 'Home');
  });

  await t('a read-only shared calendar is read but never takes bookings by default', () => {
    const ro = '<current-user-privilege-set><privilege><read/></privilege></current-user-privilege-set>';
    const rw = '<current-user-privilege-set><privilege><read/></privilege><privilege><write/></privilege></current-user-privilege-set>';
    const xml = HOME_LIST.replace('<displayname>Home</displayname>', `<displayname>Home</displayname>${ro}`)
      .replace('<displayname>Work &amp; Revalis</displayname>', `<displayname>Work &amp; Revalis</displayname>${rw}`);
    const c = parseCalendars(xml, 'https://p42-caldav.icloud.com/123/calendars/');
    assert.deepStrictEqual(c.map((x) => [x.name, x.writable]), [['Home', false], ['Work & Revalis', true]]);
  });

  await t('wrong password says so plainly', async () => {
    const a = await createCalendarAccount({ env: { ICLOUD_EMAIL: 'x@y.z', ICLOUD_APP_PW: 'bad' }, fetchImpl: fakeIcloud({ status: 401 }).impl }).get();
    assert.match(a.error, /Apple refused the login/);
  });

  await t('nothing set up: clear error; Nextcloud still works as a fallback', async () => {
    assert.match((await createCalendarAccount({ env: {} }).get()).error, /ICLOUD_EMAIL/);
    const a = await createCalendarAccount({ env: { NEXTCLOUD_URL: 'https://nc.example/', NEXTCLOUD_USER: 'fred', NEXTCLOUD_APP_PW: 'p' } }).get();
    assert.strictEqual(a.kind, 'nextcloud');
    assert.strictEqual(a.write.url, 'https://nc.example/remote.php/dav/calendars/fred/personal/');
  });

  await t('calendar IPC reads all calendars (expanded) and books into the chosen one', async () => {
    const handlers = {};
    const ipc = { handle: (ch, fn) => { handlers[ch] = fn; } };
    const account = {
      get: async () => ({ kind: 'icloud', auth: 'Basic x',
        read: [{ url: 'https://c/home/', name: 'Home' }, { url: 'https://c/work/', name: 'Work' }, { url: 'https://c/notification/', name: 'notification' }],
        write: { url: 'https://c/work/', name: 'Work' } }),
      forget: () => {},
    };
    const soon = new Date(Date.now() + 3 * 3600 * 1000);
    const z = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const ev = (title, uid = title) => `<cal:calendar-data><![CDATA[BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART:${z(soon)}\r\nSUMMARY:${title}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n]]></cal:calendar-data>`;
    const seen = [];
    const realFetch = global.fetch;
    global.fetch = async (url, o) => {
      seen.push({ url, method: o.method, body: o.body });
      if (o.method === 'PUT') return { ok: true, status: 201, text: async () => '' };
      if (url.includes('notification')) return { ok: false, status: 403, text: async () => '' };   // iCloud's odd one
      const body = url.includes('home') ? ev('Dinner with Gaian') + ev('Shared invite') + ev('Appointment', 'a-home') : ev('Shared invite') + ev('Appointment', 'a-work');
      return { ok: false, status: 207, text: async () => ms(`<response><href>/e.ics</href><propstat><prop xmlns:cal="urn:ietf:params:xml:ns:caldav">${body}</prop></propstat></response>`) };
    };
    try {
      require('./info-handlers').registerInfo(ipc, { calendarAccount: account, python: 'python3' });
      const r = await handlers['calendar:events']({}, 2);
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      // the copied invite (same UID) once; two different "Appointment"s at the same time both stay
      assert.deepStrictEqual(r.events.map((e) => e.title).sort(), ['Appointment', 'Appointment', 'Dinner with Gaian', 'Shared invite']);
      assert.ok(seen.every((s) => /<c:expand /.test(s.body)), 'asks the server to expand recurring events');
      const pad = (x) => String(x).padStart(2, '0');
      const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
      const start = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}T10:00`;
      const b = await handlers['calendar:add']({}, 'Call Jean-Marc', start, 30);
      assert.strictEqual(b.ok, true, JSON.stringify(b));
      assert.strictEqual(b.calendar, 'Work');
      const put = seen.find((s) => s.method === 'PUT');
      assert.match(put.url, /^https:\/\/c\/work\/[^/]+\.ics$/);
    } finally { global.fetch = realFetch; }
  });

  await t('move rewrites only the times (keeps alarm, notes, timezone block) and keeps the length', () => {
    const { moveEvent } = require('./info-handlers');
    const ics = ['BEGIN:VCALENDAR', 'BEGIN:VTIMEZONE', 'TZID:Europe/Madrid', 'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'END:STANDARD', 'END:VTIMEZONE',
      'BEGIN:VEVENT', 'UID:abc', 'DTSTAMP:20261101T000000Z', 'DTSTART;TZID=Europe/Madrid:20261122T110000', 'DTEND;TZID=Europe/Madrid:20261122T113000',
      'SEQUENCE:2', 'SUMMARY:Call with Jay', 'DESCRIPTION:bring the deck', 'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
    const r = moveEvent(ics, { start: '2026-11-23T15:00', now: new Date(2026, 10, 21).getTime() });
    assert.ok(r.ok, JSON.stringify(r));
    assert.match(r.when, /Monday 23 November.*15:00 \(30 min\)/);
    const lines = r.ics.split('\r\n');
    assert.strictEqual(lines.filter((l) => l.startsWith('DTSTART')).length, 2, 'the timezone block keeps its own DTSTART');
    assert.ok(lines.includes('DTSTART:19701025T030000'));
    assert.ok(lines.some((l) => /^DTSTART:20261123T\d{6}Z$/.test(l)));
    assert.ok(lines.includes('SEQUENCE:3') && lines.includes('DESCRIPTION:bring the deck') && lines.includes('TRIGGER:-PT15M'));
    assert.ok(!lines.some((l) => l.includes('TZID=Europe/Madrid:2026112')));
    assert.ok(!moveEvent(ics, { start: '2020-01-01T10:00' }).ok, 'no moving into the past');
  });

  await t('delete and move find the event by id, check the title, refuse repeating events', async () => {
    const handlers = {};
    const ipc = { handle: (ch, fn) => { handlers[ch] = fn; } };
    const account = { get: async () => ({ kind: 'icloud', auth: 'Basic x', read: [{ url: 'https://c/werk/', name: 'Werk', writable: true }], write: { url: 'https://c/werk/', name: 'Werk' } }), forget: () => {} };
    const obj = (uid, title, extra = '') => `<response><href>/werk/${uid}.ics</href><propstat><prop><getetag>"e-${uid}"</getetag><C:calendar-data xmlns:C="urn:ietf:params:xml:ns:caldav">BEGIN:VCALENDAR&#13;
BEGIN:VEVENT&#13;
UID:${uid}&#13;
DTSTART:20991122T100000Z&#13;
DTEND:20991122T110000Z&#13;
SUMMARY:${title}&#13;
${extra}END:VEVENT&#13;
END:VCALENDAR&#13;
</C:calendar-data></prop></propstat></response>`;
    const store = { jay: obj('jay', 'Call with Jay'), gym: obj('gym', 'Gym', 'RRULE:FREQ=WEEKLY&#13;\n') };
    const seen = [];
    const realFetch = global.fetch;
    global.fetch = async (url, o) => {
      seen.push({ url, method: o.method, headers: o.headers, body: o.body });
      if (o.method === 'REPORT') { const uid = (o.body.match(/i;octet">([^<]+)</) || [])[1]; return { ok: false, status: 207, text: async () => ms(store[uid] || '') }; }
      return { ok: true, status: 204, text: async () => '' };
    };
    try {
      require('./info-handlers').registerInfo(ipc, { calendarAccount: account, python: 'python3' });
      let r = await handlers['calendar:delete']({}, 'jay', 'Gym');
      assert.ok(!r.ok && /belongs to "Call with Jay"/.test(r.error), 'wrong title: nothing deleted');
      r = await handlers['calendar:delete']({}, 'gym', 'Gym');
      assert.ok(!r.ok && /repeats/.test(r.error));
      r = await handlers['calendar:delete']({}, 'nope', 'X');
      assert.ok(!r.ok && /not in the calendar/.test(r.error));
      assert.ok(!seen.some((x) => x.method === 'DELETE'));
      r = await handlers['calendar:delete']({}, 'jay', 'call with jay');
      assert.ok(r.ok, JSON.stringify(r));
      const del = seen.find((x) => x.method === 'DELETE');
      assert.strictEqual(del.url, 'https://c/werk/jay.ics'); assert.strictEqual(del.headers['If-Match'], '"e-jay"');
      r = await handlers['calendar:move']({}, 'jay', '2099-11-23T15:00', undefined, 'Call with Jay');
      assert.ok(r.ok, JSON.stringify(r));
      const put = seen.find((x) => x.method === 'PUT');
      assert.match(put.body, /DTSTART:2099112\dT\d{6}Z\r\nDTEND:/); assert.match(put.body, /SEQUENCE:1/);
      assert.match(r.when, /\(60 min\)/);
    } finally { global.fetch = realFetch; }
  });

  await t('the questions Fred hears', () => {
    const { summarizeAction } = require('./agent/executor');
    assert.match(summarizeAction({ tool: 'calendar.delete' }, { id: 'x', title: 'Call with Jay', when: 'tomorrow 11:00' }), /Delete “Call with Jay” \(tomorrow 11:00\) from your calendar — delete it\?/);
    assert.match(summarizeAction({ tool: 'calendar.move' }, { id: 'x', title: 'Call with Jay', start: '2026-11-23T15:00' }), /Move “Call with Jay” to Monday 23 November.*15:00 — move it\?/);
  });

  console.log(`caldav: ${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
