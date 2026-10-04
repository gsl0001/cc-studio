import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { note } from "./log.js";

mkdirSync("data", { recursive: true });
export const db = new DatabaseSync("data/publisher.sqlite");

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    key TEXT PRIMARY KEY,            -- <app>-<platform>-<date>-<n>, from queue dir name
    status TEXT NOT NULL,            -- PLANNED UPLOADING AWAITING_FINAL_ACTION SCHEDULED PUBLISHED FAILED UNKNOWN MANUAL_REVIEW
    video_path TEXT,
    caption TEXT,
    scheduled_for TEXT,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_key TEXT,
    event TEXT,
    detail TEXT,
    at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS plans (
    key TEXT PRIMARY KEY,            -- matches the eventual queue job key
    app TEXT NOT NULL,
    angle TEXT,
    hook TEXT,
    caption TEXT,
    experiment_id INTEGER,
    plan_json TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_key TEXT NOT NULL,
    captured_at TEXT DEFAULT (datetime('now')),
    views INTEGER, likes INTEGER, comments INTEGER, shares INTEGER
  );
  CREATE TABLE IF NOT EXISTS experiments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    hypothesis TEXT,
    control TEXT, variant TEXT,
    status TEXT DEFAULT 'active',    -- active | done
    result TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// --- multi-project columns (idempotent; ALTER ADD COLUMN is O(1) in SQLite) ---
const addCol = (t, c, decl) => {
  const have = db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name);
  if (!have.includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${decl}`);
};
addCol("jobs", "account", "TEXT");
addCol("jobs", "attempts", "INTEGER NOT NULL DEFAULT 0");
addCol("jobs", "claimed_at", "TEXT");
addCol("jobs", "clicked_at", "TEXT");      // written BEFORE the irreversible click
addCol("plans", "account", "TEXT");
addCol("plans", "slot", "TEXT");
addCol("metrics", "account", "TEXT");
addCol("metrics", "avg_watch_s", "REAL");
addCol("metrics", "full_watch_pct", "REAL");
addCol("metrics", "stop_at_s", "REAL");
addCol("experiments", "project", "TEXT");  // NULL = global
addCol("jobs", "content_sha", "TEXT");     // the library row this job carries

db.exec(`
  -- Runtime state only; declarations live in apps/<project>/profile.json.
  -- ok is written ONLY by authcheck, paused ONLY by a human — one column for both
  -- meant the morning authcheck silently un-paused what a human stopped last night.
  CREATE TABLE IF NOT EXISTS account_health (
    account    TEXT PRIMARY KEY,
    ok         INTEGER NOT NULL DEFAULT 1,
    paused     INTEGER NOT NULL DEFAULT 0,
    note       TEXT,
    checked_at TEXT
  );
  -- The content library: one row per distinct finished render, keyed by its
  -- own bytes, so "have we posted this before?" survives renames and re-copies.
  CREATE TABLE IF NOT EXISTS content (
    sha        TEXT PRIMARY KEY,   -- sha256 of the file
    phash      TEXT,               -- 192-bit aHash over three frames, hex
    path       TEXT,               -- where it was imported from
    bytes      INTEGER,
    duration   REAL,
    width      INTEGER,
    height     INTEGER,
    thumb      TEXT,
    first_seen TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_content ON jobs(content_sha);
  CREATE INDEX IF NOT EXISTS idx_jobs_account_status ON jobs(account, status);
  CREATE INDEX IF NOT EXISTS idx_metrics_job ON metrics(job_key);
  -- Weekly full-analytics snapshots (src/insights.js), every post on the account,
  -- not only the ones this pipeline made. raw is the platform's own payload.
  CREATE TABLE IF NOT EXISTS insights (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    account     TEXT NOT NULL,
    scope       TEXT NOT NULL,      -- account | post
    ref         TEXT,               -- the platform's post id; NULL for account rows
    posted_at   TEXT,               -- UTC ISO, posts only
    captured_at TEXT DEFAULT (datetime('now')),
    summary     TEXT,               -- normalised JSON: views, age, gender, locations, ...
    raw         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_insights_account ON insights(account, scope, captured_at);
  -- Weekly strategist (auto_content_pipeline): one row per planned post.
  -- key = <account>-<day>-001, the same key the queue uses.
  CREATE TABLE IF NOT EXISTS week_plans (
    key        TEXT PRIMARY KEY,
    account    TEXT NOT NULL,
    week       TEXT NOT NULL,       -- ISO week, e.g. 2026-W41
    day        TEXT,
    post_at    TEXT,                -- local HH:MM
    hook       TEXT,
    status     TEXT NOT NULL,       -- planned | invalid | rendered | approved | rejected | queued | posted
    plan_json  TEXT NOT NULL,       -- the post object
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_week_plans_account ON week_plans(account, week);
  CREATE TABLE IF NOT EXISTS research (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project    TEXT NOT NULL,
    week       TEXT NOT NULL,
    raw        TEXT,                -- discovery, trends, competitor posts as collected
    summary    TEXT,                -- the AI summary the planner reads
    created_at TEXT DEFAULT (datetime('now'))
  );
`);
// The tick, the publish child and the dashboard all write here; SQLITE_BUSY while
// writing a post-click status is exactly the outcome this system exists to avoid.
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");

// Backfill: the key is <account>-YYYY-MM-DD-NNN, and that suffix is exactly 15
// chars, so the account parses off the end even when the id contains hyphens.
const KEY_GLOB = "*-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-[0-9][0-9][0-9]";
db.prepare(`UPDATE jobs SET account = substr(key, 1, length(key) - 15)
             WHERE account IS NULL AND key GLOB ?`).run(KEY_GLOB);
db.prepare(`UPDATE plans SET account = substr(key, 1, length(key) - 15)
             WHERE account IS NULL AND key GLOB ?`).run(KEY_GLOB);
db.exec(`UPDATE metrics SET account = (SELECT j.account FROM jobs j WHERE j.key = metrics.job_key)
          WHERE account IS NULL`);

// Statuses a scan must never re-pick. UPLOADING included: a job whose runner was
// killed mid-upload is released only by the sweep, never by the scan.
export const TERMINAL = ["SCHEDULED", "PUBLISHED", "UNKNOWN", "MANUAL_REVIEW",
                         "AWAITING_FINAL_ACTION", "UPLOADING", "ARCHIVED"];

export function setStatus(key, status, error = null) {
  db.prepare(
    "UPDATE jobs SET status=?, error=?, updated_at=datetime('now') WHERE key=?"
  ).run(status, error, key);
  log(key, "status", status + (error ? ` — ${error}` : ""));
}

// Job events also go to the system log, with a level from the event's name and detail.
const levelOf = (event, detail) =>
  /error|fail|crash/i.test(event) || (event === "status" && /^(FAILED|UNKNOWN|MANUAL_REVIEW)/.test(detail)) ? "error"
  : /restart|retry|missing|skipped|ignored|rejected|handed_to_human|cancelling|QUOTA|ok=0/i.test(`${event} ${detail}`) ? "warn" : "info";

export function log(jobKey, event, detail = "") {
  db.prepare("INSERT INTO events (job_key, event, detail) VALUES (?,?,?)").run(
    jobKey, event, String(detail)
  );
  console.log(`[${new Date().toISOString()}] ${jobKey} ${event} ${detail}`);
  note(levelOf(event, String(detail)), `${event}${detail === "" ? "" : ` ${detail}`}`, jobKey ? { key: jobKey } : {});
}
