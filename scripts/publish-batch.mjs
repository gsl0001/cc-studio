// Upload + schedule a specific list of queue jobs, one at a time, with jitter.
//
//   node scripts/publish-batch.mjs <key> [<key> ...]
//
// Each job runs through src/publish.js with JOB_KEY set, so future-dated keys are
// reachable (pickJob normally refuses to touch a job before its own day) and no
// unrelated queue dir can be picked up by mistake. MODE/ALLOW_FINAL_PUBLISH are
// inherited from the environment — this script never turns full-auto on by itself.
//
// Stops the whole batch on UNKNOWN (irreversible action, unverified — human only)
// or on STOP_AUTOMATION. Retries once, and only once, on the known benign
// "final button not visible/enabled" timing failure.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const keys = process.argv.slice(2);
if (!keys.length) { console.error("usage: node scripts/publish-batch.mjs <key> [<key> ...]"); process.exit(1); }

const db = new DatabaseSync("data/publisher.sqlite");
const statusOf = (k) => db.prepare("SELECT status, error FROM jobs WHERE key=?").get(k) ?? { status: "NONE", error: null };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const BENIGN = /final button not visible|not enabled|UI ambiguous/i;

const results = [];
for (const [i, key] of keys.entries()) {
  if (existsSync("STOP_AUTOMATION")) { console.log("STOP_AUTOMATION present — stopping batch."); break; }
  for (let attempt = 1; attempt <= 2; attempt++) {
    console.log(`\n===== [${i + 1}/${keys.length}] ${key} (attempt ${attempt}) =====`);
    spawnSync(process.execPath, ["src/publish.js"], { stdio: "inherit", env: { ...process.env, JOB_KEY: key } });
    const { status, error } = statusOf(key);
    console.log(`----- ${key} → ${status}${error ? ` (${error})` : ""}`);
    if (status === "MANUAL_REVIEW" && attempt === 1 && BENIGN.test(error ?? "")) {
      console.log("benign final-button timing failure — resetting to PLANNED for one retry");
      db.prepare("UPDATE jobs SET status='PLANNED', error=NULL, attempts=max(attempts-1,0) WHERE key=?").run(key);
      sleep(30_000);
      continue;
    }
    results.push({ key, status, error });
    break;
  }
  const last = results.at(-1);
  if (last?.status === "UNKNOWN") { console.log("UNKNOWN outcome — stopping batch, needs a human in TikTok Studio."); break; }
  if (i < keys.length - 1) {
    const wait = 60_000 + Math.floor(Math.random() * 120_000); // ponytail: jitter so uploads don't look mechanical
    console.log(`waiting ${Math.round(wait / 1000)}s before the next job`);
    sleep(wait);
  }
}

console.log("\n===== BATCH SUMMARY =====");
for (const r of results) console.log(`${r.status.padEnd(16)} ${r.key}${r.error ? `  ${r.error}` : ""}`);
const bad = results.filter((r) => !["SCHEDULED", "PUBLISHED"].includes(r.status));
console.log(`\n${results.length - bad.length}/${keys.length} scheduled${bad.length ? `, ${bad.length} need attention` : ""}`);
