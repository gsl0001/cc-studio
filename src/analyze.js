// Aggregate what actually works, per account: angle performance and best/worst
// posts, from the latest metrics capture per job. Writes context/insights.json
// next to performance.json so the strategist and content agent pick it up.
//
//   npm run analyze
//
// Pure SQL over existing tables — no LLM, no network. ponytail: averages and
// top/bottom lists; add significance tests when there are enough posts to need them.
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { db } from "./db.js";
import { loadRegistry } from "./registry.js";

// Latest capture per job — metrics accumulates one row per job per day.
const latest = `SELECT job_key, views, likes, comments, shares,
                       avg_watch_s, full_watch_pct, stop_at_s,
                       max(captured_at) captured_at
                  FROM metrics GROUP BY job_key`;

const byAngle = db.prepare(`
  SELECT p.angle, count(*) posts, round(avg(m.views),1) avg_views,
         max(m.views) max_views, round(avg(m.likes),1) avg_likes
    FROM jobs j
    JOIN (${latest}) m ON m.job_key = j.key
    LEFT JOIN plans p ON p.key = j.key
   WHERE j.account=? AND j.status IN ('SCHEDULED','PUBLISHED')
   GROUP BY p.angle ORDER BY avg_views DESC`);

// Slot timing: does the current posting grid match when this account performs?
const byHour = db.prepare(`
  SELECT substr(j.scheduled_for, 12, 2) hour, count(*) posts,
         round(avg(m.views),1) avg_views, round(avg(m.avg_watch_s),2) avg_watch_s
    FROM jobs j
    JOIN (${latest}) m ON m.job_key = j.key
   WHERE j.account=? AND j.status IN ('SCHEDULED','PUBLISHED')
     AND j.scheduled_for IS NOT NULL AND m.views > 0
   GROUP BY hour ORDER BY avg_views DESC`);

const posts = db.prepare(`
  SELECT j.key, p.angle, p.hook, substr(j.caption,1,80) caption,
         m.views, m.likes, m.comments, m.shares,
         m.avg_watch_s, m.full_watch_pct, m.stop_at_s
    FROM jobs j
    JOIN (${latest}) m ON m.job_key = j.key
    LEFT JOIN plans p ON p.key = j.key
   WHERE j.account=? AND j.status IN ('SCHEDULED','PUBLISHED')
   ORDER BY m.views DESC`);

for (const a of loadRegistry().accounts) {
  const all = posts.all(a.id);
  const out = {
    generated_at: new Date().toISOString(),
    posts_with_metrics: all.length,
    by_angle: byAngle.all(a.id),
    by_hour: byHour.all(a.id),
    top_posts: all.slice(0, 5),
    bottom_posts: all.slice(-5).reverse(),
    // Distribution is decided by retention, not views. avg watch under 3s on a
    // post people actually saw means the hook failed, whatever the view count.
    hook_failures: all.filter((r) => r.avg_watch_s !== null && r.avg_watch_s < 3 && r.views >= 50)
      .map((r) => ({ key: r.key, hook: r.hook, avg_watch_s: r.avg_watch_s, views: r.views })),
  };
  const file = path.join(a.workspace, "context", "insights.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`${file}: ${all.length} post(s), ${out.by_angle.length} angle(s)`);
}
