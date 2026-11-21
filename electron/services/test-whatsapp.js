'use strict';
const assert = require('assert');
const wa = require('./whatsapp');
const wa_ = wa;
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('  ok ', name); };

(async () => {
  await t('numbers become plain international digits', () => {
    assert.strictEqual(wa.normalizeNumber('+31 6 1234 5678'), '31612345678');
    assert.strictEqual(wa.normalizeNumber('06-12345678'), '31612345678');
    assert.strictEqual(wa.normalizeNumber('0034 600 123 456'), '34600123456');
  });
  await t('contacts are parsed and a mobile number is preferred', () => {
    const people = wa.parseContacts('Jay Legrand\t_$!<Home>!$_=+31 20 123 4567;_$!<Mobile>!$_=+31 6 1111 2222;\nJohn Smith\tiPhone=+34 600 111 222;\n');
    assert.strictEqual(people.length, 2);
    assert.strictEqual(wa.pickPhone(people[0]), '+31 6 1111 2222');
    assert.strictEqual(wa.pickPhone(people[1]), '+34 600 111 222');
  });
  await t('one person or nothing: several matches are handed back, never guessed', () => {
    const two = [{ name: 'Jay Legrand', number: '+31611112222' }, { name: 'Jay Brown', number: '+31633334444' }];
    let r = wa.resolveRecipient(two, 'Jay');
    assert.ok(!r.ok && r.matches.length === 2 && /ask Fred/.test(r.error));
    r = wa.resolveRecipient(two, 'jay legrand');
    assert.ok(r.ok && r.number === '+31611112222');
    assert.ok(!wa.resolveRecipient([], 'Nobody').ok);
    assert.ok(/no phone number/.test(wa.resolveRecipient([{ name: 'Mandy', number: '' }], 'Mandy').error));
  });
  await t('send opens exactly that chat by number and reports what it saw', async () => {
    const scripts = [];
    const run = async (s) => { scripts.push(s); return { ok: true, out: 'SENT' }; };
    let r = await wa.sendWhatsApp({ contact: 'Jay Legrand', number: '+31 6 1111 2222', message: 'Running late, 10 min "ok"?' }, { run });
    assert.ok(r.ok && r.verified && r.number === '+31611112222', JSON.stringify(r));
    assert.match(scripts[0], /whatsapp:\/\/send\?phone=31611112222&text=Running%20late%2C%2010%20min%20%5C"ok%5C"%3F|whatsapp:\/\/send\?phone=31611112222&text=Running%20late%2C%2010%20min%20%22ok%22%3F/);
    assert.doesNotMatch(scripts[0], /keystroke "f" using command down/, 'no search box any more');
    r = await wa.sendWhatsApp({ contact: 'Jay', number: '+316', message: 'x' }, { run });
    assert.ok(!r.ok, 'a too-short number is refused');
    r = await wa.sendWhatsApp({ contact: 'Jay', message: 'x' }, { run: async () => ({ ok: true, out: 'NOT_SENT' }), find: async () => ({ ok: true, people: [{ name: 'Jay Legrand', number: '+31611112222' }] }) });
    assert.ok(!r.ok && r.verified === false && /still in the text box/.test(r.error));
    r = await wa.sendWhatsApp({ contact: 'Jay', message: 'x' }, { run, find: async () => ({ ok: true, people: [{ name: 'Jay A', number: '1' }, { name: 'Jay B', number: '2' }] }) });
    assert.ok(!r.ok && r.matches, 'two Jays: nothing sent');
  });
  await t('people only in WhatsApp are found too, one entry per number', async () => {
    const fakeSql = async (file, sql) => {
      assert.ok(!/;\s*\w/.test(sql.replace(/;\s*$/, '')), 'one statement only');
      if (/ContactsV2/.test(file)) return 'Mandy Legrand\t+31 6 5555 0000\n';
      return 'Mandy\t31655550000@s.whatsapp.net\nMandy Gym\t31611110000@s.whatsapp.net\n';
    };
    const wa = await wa_.findInWhatsApp("Man'dy", { query: fakeSql, dir: '/x' });
    assert.ok(wa.length === 3 && wa.every((p) => p.source === 'whatsapp'));
    const r = await wa_.findContacts('Mandy', { run: async () => ({ ok: true, out: '' }), whatsapp: async () => wa });
    assert.deepStrictEqual(r.people.map((p) => p.name), ['Mandy Legrand', 'Mandy Gym'], 'same number once');
    const who = wa_.resolveRecipient(r.people, 'Mandy');
    assert.ok(!who.ok && who.matches.length === 2, 'two Mandys: Fred picks');
    const none = await wa_.findContacts('Mandy', { run: async () => ({ ok: false, error: 'not allowed -1743' }), whatsapp: async () => wa });
    assert.ok(none.ok && none.people.length === 2, 'WhatsApp still answers when Contacts is blocked');
  });
  await t('Claude gets contacts.find and whatsapp.send; the question names the number', () => {
    const ct = require('./claude-tools');
    const names = new Set(ct.toolDefinitions().map((d) => ct.fromApiName(d.name)));
    assert.ok(names.has('contacts.find') && names.has('whatsapp.send'));
    const { summarizeAction } = require('./agent/executor');
    assert.match(summarizeAction({ tool: 'whatsapp.send' }, { contact: 'Jay Legrand', number: '+31611112222', message: 'hi' }), /Send a WhatsApp to Jay Legrand \(\+31611112222\): .*hi.* — send it\?/);
    const { ceilingFor } = require('./agent/permission-store');
    const cat = require('./agent/catalog');
    const tool = (cat.TOOLS || cat.tools || []).find((x) => x.name === 'whatsapp.send') || cat.getTool && cat.getTool('whatsapp.send');
    assert.strictEqual(ceilingFor(tool), 'never', 'always asks Fred');
  });
  console.log(`whatsapp: ${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
