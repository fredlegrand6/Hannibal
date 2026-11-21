// ─────────────────────────────────────────────────────────────────────────
// WHATSAPP SEND — the reliable way.
//
// The old sender drove WhatsApp's search box by UI scripting. When the name did
// not match a row it pressed Return on the TOP result, so a message could go to
// the wrong person. Now:
//   1. contacts.find looks the person up in Fred's macOS Contacts and in
//      WhatsApp's own address book and chat list (name → number).
//   2. whatsapp.send opens whatsapp://send?phone=<number>&text=<message>, which
//      opens exactly that person's chat with the text ready, then presses Return.
//   3. It checks its own work: the message must show up as a sent bubble.
// A name that matches several people, or nobody, is refused with the list, so
// Claude asks Fred which one he means. Nothing is ever sent on a guess.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const { execFile } = require('child_process');

const osa = (script, timeout = 30000) => new Promise((resolve) => {
  execFile('osascript', ['-e', script], { timeout }, (err, stdout, stderr) => {
    if (err) resolve({ ok: false, error: String(stderr || err.message).trim() });
    else resolve({ ok: true, out: String(stdout || '').trim() });
  });
});
const asStr = (s) => '"' + String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ') + '"';

// "+31 6 1234 5678" / "06-12345678" → "31612345678" (digits, country code first).
function normalizeNumber(raw, defaultCountry = '31') {
  let s = String(raw || '').replace(/[^\d+]/g, '');
  if (!s) return '';
  if (s.startsWith('+')) return s.slice(1);
  if (s.startsWith('00')) return s.slice(2);
  if (s.startsWith('0')) return defaultCountry + s.slice(1);
  return s;
}

const cleanLabel = (l) => String(l || '').replace(/^_\$!<|>!\$_$/g, '').toLowerCase();

// Output of the Contacts script: one person per line, "Name\tlabel=value;label=value;".
function parseContacts(out) {
  const people = [];
  for (const line of String(out || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [name, rest = ''] = line.split('\t');
    const phones = rest.split(';').filter(Boolean).map((p) => {
      const i = p.indexOf('=');
      return { label: cleanLabel(p.slice(0, i)), number: p.slice(i + 1).trim() };
    }).filter((p) => p.number);
    people.push({ name: name.trim(), phones });
  }
  return people;
}

// The number to WhatsApp: a mobile one first, else the only one, else none.
function pickPhone(person) {
  const ps = (person && person.phones) || [];
  const mobile = ps.find((p) => /mobile|mobiel|iphone|cell|gsm|whatsapp/.test(p.label));
  if (mobile) return mobile.number;
  return ps.length === 1 ? ps[0].number : (ps[0] ? ps[0].number : '');
}

// WhatsApp's own address book and chat list (the Mac app keeps them in local
// SQLite files). Read-only. Many of Fred's people are only there, not in the
// Mac's Contacts. Returns [{ name, number, source:'whatsapp' }].
const os = require('os');
const path = require('path');
const WA_DIR = path.join(os.homedir(), 'Library', 'Group Containers', 'group.net.whatsapp.WhatsApp.shared');
const sqlite = (file, sql) => new Promise((resolve) => {
  execFile('sqlite3', ['-readonly', '-separator', '\t', file, sql], { timeout: 10000 }, (err, stdout) => resolve(err ? null : String(stdout || '')));
});
async function findInWhatsApp(query, { query: q2 = sqlite, dir = WA_DIR } = {}) {
  const like = `'%${String(query || '').replace(/'/g, "''").replace(/[%_]/g, '')}%'`;
  const [book, chats] = await Promise.all([
    q2(path.join(dir, 'ContactsV2.sqlite'), `select coalesce(nullif(ZFULLNAME,''), trim(coalesce(ZGIVENNAME,'')||' '||coalesce(ZLASTNAME,''))), coalesce(nullif(ZWHATSAPPID,''), ZPHONENUMBER) from ZWAADDRESSBOOKCONTACT where ZFULLNAME like ${like} or ZGIVENNAME like ${like} or ZLASTNAME like ${like} or ZBUSINESSNAME like ${like};`),
    q2(path.join(dir, 'ChatStorage.sqlite'), `select ZPARTNERNAME, ZCONTACTJID from ZWACHATSESSION where ZSESSIONTYPE = 0 and ZCONTACTJID like '%@s.whatsapp.net' and ZPARTNERNAME like ${like};`),
  ]);
  if (book == null && chats == null) return null;   // WhatsApp's files could not be read
  const out = [];
  for (const line of `${book || ''}\n${chats || ''}`.split(/\r?\n/)) {
    const [name, raw] = line.split('\t');
    const number = String(raw || '').split('@')[0].replace(/[^\d+]/g, '');
    if (!name || !number) continue;
    out.push({ name: name.trim(), number: number.startsWith('+') ? number : `+${number}`, source: 'whatsapp' });
  }
  return out;
}

async function findContacts(query, { run = osa, whatsapp = findInWhatsApp } = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'who should I look up?' };
  const r = await run(`tell application "Contacts"
  set out to ""
  repeat with p in (every person whose name contains ${asStr(q)})
    set ln to (name of p) & tab
    repeat with ph in (phones of p)
      set ln to ln & (label of ph) & "=" & (value of ph) & ";"
    end repeat
    set out to out & ln & linefeed
  end repeat
  return out
end tell`);
  const mac = r.ok ? parseContacts(r.out).map((p) => ({ name: p.name, number: pickPhone(p), phones: p.phones, source: 'contacts' })) : [];
  const wa = (await whatsapp(q).catch(() => null)) || [];
  if (!r.ok && !wa.length) return { ok: false, error: /not allowed|-1743|authoriz/i.test(r.error) ? 'Hannibal is not allowed to read Contacts yet: allow it in System Settings → Privacy & Security → Contacts' : `Contacts: ${r.error}` };
  // One entry per number: the Mac's Contacts first, then WhatsApp's own list.
  const seen = new Set(); const people = [];
  for (const p of [...mac, ...wa]) {
    const key = normalizeNumber(p.number) || `name:${p.name.toLowerCase()}`;
    if (seen.has(key)) continue; seen.add(key); people.push(p);
  }
  return { ok: true, people };
}

// Pick the one person a send goes to, or explain why not.
function resolveRecipient(people, contact) {
  const withNumber = people.filter((p) => p.number);
  const exact = withNumber.filter((p) => p.name.toLowerCase() === String(contact || '').trim().toLowerCase());
  const pick = exact.length === 1 ? exact : withNumber;
  if (pick.length === 1) return { ok: true, name: pick[0].name, number: pick[0].number };
  if (!pick.length) return { ok: false, error: people.length ? `${people.map((p) => p.name).join(', ')} has no phone number in Contacts` : `nobody called "${contact}" in Fred's Contacts` };
  return { ok: false, error: `"${contact}" matches ${pick.length} people: ask Fred which one`, matches: pick.map((p) => ({ name: p.name, number: p.number })) };
}

const SCAN = `on scanForText(parent, target, depth, maxDepth)
  global gFoundBubble, gFoundField
  if depth > maxDepth then return
  tell application "System Events"
    try
      repeat with k in (UI elements of parent)
        try
          set hay to ""
          try
            set hay to hay & " " & ((value of k) as string)
          end try
          try
            set hay to hay & " " & ((description of k) as string)
          end try
          set isHit to false
          ignoring case
            if hay contains target then set isHit to true
          end ignoring
          if isHit then
            set rr to ""
            try
              set rr to (value of attribute "AXRole" of k) as string
            end try
            if rr is "AXTextArea" then
              set gFoundField to true
            else
              set gFoundBubble to true
            end if
          end if
          my scanForText(k, target, depth + 1, maxDepth)
        end try
      end repeat
    end try
  end tell
end scanForText`;

async function sendWhatsApp({ contact, number, message } = {}, { run = osa, find = findContacts } = {}) {
  const msg = String(message || '').trim();
  if (!msg) return { ok: false, error: 'no message to send' };
  let name = String(contact || '').trim(), num = normalizeNumber(number);
  if (!num) {
    if (!name) return { ok: false, error: 'who should it go to?' };
    const found = await find(name, { run });
    if (!found.ok) return found;
    const who = resolveRecipient(found.people, name);
    if (!who.ok) return who;
    name = who.name; num = normalizeNumber(who.number);
  }
  if (!/^\d{8,15}$/.test(num)) return { ok: false, error: `"${number || num}" is not a phone number WhatsApp can use` };
  const url = `whatsapp://send?phone=${num}&text=${encodeURIComponent(msg)}`;
  const probe = msg.slice(0, 24);
  const r = await run(`global gFoundBubble, gFoundField
${SCAN}

do shell script "open " & quoted form of ${asStr(url)}
delay 3
tell application "WhatsApp" to activate
delay 0.5
tell application "System Events"
  tell process "WhatsApp"
    set frontmost to true
    delay 0.4
    key code 36
    delay 1.5
    set gFoundBubble to false
    set gFoundField to false
    my scanForText(window 1, ${asStr(probe)}, 0, 22)
    if gFoundBubble then return "SENT"
    if gFoundField then return "NOT_SENT"
    return "UNSURE"
  end tell
end tell`, 45000);
  if (!r.ok) return { ok: false, error: `WhatsApp: ${r.error}` };
  console.log(`[whatsapp] to ${name || num}: ${r.out}`);
  if (r.out === 'SENT') return { ok: true, verified: true, to: name || `+${num}`, number: `+${num}` };
  if (r.out === 'NOT_SENT') return { ok: false, verified: false, error: 'the message is still in the text box: WhatsApp did not send it' };
  return { ok: false, verified: false, error: 'I could not see the message in the chat after sending: check WhatsApp' };
}

module.exports = { normalizeNumber, parseContacts, pickPhone, resolveRecipient, findContacts, findInWhatsApp, sendWhatsApp };
