// Job status view + manual resolution.
//   npm run status                     list all jobs
//   npm run status -- <key> SCHEDULED  manually resolve a job (after human-verified outcome)
import { db } from "./db.js";

const [key, newStatus] = process.argv.slice(2);

if (key && newStatus) {
  const ok = ["SCHEDULED", "PUBLISHED", "FAILED", "PLANNED"].includes(newStatus);
  if (!ok) { console.error("Allowed: SCHEDULED PUBLISHED FAILED PLANNED"); process.exit(1); }
  db.prepare("UPDATE jobs SET status=?, error=NULL, updated_at=datetime('now') WHERE key=?").run(newStatus, key);
  console.log(`${key} -> ${newStatus}`);
} else {
  const only = process.argv[2];   // optional account filter
  const rows = db.prepare(`SELECT key, account, status, attempts, scheduled_for, error FROM jobs
                            WHERE (?1 IS NULL OR account = ?1) ORDER BY account, key`).all(only ?? null);
  if (!rows.length) console.log("No jobs yet.");
  for (const r of rows) {
    console.log(`${r.key.padEnd(34)} ${r.status.padEnd(16)} ${String(r.attempts ?? 0)}x ${(r.scheduled_for ?? "").padEnd(18)} ${r.error ?? ""}`);
  }
}
