// Weekly full-analytics snapshot, per account: EVERY post on the account (not only the
// ones this pipeline made) with its post time, counts, watch time, traffic sources and
// viewer age/gender/location, plus account-level audience and follower data.
//
//   npm run insights                   every enabled account
//   npm run insights -- acme          one project
//   npm run insights -- acme-tiktok   one account
//
// Fired weekly from scripts/weekly-insights.mjs. The collection lives in the adapter
// (collectInsights); a platform without one is skipped, not failed.
import { db, log } from "./db.js";
import { launch } from "./browser.js";
import { loadRegistry } from "./registry.js";

const target = process.argv[2] || "all";
const reg = loadRegistry();
const accounts = reg.accounts.filter((a) =>
  a.enabled && (target === "all" || a.id === target || a.project === target));
if (!accounts.length) { console.error(`no enabled account matches "${target}"`); process.exit(1); }

const insert = db.prepare(`INSERT INTO insights (account, scope, ref, posted_at, summary, raw)
                           VALUES (?,?,?,?,?,?)`);
let failed = 0;
for (const a of accounts) {
  const adapter = await import(`./platforms/${a.platform}.js`);
  if (!adapter.collectInsights) { console.log(`${a.id}: no insights collector for ${a.platform} yet — skipped`); continue; }
  const known = new Set(db.prepare("SELECT DISTINCT ref FROM insights WHERE account=? AND scope='post'")
    .all(a.id).map((r) => r.ref));
  let ctx = null;
  try {
    ctx = await launch({ profile: a.browser_profile });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    const { account, posts } = await adapter.collectInsights(page, { known });
    db.exec("BEGIN");
    insert.run(a.id, "account", null, null, JSON.stringify(account.summary), JSON.stringify(account.raw));
    for (const p of posts) insert.run(a.id, "post", p.ref, p.posted_at, JSON.stringify(p.summary), JSON.stringify(p.raw));
    db.exec("COMMIT");
    const deep = posts.filter((p) => p.summary.avg_watch_s !== null).length;
    log(null, "insights", `${a.id} posts=${posts.length} deep=${deep} followers=${account.summary.followers}`);
    console.log(`${a.id}: ${posts.length} post(s), ${deep} with full analytics, followers ${account.summary.followers ?? "?"}`);
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    failed++;
    log(null, "insights_failed", `${a.id}: ${e.message.slice(0, 200)}`);
    console.error(`${a.id}: ${e.message}`);
  } finally {
    await ctx?.close().catch(() => {});
  }
}
process.exit(failed ? 1 : 0);
