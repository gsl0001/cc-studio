# auto_content_pipeline

The weekly content strategist: every Saturday evening, after the metrics run, it plans the
next Monday–Sunday for every TikTok account — one fully specified post per account per day
(time, hook, script, caption, hashtags, search keywords, sound, rationale, backups).

How it fits the whole pipeline: [docs/architecture.md](../docs/architecture.md). Runs every
Saturday after the metrics job. By hand: `npm run strategist` (or `-- <brand|account>`).
Tests: `node auto_content_pipeline/tests/weekly.test.mjs`.

## Layout

```text
auto_content_pipeline/
├── docs/       the design spec and anything written about this system
├── src/        stage modules: brief, research, plan, validate, schema
├── scripts/    weekly-strategist.mjs — runs the stages in order
├── tests/      weekly.test.mjs — plain assert, like the rest of the repo
└── output/     generated, gitignored
    └── weeks/<YYYY-Www>/
        ├── <account>.json         one WeekPlan per account
        ├── style-proposals.json   week-1 style suggestions to confirm
        ├── research.json          markets, competitors, trends found
        └── calendar.html          the week at a glance
```

## How it connects to the rest of cc-studio

It is a stage of cc-studio, not a separate app: it shares the repo's database, registry
and Telegram helper instead of copying them.

| Reads | From |
|---|---|
| accounts, brands, claims, styles | `apps/<project>/profile.json` via `src/registry.js` |
| weekly insights, post metrics | `insights` and `metrics` tables in `data/publisher.sqlite` via `src/db.js` |

| Writes | Used by |
|---|---|
| `output/weeks/<week>/*.json` + `week_plans` table | the generation pipeline (being reworked), later the review page and the queue — post keys match queue keys |
| Telegram summary + calendar | you, via `src/telegram.js` |

Trigger: `scripts/weekly-insights.mjs` (the Saturday 18:00 `cc-studio insights` task)
runs `auto_content_pipeline/scripts/weekly-strategist.mjs` once metrics are in.
The live publisher (tick, adapters, queue) and the insights collector stay in the repo
root because the scheduled tasks point at them.
