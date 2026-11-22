// TEST — self-update: pull merged PRs, deploy the server, restart when Fred is away.
// Run: node electron/services/test-self-update.js
'use strict';
const assert = require('assert');
const { createSelfUpdate, classify, summarize } = require('./self-update');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.stack || e.message}`); process.exitCode = 1; }
}

// A fake git/npm/deploy: answers by command, records every call.
function fakeRun(over = {}) {
  const calls = [];
  const a = { branch: 'main', head: 'aaa1111', remote: 'bbb2222', ancestor: true, files: 'server/nav.js\nios/Hannibal/Nav.swift', log: 'Merge pull request #71 from fred/x\n\nNavigation follow-up\u0000', merge: true, deploy: true, ...over };
  const run = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    const ok = (out = '') => ({ ok: true, out, err: '' });
    if (cmd === 'git') {
      const [sub] = args;
      if (sub === 'rev-parse' && args[1] === '--abbrev-ref') return ok(a.branch);
      if (sub === 'fetch') return ok();
      if (sub === 'rev-parse' && args[1] === 'HEAD') return ok(a.head);
      if (sub === 'rev-parse' && args[1] === 'FETCH_HEAD') return ok(a.remote);
      if (sub === 'merge-base') return { ok: a.ancestor, out: '', err: '' };
      if (sub === 'diff') return ok(a.files);
      if (sub === 'log') return ok(a.log);
      if (sub === 'merge') return a.merge ? ok() : { ok: false, out: '', err: 'error: Your local changes would be overwritten' };
    }
    if (/deploy\.sh$/.test(cmd)) return a.deploy ? ok('Done') : { ok: false, out: '', err: 'ssh: connect to host GEX131: timed out' };
    if (cmd === 'npm') return ok();
    return { ok: false, out: '', err: 'unknown' };
  };
  return { run, calls };
}

(async () => {
  console.log('self-update');

  await test('what a change touches', () => {
    assert.deepStrictEqual(classify(['ios/Hannibal/Nav.swift', 'README.md']), { deps: false, server: false, desk: false });
    assert.deepStrictEqual(classify(['server/nav.js']), { deps: false, server: true, desk: false });
    assert.deepStrictEqual(classify(['electron/services/info-handlers.js']), { deps: false, server: true, desk: true });
    assert.deepStrictEqual(classify(['src/voice-controller.js']), { deps: false, server: false, desk: true });
    assert.deepStrictEqual(classify(['package-lock.json']), { deps: true, server: true, desk: true });
  });

  await test('PR titles from merge commits', () => {
    assert.deepStrictEqual(summarize('Merge pull request #70 from a/b\n\nNavigation\u0000Merge pull request #71 from a/b\n\nFixes\u0000'), ['#70 Navigation', '#71 Fixes']);
  });

  await test('server change: pull, deploy, tell Fred; no desk restart', async () => {
    const f = fakeRun(); const told = []; let restarts = 0;
    const u = createSelfUpdate({ dir: '/x', run: f.run, notify: async (t) => told.push(t), restart: () => restarts++, log: () => {} });
    const r = await u.check();
    assert.ok(r.updated && r.server && !r.desk);
    assert.ok(f.calls.includes('git merge --ff-only -q bbb2222'));
    assert.ok(f.calls.some((c) => /deploy\.sh --auto$/.test(c)));
    assert.match(told[0], /I updated myself: #71 Navigation follow-up\. The server is updated\./);
    assert.strictEqual(restarts, 0);
  });

  await test('desk change: restarts only once Fred is away and Hannibal is quiet', async () => {
    const f = fakeRun({ files: 'src/voice-controller.js' }); const told = []; let restarts = 0;
    let idle = 30, spoke = 0, t = 10 * 3600e3;
    const u = createSelfUpdate({ dir: '/x', run: f.run, notify: async (x) => told.push(x), restart: () => restarts++, idleSeconds: () => idle, lastSpokeAt: () => spoke, now: () => t, log: () => {} });
    await u.check();
    assert.strictEqual(restarts, 0, 'Fred is at the keyboard');
    assert.match(told[0], /restart at the desk once you're away/);
    assert.ok(!f.calls.some((c) => /deploy\.sh/.test(c)), 'no server deploy for desk-only code');
    idle = 900; spoke = t - 60e3;
    assert.strictEqual(u.maybeRestart(), false, 'he just spoke');
    spoke = t - 10 * 60e3;
    assert.strictEqual(u.maybeRestart(), true);
    assert.strictEqual(u.maybeRestart(), false, 'only once');
    assert.strictEqual(restarts, 1);
  });

  await test('nothing new, another branch, or local commits: leaves it alone', async () => {
    for (const [over, key] of [[{ remote: 'aaa1111' }, 'upToDate'], [{ branch: 'claude/x' }, 'skipped'], [{ ancestor: false }, 'skipped']]) {
      const f = fakeRun(over); const told = [];
      const r = await createSelfUpdate({ dir: '/x', run: f.run, notify: async (t) => told.push(t), restart: () => {}, log: () => {} }).check();
      assert.ok(r[key], JSON.stringify(r));
      assert.ok(!f.calls.some((c) => c.startsWith('git merge --ff-only')));
      assert.strictEqual(told.length, 0);
    }
  });

  await test('a failed pull or deploy is told once, not every 10 minutes', async () => {
    const f = fakeRun({ merge: false }); const told = [];
    const u = createSelfUpdate({ dir: '/x', run: f.run, notify: async (t) => told.push(t), restart: () => {}, log: () => {} });
    await u.check(); await u.check();
    assert.strictEqual(told.length, 1);
    assert.match(told[0], /couldn't update myself: pulling the new code failed/);
    const g = fakeRun({ deploy: false }); const told2 = [];
    await createSelfUpdate({ dir: '/x', run: g.run, notify: async (t) => told2.push(t), restart: () => {}, log: () => {} }).check();
    assert.match(told2[0], /server deploy failed: ssh: connect to host GEX131: timed out/);
  });

  console.log(process.exitCode ? 'some FAILED' : `${passed} passed`);
})();
