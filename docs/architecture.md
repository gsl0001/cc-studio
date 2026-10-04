# Architecture

cc-studio is a set of small Node programs around one SQLite database (`data/publisher.sqlite`),
run on a schedule, plus a desk server and the cc desktop companion. Everything is resumable:
any job can be killed (reboot, sleep, crash) and the next run picks up where it left off.

## The week, step by step

1. **Weekly insights** (`scripts/weekly-insights.mjs`, Saturday 18:00): scrapes each account's
   TikTok Studio analytics (`src/insights.js`) and per-post metrics (`src/metrics.js`), writes
   an HTML report (`reports/`), pings Telegram, then runs the strategist.
2. **Strategist** (`auto_content_pipeline/`): research (the platform's Explore feed, competitor
   posts and their sounds, trend candidates through a trend gate), a brief per account from
   its own numbers, then one Claude call per style group plans the whole week. Code, not the
   model, stamps identity, keys and status, and validates every post (claims, timing gaps,
   distinct visuals, format caps). Output: `auto_content_pipeline/output/weeks/<week>/` and the
   `week_plans` table. Each account runs one experiment a week, with arms on its posts.
3. **Pulse** (`scripts/pulse.mjs`, every 30 minutes): queues approved videos, marks posted
   ones, alerts on failed uploads, runs the daily login check, restarts the Telegram bot or
   the desk if they stopped, reminds you of a waiting video, and starts the creator when
   nothing is being made or waiting.
4. **Creator** (`scripts/creator.mjs` + `agents/creator.md`): one headless Claude Code run per
   video, in a fresh session, with the post's plan, the project's recent videos and the
   creator instructions filled in from your config. It writes a post package, builds the video
   in the project's workspace, checks it, and hands it off to `finals/<project>/`. The runner
   then compares it frame by frame with recent videos (`scripts/similar.py`, ORB features and
   RANSAC) and sends near-duplicates back for a remake. A lock keeps it to one run at a time;
   three runs without a video, a paid API it may not use, or two identical render failures
   mark the post blocked; a Claude usage limit pauses it for two hours.
5. **Review**: the video goes to Telegram (`scripts/telegram-bot.mjs`) and cc. Approve, Redo
   (your note becomes the next run's feedback) or Skip.
6. **Tick** (`scripts/tick.mjs`, every 30 minutes from 08:00): picks at most one due job and
   runs the publisher (`src/publish.js` with `src/platforms/<platform>.js`): it uploads through
   TikTok Studio in your real Chrome (`browser-profile/<profile>`), sets the caption, the AI
   label and the schedule, and verifies the post on the platform's own content list. One job
   per tick, so one stuck job costs one tick.

## Post statuses

Week posts (`week_plans`): `planned` → `rendered` | `blocked` → `approved` | `rejected` →
`queued` → `posted`.

Upload jobs (`jobs`): `PLANNED`, `UPLOADING`, `AWAITING_FINAL_ACTION`, `SCHEDULED`, `PUBLISHED`,
`FAILED` (retried up to 3 times), `MANUAL_REVIEW` / `UNKNOWN` (a human decides: after 3 failed
attempts the video comes to you to post by hand, with "I posted it" / "Retry").

## Run-time files

| File | Meaning |
|---|---|
| `STOP_AUTOMATION` | "pause": nothing renders or publishes until it's gone ("resume"). |
| `CREATOR_RUNNING` | the live creator run's pid and post key. |
| `CLAUDE_QUOTA` | when Claude's usage limit was last hit (the pulse waits 2 hours). |
| `METRICS_RUNNING` | the metrics run holds the browser profiles; the tick stands down. |
| `logs/system.jsonl` | the one timeline every part writes (`npm run logs`). |
| `logs/<task>.log` | each scheduled task's raw output. |

## The desk and cc

`src/server.js` (port 4820, localhost only) serves the dashboard (`/`), the week calendar
(`/calendar`), the browser widget (`/widget`) and the API cc uses:

- `GET /api/widget`: the live state (counts, the waiting video, upcoming posts, problems,
  folders, account names, pronunciations).
- `POST /api/widget/act`: an action (approve, skip, redo, next, pause, resume, pause_account,
  resume_account, check, pulse, tick, bot, open, retry, posted). Only fixed folders open; nothing
  typed reaches a command line.
- `POST /api/chat`, `GET /api/chat/poll`: the chat. Plain commands answer at once; anything else
  goes to one persistent Claude session (hooks, MCP and skills off) and streams back. Claude can
  only suggest an action as a button you tap.
- `GET /api/logs`: the system log, filtered.

`scripts/cc.ps1` is cc itself (WPF in Windows PowerShell): layered images built by
`scripts/cc-avatar.py` (`npm run avatar`), eyes drawn live, a voice from `scripts/voice.py`
(Kokoro, offline; `npm run voice:install`) with the Windows voice as a fallback, and speech
recognition for the mic button. Its settings live in `%APPDATA%\cc-studio-cc.json`.

## Scheduled tasks (Windows)

`npm run tasks:install` registers six Task Scheduler entries that run as you, each through
`scripts/hidden.vbs` (no console window) and `cc-studio.cmd`:

| Task | When |
|---|---|
| `cc-studio tick` | every 30 min, 08:00 to 23:30 |
| `cc-studio pulse` | every 30 min |
| `cc-studio insights` | Saturday 18:00 |
| `cc-studio bot` | at logon (restarted if it stops) |
| `cc-studio desk` | at logon |
| `cc-studio cc` | at logon |

On macOS and Linux, `npm run tasks:install` prints the equivalent cron lines.
