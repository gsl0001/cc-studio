// Post-performance capture, per account.
//
//   node src/metrics.js add <job_key> <views> [likes] [comments] [shares]
//   node src/metrics.js scrape <account-id>     one account's own session
//   node src/metrics.js sweep                   every enabled account, oldest capture first
//
// Scraping is scoped to ONE account's own posts: the old %-tiktok-% pattern offered
// one account's open session another account's captions to match, and only accidental
// caption uniqueness kept the numbers apart. The DOM walk lives in the adapter.
// At most one row per job per local day, so re-runs build a series instead of noise.
import { db, log } from "./db.js";
import { launch } from "./browser.js";
import { loadRegistry } from "./registry.js";

const cmd = process.argv[2];
const insert = db.prepare(`INSERT INTO metrics (job_key, account, views, likes, comments, shares)
  SELECT ?,?,?,?,?,?
   WHERE NOT EXISTS (SELECT 1 FROM metrics
                      WHERE job_key=? AND date(captured_at,'localtime')=date('now','localtime'))`);

if (cmd === "add") {
  const [key, views, likes, comments, shares] = process.argv.slice(3);
  if (!key || views === undefined) {
    console.error("Usage: node src/metrics.js add <job_key> <views> [likes] [comments] [shares]");
    process.exit(1);
  }
  const account = db.prepare("SELECT account FROM jobs WHERE key=?").get(key)?.account ?? null;
  insert.run(key, account, +views, +(likes ?? 0), +(comments ?? 0), +(shares ?? 0), key);
  log(key, "metrics_added", `views=${views} likes=${likes ?? 0}`);
} else if (cmd === "scrape" || cmd === "sweep") {
  const reg = loadRegistry();
  let accounts = reg.accounts.filter((a) => a.enabled);
  if (cmd === "scrape") {
    const id = process.argv[3];
    accounts = accounts.filter((a) => a.id === id);
    if (!accounts.length) { console.error(`unknown or disabled account "${id ?? ""}"`); process.exit(1); }
  } else {
    // Oldest capture first, so a sweep that gets cut short still spreads over time.
    const last = new Map(db.prepare("SELECT account, max(captured_at) c FROM metrics GROUP BY account")
      .all().map((r) => [r.account, r.c]));
    accounts.sort((a, b) => (last.get(a.id) ?? "").localeCompare(last.get(b.id) ?? ""));
  }

  let failed = 0;
  for (const a of accounts) {
    const jobs = db.prepare(`SELECT key, caption FROM jobs
                              WHERE account=? AND status IN ('SCHEDULED','PUBLISHED') AND caption IS NOT NULL`).all(a.id);
    if (!jobs.length) { console.log(`${a.id}: nothing aired yet.`); continue; }

    let ctx = null;
    try {
      const adapter = await import(`./platforms/${a.platform}.js`);
      ctx = await launch({ headless: false, profile: a.browser_profile });
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      const rows = await adapter.scrapeMetrics(page, jobs);
      for (const r of rows) {
        insert.run(r.key, a.id, r.views, r.likes, r.comments, r.shares, r.key);
        log(r.key, "metrics_scraped", `views=${r.views} likes=${r.likes}`);
      }
      // Fail loudly, never silently write zeros — a scraper that matches nothing
      // is a changed DOM, and manual entry is the reliable path.
      console.log(rows.length
        ? `${a.id}: captured ${rows.length} post(s).`
        : `${a.id}: matched 0 posts — DOM may have changed; use metrics.js add.`);
      if (!rows.length) failed++;

      // Retention (adapter-optional): updates today's rows written above.
      if (rows.length && adapter.scrapeRetention) {
        // Only aired posts: scheduled ones render an all-zero analytics page,
        // and each retention visit costs ~7s of session time.
        const aired = new Set(rows.filter((r) => r.views > 0).map((r) => r.key));
        const ret = await adapter.scrapeRetention(page, jobs.filter((j) => aired.has(j.key)));
        const upd = db.prepare(`UPDATE metrics SET avg_watch_s=?, full_watch_pct=?, stop_at_s=?
                                 WHERE job_key=? AND date(captured_at,'localtime')=date('now','localtime')`);
        let n = 0;
        for (const r of ret) n += upd.run(r.avg_watch_s, r.full_watch_pct, r.stop_at_s, r.key).changes;
        console.log(`${a.id}: retention for ${n} post(s).`);
      }
    } catch (e) {
      console.error(`${a.id}: ${e.message}`);
      failed++;
    } finally {
      await ctx?.close().catch(() => {});
    }
  }
  process.exit(failed ? 1 : 0);
} else {
  console.error("Usage: node src/metrics.js add|scrape|sweep");
  process.exit(1);
}
