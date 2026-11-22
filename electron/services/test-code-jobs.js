// Offline test for services/code-jobs.js: a fake `claude` (writes stream-json,
// edits a file, commits) in a throwaway git repo with a local bare "origin".
// Run: node electron/services/test-code-jobs.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const J = require('./code-jobs');
const catalog = require('./agent/catalog');

let passed = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { passed += 1; console.log('  ✓', name); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hannibal-jobs-'));
const root = path.join(tmp, 'Projects');
const repo = path.join(root, 'revalis-housing');
const other = path.join(root, 'revalis-property');
const bare = path.join(tmp, 'origin.git');
const base = path.join(tmp, 'state');
for (const d of [repo, other]) fs.mkdirSync(d, { recursive: true });
git(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
for (const d of [repo, other]) {
  git(d, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(d, 'README.md'), '# app\n');
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'init');
}
git(repo, 'remote', 'add', 'origin', bare);
git(repo, 'push', '-q', '-u', 'origin', 'main');

// Fake Claude Code: logs its args, makes a change, commits, prints stream-json.
// FAKE_MODE=fail → no result line; slow → sleeps (for stop / timeout).
const fake = path.join(tmp, 'claude');
fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs'); const { execFileSync } = require('child_process');
const args = process.argv.slice(2);
fs.writeFileSync(process.cwd() + '/../args-' + Date.now() + '.json', JSON.stringify({ args, key: process.env.ANTHROPIC_API_KEY || null }));
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
say({ type: 'system', subtype: 'init', session_id: 'sess-123' });
const mode = process.env.FAKE_MODE || 'ok';
if (mode === 'slow') { setTimeout(() => {}, 60000); return; }
say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'README.md' } }] } });
fs.appendFileSync('README.md', 'login fixed\\n');
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
if (mode !== 'dirty' && mode !== 'fail') { execFileSync('git', ['add', '-A'], { env }); execFileSync('git', ['commit', '-q', '-m', 'Fix login'], { env }); }
else fs.writeFileSync('new.txt', 'x');
if (mode === 'fail') { process.stdout.write('Error: something broke\\n'); process.exit(1); }
say({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it.' }] } });
say({ type: 'result', subtype: 'success', is_error: false, result: 'Fixed the login redirect. Tests pass. Check the Safari flow.', total_cost_usd: 0.42, num_turns: 7, session_id: 'sess-123' });
`);
fs.chmodSync(fake, 0o755);

const lastArgs = () => {
  const dirs = fs.readdirSync(path.join(base, 'jobs'));
  const files = dirs.flatMap((d) => { try { return fs.readdirSync(path.join(base, 'jobs', d)).filter((f) => f.startsWith('args-')).map((f) => path.join(base, 'jobs', d, f)); } catch (_) { return []; } });
  files.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs || a.localeCompare(b));
  return JSON.parse(fs.readFileSync(files[files.length - 1], 'utf8'));
};

async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(100); }
  throw new Error('timed out waiting');
}

(async () => {
  console.log('code-jobs');

  await ok('pure helpers', () => {
    const ps = [{ name: 'revalis-housing', rel: 'Projects/revalis-housing' }, { name: 'revalis-property', rel: 'Projects/revalis-property' }, { name: 'hannibal-v2', rel: 'Projects/hannibal-v2' }];
    assert.strictEqual(J.pickProject(ps, 'hannibal').pick.name, 'hannibal-v2');
    assert.strictEqual(J.pickProject(ps, 'Revalis Housing').pick.name, 'revalis-housing');
    assert.deepStrictEqual(J.pickProject(ps, 'revalis').choose, ['revalis-housing', 'revalis-property']);
    assert.ok(J.pickProject(ps, 'zerochat').none);
    assert.strictEqual(J.githubWeb('git@github.com:fredlegrand6/Hannibal.git'), 'https://github.com/fredlegrand6/Hannibal');
    assert.strictEqual(J.githubWeb('https://github.com/fredlegrand6/Hannibal'), 'https://github.com/fredlegrand6/Hannibal');
    assert.strictEqual(J.githubWeb('/tmp/x.git'), null);
    assert.strictEqual(J.slugify('Fix the Safari export button!'), 'fix-the-safari-export-button');
    const lg = J.parseLog('{"type":"system","session_id":"s1"}\nnoise\n{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}]}}\n');
    assert.strictEqual(lg.sessionId, 's1'); assert.strictEqual(lg.lastTool, 'Bash: npm test'); assert.strictEqual(lg.result, null);
  });

  await ok('catalog: start + followUp need a yes; never auto-approved; read tools are reads', () => {
    for (const n of ['codejob.start', 'codejob.followUp']) {
      const t = catalog.getTool(n);
      assert.strictEqual(t.side_effect, 'write'); assert.strictEqual(t.confirm, true); assert.strictEqual(t.permission.ceiling, 'never');
    }
    assert.strictEqual(catalog.getTool('codejob.status').side_effect, 'read');
    assert.ok(!catalog.getTool('codejob.start').desk_only, 'works from the phone');
    assert.ok(!catalog.plannerTools().some((t) => t.name.startsWith('codejob.')), 'never in Ollama plans');
  });

  await ok('Claude Code itself may not push, merge or deploy', () => {
    for (const d of ['Bash(git push:*)', 'Bash(gh:*)', 'Bash(ssh:*)', 'Bash(./server/deploy.sh:*)', 'Bash(docker:*)', 'Bash(vercel:*)']) assert.ok(J.DENIED.includes(d), d);
  });

  const told = [];
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const jobs = J.createCodeJobs({ roots: [root], baseDir: base, claudeBin: fake, ghBin: null, pollMs: 100, onDone: (job, m) => { told.push({ job: { ...job }, ...m }); }, log: () => {} });
  jobs.startMonitor();

  await ok('lists the projects under the roots', () => {
    const names = jobs.projects().map((p) => p.name).sort();
    assert.deepStrictEqual(names, ['revalis-housing', 'revalis-property']);
  });

  await ok('ambiguous / unknown project → nothing started', async () => {
    const a = await jobs.start({ project: 'revalis', task: 'x' });
    assert.strictEqual(a.ok, false); assert.ok(a.ambiguous);
    const b = await jobs.start({ project: 'nope', task: 'x' });
    assert.strictEqual(b.ok, false); assert.ok(/can't find/.test(b.error));
    assert.strictEqual(jobs._jobs().length, 0);
  });

  let job;
  await ok('start → own worktree on a new branch, Fred\'s folder untouched', async () => {
    const r = await jobs.start({ project: 'housing', task: 'Fix the login redirect on Safari', title: 'Fix Safari login' });
    assert.ok(r.ok, r.error);
    job = jobs._jobs()[0];
    assert.ok(job.branch.startsWith('hannibal/fix-safari-login-'));
    assert.ok(job.worktree.startsWith(base));
    assert.strictEqual(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  });

  await ok('done → summary, commits, branch pushed, Fred told (phone text + spoken line)', async () => {
    await waitFor(() => told.length === 1);
    const t = told[0];
    assert.strictEqual(t.job.state, 'done');
    assert.strictEqual(t.job.commits, 1);
    assert.ok(t.job.pushed);
    assert.ok(git(bare, 'branch', '--list', job.branch).includes(job.branch), 'branch is on origin');
    assert.ok(/✅ Claude Code job done: Fix Safari login/.test(t.text));
    assert.ok(/Fixed the login redirect/.test(t.text));
    assert.ok(/Nothing is merged or deployed/.test(t.text));
    assert.ok(/^Fred, the Claude Code job "Fix Safari login" is done\. Fixed the login redirect\./.test(t.spoken));
    assert.ok(!fs.readFileSync(path.join(repo, 'README.md'), 'utf8').includes('login fixed'), "Fred's working folder unchanged");
  });

  await ok('runs on Fred\'s Claude login (no API key), with the deny list and the rules', () => {
    const a = lastArgs();
    assert.strictEqual(a.key, null);
    assert.ok(a.args.includes('-p') && a.args.includes('stream-json'));
    assert.ok(a.args[a.args.indexOf('--disallowedTools') + 1].includes('Bash(git push:*)'));
    assert.ok(/Never push, merge, deploy/.test(a.args[a.args.indexOf('--append-system-prompt') + 1]));
  });

  await ok('status shows the finished job', () => {
    const s = jobs.status();
    assert.strictEqual(s.jobs[0].state, 'done'); assert.strictEqual(s.jobs[0].commits, 1);
    assert.strictEqual(s.jobs[0].costUsd, 0.42);
  });

  await ok('follow-up resumes the same conversation on the same branch', async () => {
    const r = await jobs.followUp({ job: 'safari', text: 'Also add a test' });
    assert.ok(r.ok, r.error);
    await waitFor(() => told.length === 2);
    const a = lastArgs();
    assert.strictEqual(a.args[a.args.indexOf('--resume') + 1], 'sess-123');
    assert.strictEqual(told[1].job.commits, 2);
    assert.strictEqual(told[1].job.branch, job.branch);
  });

  await ok('uncommitted work is committed; a crash without an answer is reported', async () => {
    process.env.FAKE_MODE = 'fail';
    const r = await jobs.start({ project: 'housing', task: 'Break things' });
    assert.ok(r.ok);
    await waitFor(() => told.length === 3);
    assert.strictEqual(told[2].job.state, 'failed');
    assert.ok(/didn't finish/.test(told[2].text));
    assert.strictEqual(told[2].job.commits, 1);
  });

  await ok('stop → stopped, Fred told', async () => {
    process.env.FAKE_MODE = 'slow';
    const r = await jobs.start({ project: 'housing', task: 'Take forever' });
    assert.ok(r.ok);
    await waitFor(() => jobs.status().jobs[0].state === 'running' && jobs.status().jobs[0].doing);
    const s = jobs.stop({});
    assert.ok(s.ok, s.error);
    await waitFor(() => told.length === 4);
    assert.strictEqual(told[3].job.state, 'stopped');
    assert.ok(/stopped/.test(told[3].spoken));
  });

  await ok('max running jobs is honoured', async () => {
    process.env.FAKE_MODE = 'slow';
    const small = J.createCodeJobs({ roots: [root], baseDir: path.join(tmp, 'state2'), claudeBin: fake, ghBin: null, maxRunning: 1, pollMs: 100, log: () => {} });
    // two asks at the same moment: only one gets the slot
    const [one, two] = await Promise.all([small.start({ project: 'housing', task: 'one' }), small.start({ project: 'housing', task: 'two' })]);
    assert.strictEqual([one, two].filter((r) => r.ok).length, 1);
    const no = one.ok ? two : one;
    assert.ok(/already running/.test(no.error));
    assert.strictEqual(small._jobs().length, 1);
    small.stop({});
    await sleep(300);
  });

  await ok('a job survives a Hannibal restart: a new runner picks it up from the state file', async () => {
    process.env.FAKE_MODE = 'slow';
    const dir = path.join(tmp, 'state3');
    const a = J.createCodeJobs({ roots: [root], baseDir: dir, claudeBin: fake, ghBin: null, pollMs: 100, log: () => {} });
    assert.ok((await a.start({ project: 'housing', task: 'long one' })).ok);
    const pid = a._jobs()[0].pid;
    const heard = [];
    const b = J.createCodeJobs({ roots: [root], baseDir: dir, claudeBin: fake, ghBin: null, pollMs: 100, onDone: (j) => heard.push(j.state), log: () => {} });
    b.startMonitor();
    assert.strictEqual(b.status().jobs[0].state, 'running');
    process.kill(-pid, 'SIGTERM');
    await waitFor(() => heard.length === 1);
    assert.strictEqual(heard[0], 'failed');
    b.stopMonitor();
  });

  await ok('the yes/no question says which project and what', () => {
    const { summarizeAction } = require('./agent/executor');
    const q = summarizeAction({ tool: 'codejob.start' }, { project: 'revalis-housing', title: 'Fix Safari login', task: 'Fix the login redirect' });
    assert.ok(/revalis-housing/.test(q) && /Fix the login redirect/.test(q) && /nothing is merged or deployed/.test(q) && /Start it\?$/.test(q), q);
  });

  jobs.stopMonitor();
  delete process.env.FAKE_MODE;
  console.log(`\n${passed} passed`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  process.exit(0);
})().catch((e) => { console.error('✗', e && e.stack || e); process.exit(1); });
