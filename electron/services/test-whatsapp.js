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
  await t('nobody found: nothing is sent on a guess, and the reason is honest', async () => {
    let ran = false;
    const r = await wa_.sendWhatsApp({ contact: 'Mandy', message: 'test' }, { run: async () => { ran = true; return { ok: true, out: 'SENT' }; }, find: async () => ({ ok: true, people: [], whatsappUnreadable: true }) });
    assert.ok(!r.ok && !ran && /did not let me read WhatsApp/.test(r.error) && /Nothing was sent/.test(r.error), JSON.stringify(r));
    const unread = await wa_.findContacts('Mandy', { run: async () => ({ ok: true, out: '' }), whatsapp: async () => null });
    assert.ok(unread.ok && unread.whatsappUnreadable, 'says when WhatsApp could not be read');
  });
  await t('things done outside the chat ride along with the next turn', () => {
    const brain = require('./claude-brain');
    assert.ok(brain.noteEvent('sent a WhatsApp to Mandy: "test", done'));
    assert.ok(!brain.noteEvent('   '));
  });
  await t('a failed turn keeps the note for the next one', async () => {
    const brain = require('./claude-brain');
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test';
    const seen = []; let fail = true;
    brain._setClient({ beta: { messages: { stream: (req) => { seen.push(JSON.stringify(req.messages)); return { on() {}, abort() {}, finalMessage: async () => { if (fail) { fail = false; throw new Error('overloaded'); } return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} }; } }; } } } });
    brain.resetHistory();
    brain.noteEvent('sent a WhatsApp to Mandy: "test", done');
    const quiet = console.log; console.log = () => {};
    try {
      await brain.chat({ system: 's', user: 'one' }, () => {});
      await brain.chat({ system: 's', user: 'two' }, () => {});
      await brain.chat({ system: 's', user: 'three' }, () => {});
    } finally { console.log = quiet; }
    assert.ok(/Done outside this chat/.test(seen[0]) && /Done outside this chat/.test(seen[seen.length - 2]), 'retried after the failure');
    assert.strictEqual((seen[seen.length - 1].match(/Done outside this chat/g) || []).length, 1, 'kept in history once, not repeated');
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
