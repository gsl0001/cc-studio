// The weekly metrics pass, fired Saturday evening by the "cc-studio insights" task.
//
//   node scripts/weekly-insights.mjs
//
// Per-job metrics sweep (the strategist reads it), full insights for every account,
// the HTML report, a Telegram summary with the report attached — then the weekly
// strategist, which plans next week from what was just collected.
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import { db, log } from "../src/db.js";
import { lifecycle } from "../src/log.js";
import { notify } from "../src/telegram.js";

lifecycle();
if (existsSync("STOP_AUTOMATION")) { console.log("STOP_AUTOMATION present — nothing runs."); process.exit(0); }

// The tick shares these browser profiles; it stands down while this file exists.
writeFileSync("METRICS_RUNNING", String(process.pid));
const started = new Date().toISOString().replace("T", " ").slice(0, 19);
let rc, report;
try {
  rc = {
    sweep: run("src/metrics.js", ["sweep"], 20 * 60_000),
    insights: run("src/insights.js", ["all"], 90 * 60_000),
  };
} finally {
  rmSync("METRICS_RUNNING", { force: true });
}
report = spawnSync(process.execPath, ["scripts/insights-report.mjs"], { encoding: "utf8", timeout: 60_000 }).stdout?.trim();
run("src/export-performance.js", [], 60_000);
run("src/analyze.js", [], 60_000);

// One line per account: this run's snapshot against the one before it.
const lines = [];
for (const { account } of db.prepare("SELECT DISTINCT account FROM insights WHERE scope='account' ORDER BY account").all()) {
  const [now, prev] = db.prepare(`SELECT summary, captured_at FROM insights WHERE account=? AND scope='account'
                                   ORDER BY id DESC LIMIT 2`).all(account).map((r) => ({ ...JSON.parse(r.summary), at: r.captured_at }));
  if (now.at < started) { lines.push(`⚠️ ${account}: not collected this run`); continue; }
  const delta = prev?.followers != null && now.followers != null ? ` (${now.followers - prev.followers >= 0 ? "+" : ""}${now.followers - prev.followers})` : "";
  const top = now.locations?.[0] ? `, top ${now.locations[0].country} ${Math.round(now.locations[0].pct * 100)}%` : "";
  lines.push(`${account}: ${now.followers ?? "?"} followers${delta}, ${(now.views_28d ?? 0).toLocaleString("en-US")} views/28d${top}`);
}
const failed = Object.entries(rc).filter(([, v]) => v !== 0).map(([k]) => k);
const text = [`📊 cc-studio weekly metrics${failed.length ? ` — ${failed.join(", ")} had failures, see logs/insights.log` : ""}`, "", ...lines].join("\n");
console.log(text);
const sent = await notify(text, report && existsSync(report) ? report : null);
log(null, "weekly_insights", `sweep=${rc.sweep} insights=${rc.insights} telegram=${sent}`);

// Next week's plan, from the numbers above. Specced in
// the weekly strategist design, not built yet.
const STRATEGIST = "auto_content_pipeline/scripts/weekly-strategist.mjs";
if (existsSync(STRATEGIST)) run(STRATEGIST, [], 3 * 60 * 60_000);
else console.log("weekly strategist not built yet — skipped.");

function run(script, args, timeout) {
  const r = spawnSync(process.execPath, [script, ...args], { stdio: "inherit", timeout });
  if (r.status !== 0) console.log(`${script} exited ${r.status} — continuing.`);
  return r.status;
}
