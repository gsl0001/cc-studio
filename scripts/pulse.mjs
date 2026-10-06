// The pipeline's heartbeat, every 30 minutes ("cc-studio pulse" task). It does a few
// cheap checks and starts long work detached, so any interruption (reboot, sleep, a
// killed run, a lost Telegram message) is picked up on the next beat:
//   1. queue approved videos, mark the ones TikTok has, report jobs a human must check
//   2. once a day: login check on every account
//   3. Sunday: if Saturday's plan for next week never landed, rerun insights + strategist
//   4. a video waiting for your answer: remind every 6 hours; otherwise, if nothing is
//      rendering, start the creator on the next planned post
//
//   node scripts/pulse.mjs
import { spawn, spawnSync } from "node:child_process";
import { existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { db, log } from "../src/db.js";
import { lifecycle, note, rotateTaskLogs } from "../src/log.js";
import { notify } from "../src/telegram.js";
import { liftExpired } from "../src/pause.js";
import { nextWeek } from "../auto_content_pipeline/src/schema.js";
import { decide, relocateFinal, schedule, sendForReview, sendHandoff } from "./posts.mjs";
import { sweepInbox } from "./clips.mjs";
import { creatorRunning, nextPost, QUOTA } from "./creator.mjs";

lifecycle();
rotateTaskLogs();
// What the pulse decided, on the console (pulse.log) and in the system log.
const tell = (m, lvl = "info") => { console.log(m); note(lvl, m); };
if (liftExpired()) {
  log(null, "kill_switch", "cleared: the timed pause ended");
  tell("The timed pause ended; everything runs again.");
  await notify("▶️ Your pause is over: videos are being made and posted again.");
}
// Clips dropped in the library's inbox (too big for Telegram) answer the open request.
for (const done of sweepInbox()) {
  tell(`Clip for "${done.request.query}" came in through the inbox.`);
  if (done.request.key && done.lastForPost) {
    decide(done.request.key, "redo", `Use these clips from the library: ${done.clips.map((c) => `${c.file} (for: ${c.query})`).join("; ")}.`, null, "the inbox");
    await notify(`🎬 Got your clip for "${done.request.query}"; remaking ${done.request.key} with it.`);
  }
}
if (existsSync("STOP_AUTOMATION")) { console.log("STOP_AUTOMATION present — nothing runs."); process.exit(0); }
const HOUR = 3_600_000;
// New screens, photos and takes in the workspaces get catalogued and described (scripts/assets.mjs).
const scanMark = "library/clips/.last-scan";
const scanAge = existsSync(scanMark) ? Date.now() - statSync(scanMark).mtimeMs : Infinity;
const ageMs = (f) => (existsSync(f) ? Date.now() - statSync(f).mtimeMs : Infinity);
const detached = (script, args = []) => {
  const out = openSync(`logs/${script.replace(/^.*\/|\.m?js$/g, "")}.log`, "a");
  spawn(process.execPath, [script, ...args], { detached: true, windowsHide: true, stdio: ["ignore", out, out] }).unref();
};
if (scanAge > 6 * HOUR && existsSync("library/clips")) {
  writeFileSync(scanMark, new Date().toISOString());   // marked now, so the next pulse doesn't start a second scan
  detached("scripts/assets.mjs", ["scan"]);
  tell("Rescanning the workspaces for new assets.");
}

// 0. The Telegram bot is how approvals arrive: restart it if its heartbeat is stale
// (it writes one every poll, at most ~50 s apart).
if (ageMs("logs/.bot-heartbeat") > 5 * 60_000) {
  const r = spawnSync("schtasks", ["/run", "/tn", "cc-studio bot"], { encoding: "utf8" });
  log(null, "pulse_bot_restart", `rc=${r.status} ${(r.stdout ?? "").trim()}`.slice(0, 200));
  console.log(`Telegram bot heartbeat stale — restarted it (rc=${r.status}).`);
}

// The desk widget's server, same idea: restart it if it doesn't answer.
const desk = await fetch("http://127.0.0.1:4820/api/widget", { signal: AbortSignal.timeout(10_000) }).then((r) => r.ok).catch(() => false);
if (!desk) {
  const r = spawnSync("schtasks", ["/run", "/tn", "cc-studio desk"], { encoding: "utf8" });
  log(null, "pulse_desk_restart", `rc=${r.status}`);
}

// 1. Scheduling and posted-sync.
const lines = schedule();
for (const l of lines) console.log(l);
const worth = lines.filter((l) => !l.startsWith("posted"));
if (worth.length) await notify(`📅 Scheduling\n${worth.join("\n")}`);
// Uploads that can't be scheduled (3 failed attempts, or a job for a human): hand the video over.
for (const r of db.prepare("SELECT key FROM week_plans WHERE status='queued' AND json_extract(plan_json,'$.alert') IS NOT NULL AND json_extract(plan_json,'$.handoff_sent') IS NULL").all()) {
  await sendHandoff(r.key);
}

// 2. Logins, once a day. The tick and the metrics run use the same browser profiles, so
// wait out an upload in progress, then hold METRICS_RUNNING (the tick stands down for it).
const today = new Date().toLocaleDateString("sv");
const AUTH = "logs/.authcheck-day";
const uploading = db.prepare("SELECT 1 FROM jobs WHERE status IN ('UPLOADING','AWAITING_FINAL_ACTION')").get();
// A lock older than 3 h is a crashed run (same rule as the tick), not a live one.
const metricsBusy = existsSync("METRICS_RUNNING") && ageMs("METRICS_RUNNING") < 3 * HOUR;
if ((existsSync(AUTH) ? readFileSync(AUTH, "utf8") : "") !== today && !metricsBusy && !uploading) {
  writeFileSync(AUTH, today);
  writeFileSync("METRICS_RUNNING", String(process.pid));
  try { spawnSync(process.execPath, ["src/authcheck.js", "all"], { stdio: "inherit", timeout: 10 * 60_000 }); }
  finally { rmSync("METRICS_RUNNING", { force: true }); }
}

// 3. A lost Saturday (PC off, quota, crash): the plan for next week must exist by Sunday.
const week = nextWeek();
const RETRY = "logs/.strategist-retry";
if (new Date().getDay() === 0 && !db.prepare("SELECT 1 FROM week_plans WHERE week=?").get(week.id)
    && !metricsBusy && ageMs(RETRY) > 6 * HOUR) {
  writeFileSync(RETRY, new Date().toISOString());
  log(null, "pulse_strategist_retry", week.id);
  await notify(`♻️ No plan for ${week.id} yet — rerunning insights and the strategist.`);
  detached("scripts/weekly-insights.mjs");
}

// 4. The creator chain.
const waiting = db.prepare("SELECT key, plan_json FROM week_plans WHERE status='rendered' ORDER BY day, post_at").get();
if (waiting) {
  relocateFinal(waiting.key);
  const last = JSON.parse(waiting.plan_json).reminded_at;
  const late = JSON.parse(waiting.plan_json).day < today ? " (its day has passed; approving schedules it at the next free slot)" : "";
  // Never sent (no reminded_at) while a creator runs = its similarity check is still going;
  // the creator sends it. Otherwise (a crashed creator, or an old video) the pulse does.
  if (last ? Date.now() - Date.parse(last) > 6 * HOUR : !creatorRunning()) await sendForReview(waiting.key, `⏰ Still waiting for you${late}`);
  tell(`${waiting.key} is waiting for review.`);
} else if (creatorRunning()) tell("a creator run is going.");
else if (ageMs(QUOTA) < 2 * HOUR) tell("Claude usage limit hit recently — waiting.");
else if (nextPost()) { tell("starting the creator."); detached("scripts/creator.mjs"); }
else tell("nothing planned to make.");
