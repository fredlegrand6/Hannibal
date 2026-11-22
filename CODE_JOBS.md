# Claude Code jobs — Hannibal starts coding work for Fred

Fred asks (desk, phone app, Telegram, iPhone app): *"Hannibal, have Claude Code fix the
login redirect in revalis-housing."* Hannibal reads back the project and the task, and
starts only after Fred says **yes**. When the job ends, Fred hears it at the desk and gets it on his phone
with a summary and a draft PR link.

Code: `electron/services/code-jobs.js` (runs in the Mac's main process). Tools: `codejob.*`
in the catalog. From the phone, the server runs them on the Mac through the body link,
so **the Mac must be awake**.

## What a job does

1. Finds the project: git repos under `~/Desktop/Projects`, `~/Desktop/Saas Platforms`
   and `~/Developer`, up to two folders deep (`HANNIBAL_JOB_ROOTS`, `:`-separated, to change).
2. Makes its own copy (git worktree) on a new branch `hannibal/<title>-<id>`, from
   `origin/main`. Fred's own folder and the running Hannibal are never touched.
3. Runs headless Claude Code there (`claude -p`, stream-json), on **Fred's own Claude login**:
   Hannibal's `ANTHROPIC_API_KEY` is removed from the job, unless `HANNIBAL_JOBS_USE_API_KEY=1`.
4. Claude Code may edit, run tests and commit. It may **not** push, use `gh`, ssh, scp,
   rsync, sudo, docker, vercel, supabase, deploy scripts, osascript (`--disallowedTools`).
5. At the end Hannibal commits anything left uncommitted, pushes the branch and opens a
   **draft** PR with `gh` if it is installed and signed in. Otherwise Fred gets a
   "create PR" link. **Nothing is merged or deployed.**
6. Fred is told: a banner and his voice at the desk, plus Telegram, the phone app and iPhone push.

Follow-ups ("also add a test") continue the same Claude Code conversation on the same branch.
"How's the job going?" shows what it is doing right now. "Stop the job" stops it, and the commits stay on the branch.

A job keeps running if Hannibal restarts; it is picked up again from
`~/Library/Application Support/Hannibal/code-jobs.json`. Logs and working copies live in
`~/Library/Application Support/Hannibal/jobs/<id>/`. A working copy is removed 14 days after its job ends,
and the branch stays.

## Setup (once, on the Mac)

- Claude Code installed and logged in: run `claude` once in Terminal (it finds `~/.local/bin/claude`,
  Homebrew, or `HANNIBAL_CLAUDE_BIN`).
- Optional: GitHub CLI for real draft PRs: `brew install gh && gh auth login`.

## Settings (.env)

| key | default | what |
|---|---|---|
| `HANNIBAL_JOB_ROOTS` | the three folders above | where projects are looked for |
| `HANNIBAL_JOBS_MAX` | 2 | jobs at the same time |
| `HANNIBAL_JOB_TIMEOUT_MIN` | 90 | a job is stopped after this |
| `HANNIBAL_JOB_MODEL` | Claude Code's default | e.g. `opus` |
| `HANNIBAL_JOBS_PUSH` | on | `0` = keep the branch local |
| `HANNIBAL_JOBS_PR` | on | `0` = no `gh pr create`, only the link |
| `HANNIBAL_JOBS_USE_API_KEY` | off | `1` = bill jobs to the API key instead of Fred's plan |

## Test

`node electron/services/test-code-jobs.js`: offline, with a fake `claude` and a local git remote.
