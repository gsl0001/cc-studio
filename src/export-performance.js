// Export per-account post performance into each account's workspace, so the content
// agent can learn from what actually aired. Idempotent — re-run any time.
//
//   npm run export-performance
//
// LEFT JOIN from jobs, not an inner join through plans: 64 of the aired posts have no
// plan row at all, and an aired post with no numbers is itself signal.
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { db } from "./db.js";
import { loadRegistry } from "./registry.js";

const rows = db.prepare(`
  SELECT j.key, j.status, j.scheduled_for, j.caption,
         p.angle, p.hook,
         m.views, m.likes, m.comments, m.shares, m.captured_at
    FROM jobs j
    LEFT JOIN plans   p ON p.key     = j.key
    LEFT JOIN metrics m ON m.job_key = j.key
   WHERE j.account = ? AND j.status IN ('SCHEDULED','PUBLISHED')
   ORDER BY j.updated_at DESC, m.captured_at
`);

for (const a of loadRegistry().accounts) {
  const out = path.join(a.workspace, "context", "performance.json");
  mkdirSync(path.dirname(out), { recursive: true });
  const data = rows.all(a.id);
  writeFileSync(out, JSON.stringify(data, null, 2) + "\n");
  console.log(`${out}: ${data.length} row(s)`);
}
