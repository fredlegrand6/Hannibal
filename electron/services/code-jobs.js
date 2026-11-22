// ─────────────────────────────────────────────────────────────────────────
// CODE JOBS — Hannibal starts Claude Code jobs for Fred and tells him when
// they are done.
//
// A job is headless Claude Code (`claude -p`, Fred's own Claude login) working
// on ONE of Fred's git projects:
//   • it runs in its own git worktree on a new branch (hannibal/<slug>-<id>),
//     so it never touches the folder Fred works in, nor the running Hannibal;
//   • it may edit files, run tests and commit. It may NOT push, merge, deploy,
//     ssh, sudo or use docker (denied to Claude Code itself);
//   • when it ends, Hannibal (not Claude Code) pushes the branch and opens a
//     DRAFT pull request (gh, if it is installed and signed in; otherwise a
//     "create PR" link). Merging and deploying stay with Fred;
//   • Fred hears it at the desk and gets it on his phone (Telegram, phone app,
//     iPhone push) through onDone.
// Starting a job (and a follow-up) is a confirm-first write: Fred says yes first.
//
// The Claude Code process is started detached, writing its stream-json to a
// log file, so a job keeps running when Hannibal restarts; the monitor picks
// it up again from the state file and the log.
//
// Where things live (outside the repo, like the voiceprint):
//   ~/Library/Application Support/Hannibal/code-jobs.json   jobs + state
//   ~/Library/Application Support/Hannibal/jobs/<id>/       worktree + log
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const HOME = os.homedir();
const APP_DIR = path.join(HOME, 'Library', 'Application Support', 'Hannibal');

const truthy = (v) => /^(1|true|on|yes)$/i.test(String(v || ''));
const falsy = (v) => /^(0|false|off|no)$/i.test(String(v || ''));

// Things Claude Code itself may never run inside a job. Hannibal pushes the
// branch himself at the end; merging and deploying are Fred's.
const DENIED = [
  'Bash(git push:*)', 'Bash(git push)', 'Bash(git remote:*)',
  'Bash(gh:*)', 'Bash(ssh:*)', 'Bash(scp:*)', 'Bash(rsync:*)', 'Bash(sftp:*)',
  'Bash(sudo:*)', 'Bash(docker:*)', 'Bash(docker-compose:*)', 'Bash(kubectl:*)',
  'Bash(vercel:*)', 'Bash(npx vercel:*)', 'Bash(supabase:*)', 'Bash(npx supabase:*)',
  'Bash(fly:*)', 'Bash(flyctl:*)', 'Bash(netlify:*)', 'Bash(heroku:*)',
  'Bash(./server/deploy.sh:*)', 'Bash(server/deploy.sh:*)', 'Bash(bash server/deploy.sh:*)',
  'Bash(./deploy.sh:*)', 'Bash(npm publish:*)', 'Bash(launchctl:*)', 'Bash(osascript:*)',
];
const ALLOWED = ['Bash', 'Read', 'Edit', 'MultiEdit', 'Write', 'Glob', 'Grep', 'LS', 'NotebookEdit', 'TodoWrite', 'Task', 'WebFetch', 'WebSearch'];

function rulesFor(job) {
  return [
    `You are doing a coding job that Hannibal (Fred's assistant) started for Fred. Fred is not watching; nobody can answer questions.`,
    `You are in a git worktree of the project "${job.project}" on the new branch ${job.branch} (from ${job.base}).`,
    'Rules:',
    '- Do the task fully. If something is unclear, make the most sensible choice and say so at the end.',
    '- Commit your work on this branch with clear messages (git add + git commit). Do not switch branches.',
    '- Never push, merge, deploy, ssh or change servers, databases or settings outside this folder. Hannibal pushes the branch for you.',
    '- Never read, print or change .env files, keys or other secrets.',
    '- If the project has tests, run the ones that cover your change.',
    '- End with a short plain-English summary for Fred (2 to 4 sentences): what you changed, whether tests pass, and anything he must check or do.',
  ].join('\n');
}

// ── pure helpers (tested) ──────────────────────────────────────────────────

const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 6).join('-').slice(0, 40) || 'job';

const normName = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');

// Which project does Fred mean? → { pick } | { choose:[names] } | { none:true }
function pickProject(projects, wanted) {
  const w = normName(wanted);
  if (!w) return { none: true };
  const exact = projects.filter((p) => normName(p.name) === w);
  if (exact.length === 1) return { pick: exact[0] };
  const hits = projects.filter((p) => normName(p.name).includes(w) || (w.length >= 4 && w.includes(normName(p.name)) && normName(p.name).length >= 4));
  if (hits.length === 1) return { pick: hits[0] };
  // "revalis housing" vs folder "revalis-housing-app": every word in the name
  const words = String(wanted).toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 3);
  const byWords = words.length ? projects.filter((p) => words.every((x) => normName(p.name).includes(x) || normName(p.rel).includes(x))) : [];
  if (byWords.length === 1) return { pick: byWords[0] };
  const many = (hits.length > 1 ? hits : byWords.length > 1 ? byWords : exact);
  if (many.length > 1) return { choose: many.map((p) => p.name) };
  return { none: true };
}

// git remote url → https://github.com/owner/repo  (null when not GitHub)
function githubWeb(remote) {
  const s = String(remote || '').trim();
  const m = s.match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

// Read Claude Code's stream-json log → what it is doing / what it said at the end.
function parseLog(text) {
  const out = { lastText: '', lastTool: '', tools: 0, result: null, sessionId: null, events: 0 };
  for (const line of String(text || '').split('\n')) {
    const l = line.trim();
    if (!l || l[0] !== '{') continue;
    let ev; try { ev = JSON.parse(l); } catch (_) { continue; }
    out.events += 1;
    if (ev.session_id && !out.sessionId) out.sessionId = ev.session_id;
    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const c of ev.message.content) {
        if (c.type === 'text' && c.text && c.text.trim()) out.lastText = c.text.trim();
        if (c.type === 'tool_use') {
          out.tools += 1;
          const inp = c.input || {};
          const what = inp.command || inp.file_path || inp.pattern || inp.description || inp.url || '';
          out.lastTool = `${c.name}${what ? `: ${String(what).replace(/\s+/g, ' ').slice(0, 100)}` : ''}`;
        }
      }
    }
    if (ev.type === 'result') {
      out.result = {
        ok: ev.subtype === 'success' && !ev.is_error,
        subtype: ev.subtype || '',
        text: String(ev.result || '').trim(),
        cost: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null,
        turns: ev.num_turns || null,
        ms: ev.duration_ms || null,
      };
      if (ev.session_id) out.sessionId = ev.session_id;
    }
  }
  return out;
}

const shorten = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const mins = (ms) => Math.max(1, Math.round(ms / 60000));

// The line Fred gets when a job ends (phone) and the shorter one he hears (desk).
function doneMessage(job) {
  const head = job.state === 'done'
    ? `✅ Claude Code job done: ${job.title} (${job.project}, ${mins((job.endedAt || Date.now()) - job.startedAt)} min).`
    : job.state === 'stopped' ? `⏹ Claude Code job stopped: ${job.title} (${job.project}).`
      : `⚠️ Claude Code job didn't finish: ${job.title} (${job.project}). ${job.error || ''}`.trim();
  const parts = [head];
  if (job.summary) parts.push(shorten(job.summary, 900));
  if (job.commits > 0) {
    if (job.prUrl) parts.push(`Draft PR: ${job.prUrl}`);
    else if (job.pushed && job.compareUrl) parts.push(`Branch ${job.branch} is on GitHub. Open a PR: ${job.compareUrl}`);
    else if (job.pushed) parts.push(`Branch ${job.branch} is pushed.`);
    else parts.push(`${job.commits} commit(s) on branch ${job.branch} (not pushed${job.pushError ? `: ${shorten(job.pushError, 120)}` : ''}).`);
    parts.push('Nothing is merged or deployed: that is yours.');
  } else if (job.state === 'done') parts.push('No code was changed.');
  return parts.join('\n\n');
}
function spokenMessage(job) {
  const s = job.summary ? shorten(job.summary.split(/(?<=[.!?])\s+/)[0], 220) : '';
  if (job.state === 'done') {
    return `Fred, the Claude Code job "${job.title}" is done.${s ? ` ${s}` : ''}${job.commits > 0 ? (job.prUrl ? ' There is a draft PR for you to check.' : ' The branch is ready for you to check.') : ' It changed nothing.'}`;
  }
  if (job.state === 'stopped') return `Fred, the Claude Code job "${job.title}" is stopped.`;
  return `Fred, the Claude Code job "${job.title}" didn't finish. ${shorten(job.error || 'Check your phone for details.', 160)}`;
}

// ── the job runner ─────────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout || 120000, maxBuffer: 8 * 1024 * 1024, cwd: opts.cwd, env: opts.env || process.env }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || '').trim(), err: String(stderr || (err && err.message) || '').trim() });
    });
  });
}

function findBin(name, envVar, extra = []) {
  const forced = process.env[envVar];
  if (forced) return forced;
  const dirs = [...extra, ...String(process.env.PATH || '').split(':'), '/opt/homebrew/bin', '/usr/local/bin', path.join(HOME, '.local', 'bin'), path.join(HOME, 'bin')];
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) {}
  }
  return null;
}

function createCodeJobs({
  roots = (process.env.HANNIBAL_JOB_ROOTS || [path.join(HOME, 'Desktop', 'Projects'), path.join(HOME, 'Desktop', 'Saas Platforms'), path.join(HOME, 'Developer')].join(':')).split(':').filter(Boolean),
  baseDir = process.env.HANNIBAL_JOBS_DIR || APP_DIR,
  claudeBin = null, ghBin = undefined, git = 'git',
  maxRunning = Number(process.env.HANNIBAL_JOBS_MAX) || 2,
  timeoutMin = Number(process.env.HANNIBAL_JOB_TIMEOUT_MIN) || 90,
  push = !falsy(process.env.HANNIBAL_JOBS_PUSH),
  model = process.env.HANNIBAL_JOB_MODEL || '',
  pollMs = 5000,
  onDone = () => {},
  log = (...a) => console.log('[jobs]', ...a),
  now = () => Date.now(),
} = {}) {
  const stateFile = path.join(baseDir, 'code-jobs.json');
  const jobsDir = path.join(baseDir, 'jobs');
  let jobs = [];
  try { jobs = JSON.parse(fs.readFileSync(stateFile, 'utf8')).jobs || []; } catch (_) { jobs = []; }
  // A start cut off half-way (Hannibal quit while making the copy) never ran.
  for (const j of jobs) if (j.state === 'starting') Object.assign(j, { state: 'failed', error: 'Hannibal was restarted while the job was starting.', endedAt: j.startedAt, notified: true });
  const save = () => {
    try { fs.mkdirSync(baseDir, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify({ jobs }, null, 2)); } catch (e) { log('could not save state:', e.message); }
  };
  const claude = () => claudeBin || findBin('claude', 'HANNIBAL_CLAUDE_BIN', [path.join(HOME, '.claude', 'local'), path.join(HOME, '.npm-global', 'bin')]);
  const gh = () => (ghBin !== undefined ? ghBin : findBin('gh', 'HANNIBAL_GH_BIN'));
  const finishing = new Set();
  let reserved = 0;   // starts still setting up (fetch, worktree): they count against the limit

  // Git projects under the roots (the root itself, and two levels down).
  function projects() {
    const found = [];
    const seen = new Set();
    const visit = (dir, depth, root) => {
      let real; try { real = fs.realpathSync(dir); } catch (_) { return; }
      if (seen.has(real)) return; seen.add(real);
      if (fs.existsSync(path.join(dir, '.git'))) {
        found.push({ name: path.basename(dir), path: dir, rel: path.relative(path.dirname(root), dir) });
        return;
      }
      if (depth >= 2) return;
      let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of ents) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('_') || e.name === 'node_modules') continue;
        visit(path.join(dir, e.name), depth + 1, root);
      }
    };
    for (const r of roots) visit(r, 0, r);
    return found;
  }

  const running = () => jobs.filter((j) => j.state === 'running' || j.state === 'starting');
  const busy = () => running().length + reserved;
  const pidAlive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  const logPath = (job) => path.join(jobsDir, job.id, `log-${job.round || 1}.jsonl`);
  const readLog = (job) => { try { return fs.readFileSync(logPath(job), 'utf8'); } catch (_) { return ''; } };

  function launch(job, prompt, resumeId) {
    const bin = claude();
    if (!bin) throw new Error('Claude Code (the `claude` command) is not installed on this Mac. Install it, or set HANNIBAL_CLAUDE_BIN in .env.');
    fs.mkdirSync(path.join(jobsDir, job.id), { recursive: true });
    const fd = fs.openSync(logPath(job), 'a');
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', ALLOWED.join(','),
      '--disallowedTools', DENIED.join(','),
      '--append-system-prompt', rulesFor(job)];
    if (model) args.push('--model', model);
    if (resumeId) args.push('--resume', resumeId);
    const env = { ...process.env, HANNIBAL_JOB_ID: job.id };
    // Hannibal's own API key would bill the job to the API instead of Fred's
    // Claude plan. Use his Claude login unless he asked for the key.
    if (!truthy(process.env.HANNIBAL_JOBS_USE_API_KEY)) delete env.ANTHROPIC_API_KEY;
    const child = spawn(bin, args, { cwd: job.worktree, env, detached: true, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    child.on('error', (e) => { job.spawnError = e.message; });
    child.unref();
    job.pid = child.pid;
    job.state = 'running';
    job.roundStartedAt = now();
    save();
  }

  async function start({ project, task, title } = {}) {
    task = String(task || '').trim();
    if (!task) return { ok: false, error: 'No task given: what should Claude Code do?' };
    const list = projects();
    const p = pickProject(list, project);
    if (p.choose) return { ok: false, ambiguous: true, options: p.choose, error: `Which project? ${p.choose.join(', ')}` };
    if (!p.pick) return { ok: false, error: `I can't find a project called "${project}".`, projects: list.map((x) => x.name) };
    if (busy() >= maxRunning) return { ok: false, error: `${busy()} jobs are already running (max ${maxRunning}). Stop one or wait.`, running: running().map(view) };
    if (!claude()) return { ok: false, error: 'Claude Code (the `claude` command) is not installed on this Mac. Install it, or set HANNIBAL_CLAUDE_BIN in .env.' };
    reserved += 1;   // held until the job is in the list (or setup failed)
    try { return await startReserved(p, task, title); } finally { reserved -= 1; }
  }

  async function startReserved(p, task, title) {

    const repo = p.pick.path;
    const id = `${new Date(now()).toISOString().slice(2, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6)}`;
    const name = String(title || '').trim() || shorten(task.split('\n')[0], 60);
    const branch = `hannibal/${slugify(name)}-${id.slice(-4)}`;
    await run(git, ['-C', repo, 'fetch', '--quiet', 'origin'], { timeout: 60000 });
    let base = (await run(git, ['-C', repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).out;
    if (!base) for (const b of ['origin/main', 'origin/master']) { if ((await run(git, ['-C', repo, 'rev-parse', '--verify', '--quiet', b])).ok) { base = b; break; } }
    if (!base) base = (await run(git, ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'])).out || 'HEAD';
    const worktree = path.join(jobsDir, id, 'work');
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    const wt = await run(git, ['-C', repo, 'worktree', 'add', '--quiet', '-b', branch, worktree, base]);
    if (!wt.ok) return { ok: false, error: `Could not make a copy of ${p.pick.name} to work in: ${shorten(wt.err, 200)}` };
    const remote = (await run(git, ['-C', repo, 'remote', 'get-url', 'origin'])).out;

    const job = {
      id, title: name, task, project: p.pick.name, repo, worktree, branch, base,
      baseSha: (await run(git, ['-C', worktree, 'rev-parse', 'HEAD'])).out,
      remoteWeb: githubWeb(remote), state: 'starting', round: 1, startedAt: now(), endedAt: null,
    };
    jobs.push(job);
    try { launch(job, task); }
    catch (e) { job.state = 'failed'; job.error = e.message; job.endedAt = now(); save(); return { ok: false, error: e.message }; }
    log(`started ${id} in ${job.project} on ${branch}`);
    tick();
    return { ok: true, job: view(job), message: `Started. Claude Code is working on "${name}" in ${job.project} (branch ${branch}). I'll tell you when it's done.` };
  }

  // Fred adds something to a job that ended ("also add a test"): same branch, same conversation.
  async function followUp({ job: q, text } = {}) {
    const job = find(q);
    if (!job) return { ok: false, error: q ? `No job matches "${q}".` : 'There is no job yet.' };
    if (job.state === 'running' || job.state === 'starting' || finishing.has(job.id)) return { ok: false, error: `"${job.title}" is still running or wrapping up (pushing, PR). Try again in a minute.` };
    if (!fs.existsSync(job.worktree)) return { ok: false, error: `The working copy of "${job.title}" is gone; start a new job instead.` };
    if (busy() >= maxRunning) return { ok: false, error: `${busy()} jobs are already running (max ${maxRunning}).` };
    text = String(text || '').trim();
    if (!text) return { ok: false, error: 'What should Claude Code do next?' };
    job.round = (job.round || 1) + 1;
    job.followUps = [...(job.followUps || []), text];
    Object.assign(job, { endedAt: null, error: null, summary: null, notified: false });
    try { launch(job, text, job.sessionId || null); }
    catch (e) { job.state = 'failed'; job.error = e.message; job.endedAt = now(); save(); return { ok: false, error: e.message }; }
    tick();
    return { ok: true, job: view(job), message: `Sent. Claude Code is back on "${job.title}". I'll tell you when it's done.` };
  }

  function find(q) {
    if (!jobs.length) return null;
    if (!q) return [...jobs].reverse().find((j) => j.state === 'running') || jobs[jobs.length - 1];
    const s = String(q).toLowerCase();
    const r = [...jobs].reverse();
    return r.find((j) => j.id === s) || r.find((j) => j.id.endsWith(s)) || r.find((j) => j.title.toLowerCase().includes(s))
      || r.find((j) => j.project.toLowerCase().includes(s)) || r.find((j) => j.task.toLowerCase().includes(s)) || null;
  }

  function view(job) {
    const v = { id: job.id, title: job.title, project: job.project, state: job.state, branch: job.branch,
      started: new Date(job.startedAt).toISOString(), minutes: mins((job.endedAt || now()) - job.startedAt) };
    if (job.state === 'running') {
      const lg = parseLog(readLog(job));
      v.doing = lg.lastTool || 'starting up';
      if (lg.lastText) v.lastSaid = shorten(lg.lastText, 300);
      v.steps = lg.tools;
    }
    if (job.summary) v.summary = shorten(job.summary, 900);
    if (job.error) v.error = job.error;
    if (job.commits != null) v.commits = job.commits;
    if (job.prUrl) v.pr = job.prUrl; else if (job.compareUrl && job.pushed) v.openPr = job.compareUrl;
    if (job.cost != null) v.costUsd = Math.round(job.cost * 100) / 100;
    return v;
  }

  function status({ job: q } = {}) {
    if (q) { const j = find(q); return j ? { ok: true, job: view(j) } : { ok: false, error: `No job matches "${q}".` }; }
    const recent = jobs.filter((j) => j.state === 'running' || now() - (j.endedAt || j.startedAt) < 3 * 86400000);
    return { ok: true, running: running().length, jobs: recent.slice(-8).reverse().map(view) };
  }

  function stop({ job: q } = {}) {
    const job = q ? find(q) : [...jobs].reverse().find((j) => j.state === 'running');
    if (!job) return { ok: false, error: 'No job is running.' };
    if (job.state !== 'running') return { ok: false, error: `"${job.title}" is not running (${job.state}).` };
    job.stopRequested = true; save();
    const pid = job.pid;   // this run only: a follow-up started later has another pid
    try { process.kill(-pid, 'SIGTERM'); } catch (_) { try { process.kill(pid, 'SIGTERM'); } catch (_) {} }
    setTimeout(() => { if (job.pid === pid && pidAlive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch (_) {} } }, 8000).unref();
    return { ok: true, message: `Stopping "${job.title}". What it already committed stays on branch ${job.branch}.` };
  }

  async function finish(job) {
    if (finishing.has(job.id)) return;
    finishing.add(job.id);
    try {
      const lg = parseLog(readLog(job));
      if (lg.sessionId) job.sessionId = lg.sessionId;
      if (lg.result) { job.cost = (job.cost || 0) + (lg.result.cost || 0); }
      job.summary = (lg.result && lg.result.text) || lg.lastText || null;
      if (job.stopRequested) { job.state = 'stopped'; job.stopRequested = false; }
      else if (job.timedOut) { job.state = 'failed'; job.error = `It ran longer than ${timeoutMin} minutes, so I stopped it.`; job.timedOut = false; }
      else if (lg.result && lg.result.ok) job.state = 'done';
      else {
        job.state = 'failed';
        job.error = job.spawnError ? `Claude Code could not start: ${job.spawnError}`
          : lg.result ? `Claude Code ended with "${lg.result.subtype || 'an error'}".`
            : (/not logged in|login|authenticat|api key/i.test(readLog(job)) ? 'Claude Code is not logged in on this Mac: run `claude` once in Terminal and log in.'
              : `Claude Code stopped without an answer. Last lines: ${shorten(readLog(job).split('\n').filter(Boolean).slice(-3).join(' '), 200)}`);
      }
      // Work Claude left uncommitted is committed, so nothing is lost.
      const dirty = (await run(git, ['-C', job.worktree, 'status', '--porcelain'])).out;
      if (dirty) {
        await run(git, ['-C', job.worktree, 'add', '-A']);
        await run(git, ['-C', job.worktree, 'commit', '-q', '-m', `Hannibal job: uncommitted work from "${job.title}"`]);
      }
      const cnt = (await run(git, ['-C', job.worktree, 'rev-list', '--count', `${job.baseSha}..HEAD`])).out;
      job.commits = Number(cnt) || 0;
      if (job.commits > 0 && push) {
        const pr = await run(git, ['-C', job.worktree, 'push', '-q', '-u', 'origin', job.branch], { timeout: 120000 });
        job.pushed = pr.ok;
        job.pushError = pr.ok ? null : pr.err;
        if (pr.ok && job.remoteWeb) {
          const baseBranch = job.base.replace(/^origin\//, '');
          job.compareUrl = `${job.remoteWeb}/compare/${encodeURIComponent(baseBranch)}...${job.branch}?expand=1`;
          const ghb = gh();
          if (ghb && !job.prUrl && !falsy(process.env.HANNIBAL_JOBS_PR)) {
            const body = [`Started by Hannibal for Fred (Claude Code job ${job.id}).`, '', '**Task**', '', job.task,
              ...(job.followUps || []).map((f) => `\n**Follow-up**\n\n${f}`), '', '**Summary**', '', job.summary || '(none)', '',
              'Draft: nothing was merged or deployed. Review, then merge yourself.'].join('\n');
            const r = await run(ghb, ['pr', 'create', '--draft', '--head', job.branch, '--base', baseBranch, '--title', job.title, '--body', body], { cwd: job.worktree, timeout: 60000 });
            const url = (r.out.match(/https:\/\/github\.com\/\S+\/pull\/\d+/) || [])[0];
            if (url) job.prUrl = url; else if (!r.ok) log(`gh pr create failed for ${job.id}: ${shorten(r.err, 200)}`);
          }
        }
      }
      job.endedAt = now();
      job.pid = null;
      save();
      log(`${job.id} ${job.state}: ${job.commits} commit(s)${job.prUrl ? `, ${job.prUrl}` : ''}`);
      if (!job.notified) {
        job.notified = true; save();
        try { await onDone(job, { text: doneMessage(job), spoken: spokenMessage(job) }); } catch (e) { log('telling Fred failed:', e.message); }
      }
    } finally { finishing.delete(job.id); }
  }

  // Look at every running job: ended → finish; too long → stop.
  function tick() {
    for (const job of running()) {
      if (job.state !== 'running') continue;
      if (!pidAlive(job.pid)) { finish(job).catch((e) => log('finish failed:', e.message)); continue; }
      if (now() - (job.roundStartedAt || job.startedAt) > timeoutMin * 60000 && !job.timedOut) {
        job.timedOut = true; save();
        try { process.kill(-job.pid, 'SIGTERM'); } catch (_) { try { process.kill(job.pid, 'SIGTERM'); } catch (_) {} }
      }
    }
  }
  let timer = null;
  function startMonitor() { if (!timer) { timer = setInterval(tick, pollMs); if (timer.unref) timer.unref(); tick(); } }
  function stopMonitor() { if (timer) clearInterval(timer); timer = null; }

  // Old working copies (2 weeks after the job ended) are cleaned up; branches stay.
  async function prune(maxAgeDays = 14) {
    let n = 0;
    for (const job of jobs) {
      if (job.state === 'running' || !job.endedAt || now() - job.endedAt < maxAgeDays * 86400000 || job.pruned) continue;
      await run(git, ['-C', job.repo, 'worktree', 'remove', '--force', job.worktree]);
      job.pruned = true; n += 1;
    }
    if (n) { jobs = jobs.filter((j) => !j.pruned || now() - j.endedAt < 60 * 86400000); save(); }
    return n;
  }

  // IPC: one 'codejob' channel, action + params (catalog via.raw).
  function register(ipcMain) {
    ipcMain.handle('codejob', async (_e, action, params = {}) => {
      try {
        switch (action) {
          case 'projects': { const l = projects(); return { ok: true, count: l.length, projects: l.map((p) => ({ name: p.name, where: p.rel })) }; }
          case 'start': return await start(params);
          case 'status': return status(params);
          case 'stop': return stop(params);
          case 'followUp': return await followUp(params);
          default: return { ok: false, error: `unknown action ${action}` };
        }
      } catch (e) { return { ok: false, error: e.message }; }
    });
  }

  return { projects, start, followUp, status, stop, tick, startMonitor, stopMonitor, prune, register, _jobs: () => jobs, _finish: finish };
}

module.exports = { createCodeJobs, pickProject, githubWeb, parseLog, slugify, doneMessage, spokenMessage, DENIED, ALLOWED };
