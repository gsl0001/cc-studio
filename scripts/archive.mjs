// Retire stale jobs and clear finished ones out of the queue.
//
//   node scripts/archive.mjs            show what would move (dry run)
//   node scripts/archive.mjs --apply    do it
//   node scripts/archive.mjs --apply --days 7
//
// Two groups move:
//   stale  — MANUAL_REVIEW / UNKNOWN / FAILED, untouched for --days (default 2).
//            Status becomes ARCHIVED, which is terminal, so the tick never sees
//            them again and the dashboard stops asking a human to resolve them.
//   done   — SCHEDULED / PUBLISHED jobs whose slot has passed. The row stays as
//            it is (that is the posting history); only the queue directory moves.
//
// Nothing is deleted: directories go to queue-archive/, and an ARCHIVED job can be
// brought back with `npm run status -- <key> PLANNED` plus moving its folder back.
import { existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { db, log } from "../src/db.js";

const apply = process.argv.includes("--apply");
const i = process.argv.indexOf("--days");
const days = i === -1 ? 2 : Number(process.argv[i + 1]);   // ponytail: not `|| 2` — --days 0 is a real value

const stale = db.prepare(`SELECT key, status, error FROM jobs
                           WHERE status IN ('MANUAL_REVIEW','UNKNOWN','FAILED')
                             AND updated_at < datetime('now', ?)`).all(`-${days} days`);
const done = db.prepare(`SELECT key, status FROM jobs
                          WHERE status IN ('SCHEDULED','PUBLISHED')
                            AND (scheduled_for IS NULL OR scheduled_for < datetime('now','localtime'))`).all();

let moved = 0, retired = 0;
for (const r of stale) {
  console.log(`${apply ? "retire " : "would retire "}${r.key.padEnd(34)} ${r.status}`);
  if (!apply) continue;
  db.prepare(`UPDATE jobs SET status='ARCHIVED', updated_at=datetime('now'),
                error=? WHERE key=?`).run(`archived (was ${r.status}: ${r.error ?? "no error"})`.slice(0, 300), r.key);
  log(r.key, "archived", `was ${r.status}`);
  retired++;
  if (move(r.key)) moved++;
}
for (const r of done) {
  if (!existsSync(path.join("queue", r.key))) continue;
  console.log(`${apply ? "clear  " : "would clear  "}${r.key.padEnd(34)} ${r.status} (already aired)`);
  if (apply && move(r.key)) moved++;
}

console.log(`\n${apply ? "" : "DRY RUN — "}${retired} retired, ${moved} director${moved === 1 ? "y" : "ies"} moved to queue-archive/`);
if (!apply) console.log("Re-run with --apply to do it.");

function move(key) {
  const from = path.join("queue", key);
  if (!existsSync(from)) return false;
  mkdirSync("queue-archive", { recursive: true });
  const to = path.join("queue-archive", key);
  if (existsSync(to)) return false;   // already archived under this key; leave both alone
  renameSync(from, to);
  return true;
}
