// ─────────────────────────────────────────────────────────────────────────
// SELF-UPDATE — a merged pull request goes live by itself, no deploy command.
//
// Every 10 minutes (and shortly after start) the desk app looks at GitHub:
//   • new commits on main → pull them into this folder (fast-forward only);
//   • package.json / package-lock.json changed → npm install;
//   • server code changed (server/, electron/services/, package*) → run
//     ./server/deploy.sh --auto (copy + rebuild on GEX131, no Mac restart);
//   • desk code changed → restart Hannibal on the Mac once Fred is away
//     (no keyboard/mouse for 10 min and he isn't talking to Hannibal);
//   • iPhone-only / docs changes → nothing to restart.
// Then Fred hears what changed ("I updated myself: …") on his phone.
// Only ever on branch main, only fast-forward; anything odd → it stops and
// tells him once. Off switch: HANNIBAL_AUTO_UPDATE=0 in .env.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const EVERY_MS = 10 * 60e3;
const IDLE_S = 10 * 60;               // Fred away from the keyboard this long → restart is fine
const QUIET_MS = 5 * 60e3;            // …and Hannibal hasn't spoken for this long

function run(cmd, args, { cwd, timeout = 120000, env } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, env: env || process.env, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, out: String(stdout || '').trim(), err: String(stderr || (err && err.message) || '').trim() });
    });
  });
}

/** Which parts of Hannibal a list of changed files touches. */
function classify(files) {
  const f = files.filter(Boolean);
  const deps = f.some((x) => /^package(-lock)?\.json$/.test(x));
  const server = deps || f.some((x) => x.startsWith('server/') || x.startsWith('electron/services/'));
  const desk = deps || f.some((x) => !x.startsWith('server/') && !x.startsWith('ios/') && !x.startsWith('.github/')
    && !x.startsWith('data/') && !/\.md$/i.test(x));
  return { deps, server, desk };
}

/** "Merge pull request #71 from …\n\nNavigation follow-up…" → "#71 Navigation follow-up…" */
function summarize(logText) {
  const out = [];
  for (const block of String(logText || '').split('\u0000').map((b) => b.trim()).filter(Boolean)) {
    const [subject, ...rest] = block.split('\n');
    const m = subject.match(/^Merge pull request #(\d+)/);
    const title = rest.map((l) => l.trim()).find(Boolean);
    if (m) out.push(`#${m[1]} ${title || ''}`.trim());
  }
  return out;
}

// opts: dir (repo), notify(text) -> Promise, idleSeconds() -> s, lastSpokeAt() -> ms,
//       restart() (quit + reopen), run (for tests), now, log, statePath
function createSelfUpdate(opts = {}) {
  const dir = opts.dir;
  const exec = opts.run || run;
  const log = opts.log || ((...a) => console.log('[update]', ...a));
  const now = opts.now || (() => Date.now());
  // Never wait for a password prompt (there is nobody to type it).
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
  const git = (...args) => exec('git', args, { cwd: dir, timeout: 90000, env: gitEnv });
  let busy = false;
  let pendingRestart = null;          // { summary } waiting for Fred to be away
  let warned = '';                    // last problem told to Fred (once each)

  const state = (() => { try { return JSON.parse(fs.readFileSync(opts.statePath, 'utf8')); } catch (_) { return {}; } })();
  const save = () => { if (!opts.statePath) return; try { fs.writeFileSync(opts.statePath, JSON.stringify(state, null, 2)); } catch (_) {} };

  async function problem(text) {
    log(text);
    if (warned === text) return { ok: false, error: text };
    warned = text;
    try { await opts.notify(`🔧 I couldn't update myself: ${text}`); } catch (_) {}
    return { ok: false, error: text };
  }

  async function check() {
    if (busy) return { ok: true, skipped: 'busy' };
    busy = true;
    try {
      const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
      if (!branch.ok) return { ok: false, error: 'not a git folder' };
      if (branch.out !== 'main') { log(`on branch ${branch.out}, not main: not updating`); return { ok: true, skipped: 'not main' }; }
      const fetched = await git('fetch', '-q', 'origin', 'main');
      if (!fetched.ok) { log('fetch failed:', fetched.err); return { ok: false, error: 'fetch failed' }; }   // offline: try later, quietly
      const head = (await git('rev-parse', 'HEAD')).out;
      const remote = (await git('rev-parse', 'FETCH_HEAD')).out;
      if (!head || !remote || head === remote) return { ok: true, upToDate: true };
      if (!(await git('merge-base', '--is-ancestor', head, remote)).ok) {
        return { ok: true, skipped: 'local commits' };      // the Mac has its own commits: leave it to Fred
      }
      const files = (await git('diff', '--name-only', head, remote)).out.split('\n');
      const prs = summarize((await git('log', '-z', '--merges', '--format=%s%n%b', `${head}..${remote}`)).out);
      let merged = await git('merge', '--ff-only', '-q', remote);
      if (!merged.ok) {
        // Xcode rewrites ios/ files when the project is opened (reordering, team).
        // Park those local edits, update, and put them back where they still fit.
        const parked = await git('stash', 'push', '-q', '-m', 'hannibal-self-update', '--', 'ios');
        if (parked.ok && !/No local changes/i.test(parked.out + parked.err)) {
          merged = await git('merge', '--ff-only', '-q', remote);
          const back = await git('stash', 'pop', '-q');
          if (!back.ok) {
            await git('checkout', '--', 'ios');
            log('local Xcode edits did not fit the new ios/ files: kept in git stash (hannibal-self-update)');
          }
        }
      }
      if (!merged.ok) return problem(`pulling the new code failed (${merged.err.split('\n')[0] || 'git'}). A file here was changed by hand; run git status in hannibal-v2.`);
      warned = '';
      const what = classify(files);
      log(`pulled ${head.slice(0, 7)}..${remote.slice(0, 7)} (${prs.join(', ') || `${files.length} files`})`, what);
      if (what.deps) {
        const npm = await exec('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, timeout: 600000 });
        if (!npm.ok) return problem(`npm install failed: ${npm.err.split('\n').slice(-1)[0]}`);
      }
      const summary = prs.length ? prs.join('; ') : `${files.length} changed files`;
      let serverNote = '';
      if (what.server) {
        const dep = await exec(path.join(dir, 'server', 'deploy.sh'), ['--auto'], { cwd: dir, timeout: 900000 });
        if (!dep.ok) return problem(`the server deploy failed: ${(dep.err || dep.out).split('\n').filter(Boolean).slice(-1)[0] || 'unknown'}`);
        serverNote = ' The server is updated.';
      }
      state.version = remote; state.at = now(); save();
      if (what.desk) {
        pendingRestart = { summary };
        try { await opts.notify(`🔧 I updated myself: ${summary}.${serverNote} I'll restart at the desk once you're away from the Mac.`); } catch (_) {}
        maybeRestart();
      } else {
        try { await opts.notify(`🔧 I updated myself: ${summary}.${serverNote}`); } catch (_) {}
      }
      return { ok: true, updated: true, summary, ...what };
    } finally { busy = false; }
  }

  function maybeRestart() {
    if (!pendingRestart) return false;
    const idle = opts.idleSeconds ? opts.idleSeconds() : IDLE_S;
    const spoke = opts.lastSpokeAt ? opts.lastSpokeAt() : 0;
    if (idle < IDLE_S || now() - spoke < QUIET_MS) return false;
    log('restarting with the new code');
    pendingRestart = null;
    opts.restart();
    return true;
  }

  let timers = [];
  function start() {
    if (process.env.HANNIBAL_AUTO_UPDATE === '0') { log('off (HANNIBAL_AUTO_UPDATE=0)'); return; }
    const tick = () => check().catch((e) => log('check failed:', e.message));
    timers.push(setTimeout(tick, 90e3));
    timers.push(setInterval(tick, EVERY_MS));
    timers.push(setInterval(maybeRestart, 60e3));
    for (const t of timers) if (t.unref) t.unref();
  }
  function stop() { for (const t of timers) { clearTimeout(t); clearInterval(t); } timers = []; }

  return { check, maybeRestart, start, stop, _pending: () => pendingRestart };
}

module.exports = { createSelfUpdate, classify, summarize };
