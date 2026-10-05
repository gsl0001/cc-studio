// The publish pass. Fired every 30 minutes by the "cc-studio tick" scheduled task.
//
//   node scripts/tick.mjs            pick at most ONE due job and publish it
//
// It does not publish anything itself: it sweeps stale claims, decides whose turn it
// is, and spawns src/publish.js as a child. One job per tick, so a wedged job costs
// one tick instead of the rest of the day (the old runner `break`d out of the whole
// batch on any non-zero exit, twice killing four of six slots).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { db, log, TERMINAL } from "../src/db.js";
import { lifecycle, note } from "../src/log.js";
import { loadRegistry, parseKey, nextSlot } from "../src/registry.js";
import { PLATFORM_GAP_MINUTES } from "../src/platforms/common.js";
import { isDayOff } from "../src/daysoff.js";

const SPAWN_DEADLINE_MS = 5 * 60_000;   // refuse to start a child this late into the tick
const CHILD_TIMEOUT_MS = 30 * 60_000;   // must exceed publish.js's 13-min content-check wait
const t0 = Date.now();
lifecycle();

if (existsSync("STOP_AUTOMATION")) { console.log("STOP_AUTOMATION present — nothing runs."); process.exit(0); }
// The weekly metrics run holds the same browser profiles. A lock older than 3h is a
// crashed run, not a live one — ignore it rather than stall posting forever.
if (existsSync("METRICS_RUNNING") && Date.now() - statSync("METRICS_RUNNING").mtimeMs < 3 * 3_600_000) {
  console.log("weekly metrics run in progress — tick stands down."); process.exit(0);
}

const reg = loadRegistry();
for (const e of reg.errors) console.log(`config ERROR  ${e}`);

sweep();
const health = new Map(db.prepare("SELECT account, ok, paused FROM account_health").all().map((r) => [r.account, r]));

const active = reg.accounts.filter((a) => {
  const why =
    !a.enabled ? "disabled"
    : reg.errors.some((e) => e.startsWith(`${a.id}:`)) ? "config errors"
    : health.get(a.id)?.paused ? "paused by a human"
    : health.get(a.id)?.ok === 0 ? `login unhealthy — npm run setup -- ${a.id}`
    // Manual-only accounts are planned and queued, but never run unattended: an
    // UPLOAD_ONLY run with nobody at the desk just burns the job into MANUAL_REVIEW.
    : a.mode !== "SCHEDULE" || !a.allow_final ? "manual-only (run it with publish-batch)"
    : null;
  if (why) console.log(`skip ${a.id.padEnd(24)} ${why}`);
  return !why;
});

// Least-recently-posted account first — computed over the REGISTRY, so an account
// with no rows at all sorts first instead of vanishing from a GROUP BY.
const lastTouch = new Map(db.prepare(
  "SELECT account, max(clicked_at) last FROM jobs GROUP BY account"
).all().map((r) => [r.account, r.last]));
active.sort((a, b) => (lastTouch.get(a.id) ?? "").localeCompare(lastTouch.get(b.id) ?? ""));

const today = new Date().toLocaleDateString("sv");
let spawned = false;

// Posts already on a day for this account (scheduled or live), by the day they go live.
const onDay = (account, day) => db.prepare(`SELECT count(*) n FROM jobs WHERE account=? AND status IN ('SCHEDULED','PUBLISHED')
                                            AND substr(scheduled_for,1,10)=?`).get(account, day).n;

for (const a of active) {
  // The cap is per posting day. For accounts that schedule, that is the day the post goes
  // live, not the day it is uploaded (2026-10-03: counting uploads made a backlog trickle
  // out one a day). A job whose day is already full moves to the next day with room
  // instead of blocking every later job on the account (it used to stay first in line
  // and be skipped forever).
  let job = null;
  for (const cand of nextJobFor(a)) {
    if (!a.can_schedule) {
      const today_n = db.prepare(`SELECT count(*) n FROM jobs WHERE account=? AND status IN ('SCHEDULED','PUBLISHED')
                                  AND date(updated_at,'localtime')=date('now','localtime')`).get(a.id).n;
      if (today_n >= a.slots.length) { console.log(`skip ${a.id.padEnd(24)} daily cap reached (${today_n}/${a.slots.length})`); break; }
      job = cand; break;
    }
    const slot = db.prepare("SELECT scheduled_for s FROM jobs WHERE key=?").get(cand.key)?.s ?? "";
    if (!slot || (onDay(a.id, slot.slice(0, 10)) < a.slots.length && !isDayOff(slot.slice(0, 10)))) { job = cand; break; }
    const moved = reslotToFreeDay(a, cand.key, slot);
    console.log(`move ${cand.key.padEnd(34)} ${slot.slice(0, 10)} is ${isDayOff(slot.slice(0, 10)) ? "a day off" : "full"} -> ${moved ?? "no free day in 14"}`);
    if (moved) { job = cand; break; }
  }
  if (!job) continue;

  const siblings = reg.accounts.filter((x) => x.platform === a.platform).map((x) => x.id);
  const mins = db.prepare(`SELECT (julianday('now') - julianday(max(clicked_at)))*1440 m FROM jobs
                            WHERE account IN (SELECT value FROM json_each(?))`).get(JSON.stringify(siblings)).m;
  // null = this platform has never been touched; that must NOT read as "too soon".
  if (mins !== null && mins < PLATFORM_GAP_MINUTES) {
    console.log(`skip ${a.id.padEnd(24)} ${a.platform} touched ${Math.round(mins)}min ago (floor ${PLATFORM_GAP_MINUTES})`);
    continue;
  }
  if (Date.now() - t0 > SPAWN_DEADLINE_MS) { console.log("past the spawn deadline — leaving it for the next tick."); break; }

  console.log(`\n=== ${job.key} (${a.id}) at ${new Date().toISOString()} ===`);
  const r = spawnSync(process.execPath, ["src/publish.js"], {
    stdio: "inherit",
    shell: false,                                  // so the timeout reaches node, not cmd.exe
    timeout: CHILD_TIMEOUT_MS,
    env: { ...process.env, JOB_KEY: job.key, ACCOUNT: a.id, AUTO: "1",
           MODE: a.mode, ALLOW_FINAL_PUBLISH: String(a.allow_final) },
  });
  const row = db.prepare("SELECT status, error FROM jobs WHERE key=?").get(job.key);
  console.log(`--- ${job.key} -> ${row?.status}${row?.error ? ` (${row.error})` : ""} exit=${r.status}`);
  note(r.status ? "error" : "info", `upload finished: ${row?.status}${row?.error ? ` (${row.error})` : ""}, exit ${r.status}`, { key: job.key });
  spawned = true;
  break;                                           // one job per tick
}

if (!spawned) console.log("Nothing due this tick.");
process.exit(0);

// The next slot on a day that still has room for this account; rewrites schedule.json.
function reslotToFreeDay(account, key, slot) {
  const taken = new Set(db.prepare("SELECT scheduled_for s FROM jobs WHERE account=? AND scheduled_for IS NOT NULL AND key<>?").all(account.id, key).map((r) => r.s));
  let after = new Date(`${slot.slice(0, 10)}T23:59`);
  for (let i = 0; i < 14; i++) {
    const at = nextSlot(account, { after, taken });
    if (!at) return null;
    if (onDay(account.id, at.slice(0, 10)) < account.slots.length) {
      writeFileSync(path.join("queue", key, "schedule.json"), JSON.stringify({ scheduled_for: at }) + "\n");
      db.prepare("UPDATE jobs SET scheduled_for=? WHERE key=?").run(at, key);
      log(key, "reslotted", `${slot.slice(0, 10)} already full -> ${at}`);
      return at;
    }
    after = new Date(`${at.slice(0, 10)}T23:59`);
  }
  return null;
}

// Claimable jobs for this account whose queue directory exists, oldest day first.
function nextJobFor(account) {
  const rows = db.prepare(`SELECT key, status, attempts FROM jobs
                            WHERE account=? AND status IN ('PLANNED','FAILED') AND attempts < 3`).all(account.id);
  const due = [];
  for (const r of rows) {
    const parsed = parseKey(r.key);
    if (!parsed) continue;
    if (!existsSync(path.join("queue", r.key))) {
      // The render was deleted or never landed. Not the job's fault — no attempt burnt.
      db.prepare("UPDATE jobs SET status='MANUAL_REVIEW', error=?, updated_at=datetime('now') WHERE key=?")
        .run("queue directory missing — the render was deleted or never landed", r.key);
      log(r.key, "queue_dir_missing");
      continue;
    }
    const releaseDay = new Date(`${parsed.date}T00:00`);
    releaseDay.setDate(releaseDay.getDate() - (account.lead_days ?? 0));
    if (releaseDay.toLocaleDateString("sv") > today) continue;
    // An account that posts now has no scheduler to hold it back, so its slot time
    // is the release time — otherwise every backlog item would go out at once.
    if (!account.can_schedule && parsed.date <= today) {
      const slot = [...account.slots].sort()[Math.min(parsed.seq - 1, account.slots.length - 1)];
      if (new Date(`${today}T${slot}`) > new Date()) continue;
    }
    due.push({ key: r.key, date: parsed.date });
  }
  due.sort((x, y) => x.date.localeCompare(y.date));
  return due;
}

function sweep() {
  // Register queue directories nobody has seen yet.
  if (existsSync("queue")) {
    for (const d of readdirSync("queue", { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith(".")) continue;
      const parsed = parseKey(d.name);
      db.prepare("INSERT OR IGNORE INTO jobs (key, account, status) VALUES (?,?,'PLANNED')")
        .run(d.name, parsed?.account ?? null);
    }
  }
  // A lease that expired AFTER the click can never be released — the outcome is
  // unknown and only a human may resolve it.
  const dead = db.prepare(`UPDATE jobs SET status='UNKNOWN',
      error='runner died after the final action — inspect the platform before ANY retry'
      WHERE status IN ('UPLOADING','AWAITING_FINAL_ACTION') AND clicked_at IS NOT NULL
        AND claimed_at < datetime('now','-45 minutes')`).run();
  // Before the click nothing was posted, so an expired lease is simply released — including
  // AWAITING_FINAL_ACTION (a reboot during the wait for the button used to strand it).
  const freed = db.prepare(`UPDATE jobs SET status='PLANNED', claimed_at=NULL
      WHERE status IN ('UPLOADING','AWAITING_FINAL_ACTION') AND clicked_at IS NULL
        AND claimed_at < datetime('now','-45 minutes')`).run();
  if (dead.changes || freed.changes) console.log(`sweep: ${dead.changes} -> UNKNOWN, ${freed.changes} released`);

  // Evidence for finished posts is dead weight after a month; UNKNOWN and
  // MANUAL_REVIEW screenshots are what a human actually still needs.
  for (const r of db.prepare(`SELECT key FROM jobs WHERE status IN ('SCHEDULED','PUBLISHED')
                               AND updated_at < datetime('now','-30 days')`).all()) {
    const dir = path.join("evidence", r.key);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}
