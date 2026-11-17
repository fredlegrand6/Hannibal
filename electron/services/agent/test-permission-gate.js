// ─────────────────────────────────────────────────────────────────────────
// TEST — Permission-pattern learning (ask-once-generalize) + gate wiring.
// Deterministic and offline: a temp JSON file, fixed clock, injected confirmer
// and cancel-beat. Run:  node electron/services/agent/test-permission-gate.js
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const catalog = require('./catalog');
const { createPermissionStore, ceilingFor } = require('./permission-store');
const { execute } = require('./executor');

const TMP = path.join(os.tmpdir(), 'hannibal-perm-test');
fs.mkdirSync(TMP, { recursive: true });
let seq = 0;
function freshStore(entries) {
  const filePath = path.join(TMP, `p${seq++}.json`);
  return createPermissionStore({ filePath, noLoad: true, entries: entries || [], now: () => '2026-06-07T00:00:00Z' });
}
const tool = (n) => catalog.getTool(n);
const writeStep = (n, t, params) => ({ step: n, tool: t, params, side_effect: 'write', confirm: true, depends_on: [], valid: true });

let passed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { passed += 1; console.log(`  ✓ ${name}`); },
    (e) => { console.error(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; },
  );
}

(async () => {
  console.log('Ceilings (catalog-declared + forced rules)');

  await test('ceilingFor reflects catalog + forced rules', () => {
    assert.equal(ceilingFor(tool('mail.send')), 'cancel-beat');
    assert.equal(ceilingFor(tool('file.trash')), 'cancel-beat');
    assert.equal(ceilingFor(tool('app.quit')), 'auto');
    assert.equal(ceilingFor(tool('mac.emptyTrash')), 'never');       // hard delete
    assert.equal(ceilingFor(tool('whatsapp.send')), 'never');        // planner_safe:false (forced)
    assert.equal(ceilingFor(tool('mac.shell')), 'never');            // planner_safe:false (forced)
    assert.equal(ceilingFor(tool('imessage.send')), 'never');        // undeclared → conservative
    assert.equal(ceilingFor(tool('calendar.events')), 'never');      // a read → never in scope
  });

  console.log('Store — remember / two-step / matching');

  await test('first "always" lands on cancel-beat, never auto (even if auto requested)', () => {
    const s = freshStore();
    const r = s.remember(tool('app.quit'), { name: 'Spotify' }, { decision: 'approve', tier: 'auto' });
    assert.equal(r.ok, true); assert.equal(r.entry.tier, 'cancel-beat');
  });

  await test('true auto needs a second deliberate opt-in (promote an existing cancel-beat)', () => {
    const s = freshStore();
    s.remember(tool('app.quit'), { name: 'Spotify' }, { decision: 'approve' });   // 1st → cancel-beat
    const r = s.promote(tool('app.quit'), { name: 'Spotify' });                   // 2nd → auto
    assert.equal(r.entry.tier, 'auto');
  });

  await test('ceiling caps promotion: mail.send can never reach auto', () => {
    const s = freshStore();
    s.remember(tool('mail.send'), { to: 'rob@x.com' }, { decision: 'approve' });
    const r = s.promote(tool('mail.send'), { to: 'rob@x.com' });
    assert.equal(r.entry.tier, 'cancel-beat');
  });

  await test('exact match: a different recipient is not covered', () => {
    const s = freshStore();
    s.remember(tool('mail.send'), { to: 'rob@x.com' }, { decision: 'approve' });
    assert.ok(s.lookup(tool('mail.send'), { to: 'rob@x.com' }));
    assert.equal(s.lookup(tool('mail.send'), { to: 'alice@x.com' }), null);
  });

  await test('prefix match: "always" on a file generalizes to its folder', () => {
    const s = freshStore();
    const r = s.remember(tool('file.trash'), { path: '/Users/f/Downloads/x.pdf' }, { decision: 'approve' });
    assert.equal(r.entry.value, '/Users/f/Downloads/');   // stored as the parent prefix
    assert.ok(s.lookup(tool('file.trash'), { path: '/Users/f/Downloads/y.zip' }));
    assert.equal(s.lookup(tool('file.trash'), { path: '/Users/f/Documents/z.txt' }), null);
  });

  await test('never-ceiling approvals are refused (empty Trash, planner_safe:false)', () => {
    const s = freshStore();
    assert.equal(s.remember(tool('mac.emptyTrash'), {}, { decision: 'approve' }).ok, false);
    // whatsapp.send has no permission key declared AND is planner_safe:false → not learnable
    assert.equal(s.remember(tool('whatsapp.send'), { contact: 'x', message: 'y' }, { decision: 'approve' }).ok, false);
  });

  await test('remembered deny + revoke + auditable list', () => {
    const s = freshStore();
    s.remember(tool('mail.send'), { to: 'spam@x.com' }, { decision: 'deny' });
    assert.equal(s.lookup(tool('mail.send'), { to: 'spam@x.com' }).decision, 'deny');
    const list = s.list();
    assert.equal(list.length, 1);
    assert.ok(list[0].key && list[0].tool === 'mail.send');   // one readable row
    assert.equal(s.revoke(list[0].key), true);
    assert.equal(s.lookup(tool('mail.send'), { to: 'spam@x.com' }), null);
  });

  await test('store round-trips through its JSON file (human-readable)', () => {
    const filePath = path.join(TMP, 'roundtrip.json');
    const a = createPermissionStore({ filePath, noLoad: true, now: () => 't' });
    a.remember(tool('app.quit'), { name: 'Slack' }, { decision: 'approve' });
    const raw = fs.readFileSync(filePath, 'utf8');
    assert.ok(raw.includes('\n  ') && raw.includes('app.quit:name:Slack'));   // pretty-printed, legible
    const b = createPermissionStore({ filePath });   // fresh load
    assert.ok(b.lookup(tool('app.quit'), { name: 'Slack' }));
  });

  console.log('Executor gate integration');

  await test('auto: a remembered auto-approval fires without asking', async () => {
    const store = freshStore([{ key: 'app.quit:name:Spotify', tool: 'app.quit', param: 'name', value: 'Spotify', match: 'exact', decision: 'approve', tier: 'auto', grantedAt: 't', lastUsedAt: null, useCount: 0 }]);
    const events = []; let asked = false, ran = false;
    await execute({ goal: 'quit spotify', steps: [writeStep(1, 'app.quit', { name: 'Spotify' })] }, {
      permissions: store,
      confirmer: async () => { asked = true; return true; },
      invoke: async () => { ran = true; return { ok: true }; },
      emit: (e) => events.push(e),
    });
    assert.equal(asked, false, 'must NOT ask');
    assert.equal(ran, true, 'must execute');
    assert.ok(events.some((e) => e.type === 'gate:auto-approved'));
  });

  await test('cancel-beat: announces, then fires when not cancelled', async () => {
    const store = freshStore([{ key: 'mail.send:to:rob@x.com', tool: 'mail.send', param: 'to', value: 'rob@x.com', match: 'exact', decision: 'approve', tier: 'cancel-beat', grantedAt: 't', lastUsedAt: null, useCount: 0 }]);
    const events = []; let ran = false, asked = false;
    await execute({ goal: 'mail rob', steps: [writeStep(1, 'mail.send', { to: 'rob@x.com', subject: 'hi' })] }, {
      permissions: store,
      cancelBeat: async () => false,           // not cancelled
      confirmer: async () => { asked = true; return true; },
      invoke: async () => { ran = true; return { ok: true }; },
      emit: (e) => events.push(e),
    });
    assert.equal(asked, false);
    assert.equal(ran, true);
    assert.ok(events.some((e) => e.type === 'gate:cancel-beat'));
  });

  await test('cancel-beat: aborts cleanly when stopped in the window', async () => {
    const store = freshStore([{ key: 'mail.send:to:rob@x.com', tool: 'mail.send', param: 'to', value: 'rob@x.com', match: 'exact', decision: 'approve', tier: 'cancel-beat', grantedAt: 't', lastUsedAt: null, useCount: 0 }]);
    const events = []; let ran = false;
    await execute({ goal: 'mail rob', steps: [writeStep(1, 'mail.send', { to: 'rob@x.com' })] }, {
      permissions: store,
      cancelBeat: async () => true,            // stopped
      invoke: async () => { ran = true; return { ok: true }; },
      emit: (e) => events.push(e),
    });
    assert.equal(ran, false, 'must NOT execute after a cancel');
    assert.ok(events.some((e) => e.type === 'gate:cancel-beat-aborted'));
  });

  await test('cancel-beat with NO canceller wired falls back to a full ask', async () => {
    const store = freshStore([{ key: 'mail.send:to:rob@x.com', tool: 'mail.send', param: 'to', value: 'rob@x.com', match: 'exact', decision: 'approve', tier: 'cancel-beat', grantedAt: 't', lastUsedAt: null, useCount: 0 }]);
    const events = []; let asked = false;
    await execute({ goal: 'mail rob', steps: [writeStep(1, 'mail.send', { to: 'rob@x.com' })] }, {
      permissions: store,                       // no cancelBeat wired
      confirmer: async () => { asked = true; return { approved: true }; },
      invoke: async () => ({ ok: true }),
      emit: (e) => events.push(e),
    });
    assert.equal(asked, true, 'must fall back to asking when nothing can receive a stop');
    assert.ok(events.some((e) => e.type === 'step:confirm-request'));
  });

  await test('ask + "always": captures the pattern at cancel-beat for next time', async () => {
    const store = freshStore();
    await execute({ goal: 'mail rob', steps: [writeStep(1, 'mail.send', { to: 'rob@x.com' })] }, {
      permissions: store,
      confirmer: async () => ({ approved: true, remember: 'approve' }),
      invoke: async () => ({ ok: true }),
      emit: () => {},
    });
    const v = store.lookup(tool('mail.send'), { to: 'rob@x.com' });
    assert.ok(v && v.decision === 'approve' && v.tier === 'cancel-beat');
  });

  await test('"always" on a never-ceiling action is refused, but the one-shot still runs', async () => {
    const store = freshStore();
    const events = []; let ran = false;
    await execute({ goal: 'empty trash', steps: [writeStep(1, 'mac.emptyTrash', {})] }, {
      permissions: store,
      confirmer: async () => ({ approved: true, remember: 'approve' }),
      invoke: async () => { ran = true; return { ok: true }; },
      emit: (e) => events.push(e),
    });
    assert.ok(events.some((e) => e.type === 'gate:remember-refused'));
    assert.equal(store.list().length, 0, 'nothing should be remembered');
    assert.equal(ran, true, 'the one-shot approval still executes');
  });

  // cleanup
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${passed} checks passed.`);
})();
