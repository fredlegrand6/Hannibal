// ─────────────────────────────────────────────────────────────────────────
// CALENDAR ACCOUNT: where Hannibal reads and books Fred's calendar.
//
// Apple Calendar (iCloud) when ICLOUD_EMAIL + ICLOUD_APP_PW are in .env: an
// app-specific password from account.apple.com, never the Apple ID password.
// Works the same on the Mac and on the always-on server (plain CalDAV).
//   • reads: every iCloud calendar that holds events (Home, Work, shared ones);
//   • bookings: ICLOUD_CALENDAR (a calendar's name, e.g. "Home") or else the
//     first one Fred may write to (not a read-only shared calendar).
// Otherwise the old Nextcloud settings (NEXTCLOUD_URL/USER/APP_PW/CALENDAR).
//
// iCloud has no fixed address per account, so it is discovered once
// (principal → calendar home → calendars) and remembered for an hour.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const ICLOUD = 'https://caldav.icloud.com';
const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

// <response> blocks of a multistatus answer, whatever the namespace prefixes.
function responses(xml) {
  return String(xml || '').split(/<(?:[a-z0-9]+:)?response[\s>]/i).slice(1);
}
const tag = (block, name) => {
  const m = String(block || '').match(new RegExp(`<(?:[a-z0-9]+:)?${name}[^>]*>([\\s\\S]*?)</(?:[a-z0-9]+:)?${name}>`, 'i'));
  return m ? m[1] : null;
};
const hrefIn = (block) => { const h = tag(block, 'href'); return h ? h.trim() : null; };
const unxml = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').trim();

// The calendars in a calendar-home listing that hold events.
function parseCalendars(xml, base) {
  const out = [];
  for (const r of responses(xml)) {
    const href = hrefIn(r);
    const type = tag(r, 'resourcetype') || '';
    if (!href || !/calendar/i.test(type)) continue;            // not a calendar (the home itself, inbox, outbox)
    const comps = tag(r, 'supported-calendar-component-set');
    if (comps && !/VEVENT/i.test(comps)) continue;              // reminders/tasks lists
    if (/<[^>]*(schedule-inbox|schedule-outbox)/i.test(type)) continue;
    // Shared read-only calendars stay readable but must not take bookings. No privilege
    // list at all = the server did not say, assume it is ours.
    const priv = tag(r, 'current-user-privilege-set');
    const writable = priv == null || /<(?:[a-z0-9]+:)?(write|write-content|all)\s*\/?>/i.test(priv);
    out.push({ url: new URL(href, base).toString(), name: unxml(tag(r, 'displayname')) || href.split('/').filter(Boolean).pop(), writable });
  }
  return out;
}

function createCalendarAccount({ env = process.env, fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = {}) {
  let cache = null;   // { at, account }

  async function propfind(url, auth, depth, props) {
    const body = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>${props}</d:prop></d:propfind>`;
    const res = await fetchImpl(url, { method: 'PROPFIND', headers: { Authorization: auth, Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' }, body, signal: AbortSignal.timeout(15000) });
    if (res.status === 401) throw new Error('Apple refused the login: check ICLOUD_EMAIL and the app-specific password ICLOUD_APP_PW');
    if (!res.ok && res.status !== 207) throw new Error(`caldav ${res.status}`);
    return { text: await res.text(), url: res.url || url };
  }

  async function icloud() {
    const auth = basic(env.ICLOUD_EMAIL.trim(), env.ICLOUD_APP_PW.trim());
    const p = await propfind(`${ICLOUD}/`, auth, 0, '<d:current-user-principal/>');
    const principal = hrefIn(tag(p.text, 'current-user-principal'));
    if (!principal) throw new Error('iCloud did not say where the calendars are');
    const principalUrl = new URL(principal, p.url).toString();
    const h = await propfind(principalUrl, auth, 0, '<c:calendar-home-set/>');
    const home = hrefIn(tag(h.text, 'calendar-home-set'));
    if (!home) throw new Error('iCloud has no calendar home for this account');
    const homeUrl = new URL(home, principalUrl).toString();
    const l = await propfind(homeUrl, auth, 1, '<d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><d:current-user-privilege-set/>');
    const calendars = parseCalendars(l.text, homeUrl);
    if (!calendars.length) throw new Error('no iCloud calendar with events found');
    const want = String(env.ICLOUD_CALENDAR || '').trim().toLowerCase();
    const own = calendars.filter((c) => c.writable);
    const write = (want && calendars.find((c) => c.name.toLowerCase() === want)) || own[0] || calendars[0];
    return { kind: 'icloud', auth, read: calendars, write };
  }

  function nextcloud() {
    const base = (env.NEXTCLOUD_URL || '').replace(/\/$/, '');
    const user = env.NEXTCLOUD_USER, pw = env.NEXTCLOUD_APP_PW;
    if (!base || !user || !pw) return null;
    const cal = { url: `${base}/remote.php/dav/calendars/${encodeURIComponent(user)}/${env.NEXTCLOUD_CALENDAR || 'personal'}/`, name: env.NEXTCLOUD_CALENDAR || 'personal' };
    return { kind: 'nextcloud', auth: basic(user, pw), read: [cal], write: cal };
  }

  // The account to use now, or { error }.
  async function get() {
    if (env.ICLOUD_EMAIL && env.ICLOUD_APP_PW) {
      if (cache && now() - cache.at < 3600 * 1000) return cache.account;
      try {
        const account = await icloud();
        cache = { at: now(), account };
        console.log(`[calendar] Apple Calendar: ${account.read.map((c) => c.name).join(', ')} (bookings go to ${account.write.name})`);
        return account;
      } catch (e) { return { error: e.message }; }
    }
    return nextcloud() || { error: 'no calendar set up: put ICLOUD_EMAIL and ICLOUD_APP_PW (an app-specific password) in .env' };
  }

  return { get, forget: () => { cache = null; } };
}

module.exports = { createCalendarAccount, parseCalendars, responses };
