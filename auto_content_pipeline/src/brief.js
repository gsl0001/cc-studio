// Account brief: the facts the planner reads, computed in code so every number is
// exact. briefFrom is pure; the loaders below read the repo's database.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { db } from "../../src/db.js";
import { loadRegistry } from "../../src/registry.js";
import { projectWorkspace } from "../../src/config.js";

const top = (obj, k) => (obj ? Object.entries(obj).filter(([key]) => key !== "Other").sort((a, b) => b[1] - a[1]).slice(0, k) : []);
const round = (v, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

// Second at which fewer than half the viewers remain; null without a curve.
export const dropOff = (retention) => retention?.find(([, v]) => v < 0.5)?.[0] ?? null;

export function briefFrom({ account, snapshots, posts, recentHooks, now = new Date() }) {
  const [newest = {}, previous] = snapshots;
  // TikTok sometimes omits a section (e.g. locations) in one capture: last week's
  // value is better than none.
  const latest = { ...previous, ...Object.fromEntries(Object.entries(newest).filter(([, v]) => v != null)) };
  const within = (days) => posts.filter((p) => now - new Date(p.at) <= days * 86_400_000);
  const card = (p) => ({
    day: p.at.slice(0, 10), caption: (p.caption ?? "").slice(0, 100), views: p.views,
    avg_watch_s: p.avg_watch_s ?? null, full_watch_pct: p.full_watch_pct ?? null, drop_off_s: dropOff(p.retention),
    top_traffic: top(p.traffic, 1)[0]?.[0] ?? null, search_terms: top(p.search_terms, 3).map(([k]) => k),
  });
  const recent = within(28).sort((a, b) => b.views - a.views);
  const byHour = new Map();
  for (const p of within(60)) {
    const h = new Date(p.at).getHours();
    byHour.set(h, [...(byHour.get(h) ?? []), p.views]);
  }
  const hours = latest.active_hours;
  return {
    account,
    followers: latest.followers ?? null,
    follower_delta: previous?.followers != null && latest.followers != null ? latest.followers - previous.followers : null,
    views_28d: latest.views_28d ?? null,
    audience: {
      age: Object.fromEntries(top(latest.age, 6).map(([k, v]) => [k, round(v)])),
      gender: Object.fromEntries(top(latest.gender, 3).map(([k, v]) => [k, round(v)])),
      countries: (latest.locations ?? []).slice(0, 5).map((c) => ({ country: c.country, pct: round(c.pct) })),
      cities: (latest.locations ?? [])
        .flatMap((c) => top(c.cities, 3).map(([city, v]) => ({ city: `${city}, ${c.country}`, pct: round(v * c.pct, 3) })))
        .sort((a, b) => b.pct - a.pct).slice(0, 5),
    },
    // TikTok reports active hours on its own clock: use them as relative peaks, not local times.
    audience_peak_hours: hours ? hours.map((v, h) => [h, v]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h]) => h) : [],
    best_post_hours: [...byHour].filter(([, v]) => v.length >= 2)
      .map(([hour, v]) => ({ hour, avg_views: Math.round(v.reduce((a, b) => a + b, 0) / v.length), posts: v.length }))
      .sort((a, b) => b.avg_views - a.avg_views).slice(0, 3),
    top_posts: recent.slice(0, 3).map(card),
    bottom_posts: recent.length > 3 ? recent.slice(-3).reverse().map(card) : [],
    traffic: Object.fromEntries(top(latest.traffic, 4).map(([k, v]) => [k, round(v)])),
    search_terms: top(latest.search_terms, 8).map(([k]) => k),
    also_watched: (latest.also_watched_creators ?? []).slice(0, 8).map((c) => c.handle),
    recent_hooks: recentHooks,
  };
}

// The two newest account snapshots, newest first.
export function latestSnapshots(accountId) {
  return db.prepare("SELECT summary, captured_at FROM insights WHERE account=? AND scope='account' ORDER BY id DESC LIMIT 2")
    .all(accountId).map((r) => ({ ...JSON.parse(r.summary), captured_at: r.captured_at }));
}

// Every post with its latest counts; analytics fall back to the last full capture
// (older posts are only re-counted each week) — same merge as insights-report.mjs.
export function mergedPosts(accountId) {
  const merged = new Map();
  for (const r of db.prepare("SELECT ref, posted_at, summary FROM insights WHERE account=? AND scope='post' ORDER BY id").all(accountId)) {
    const fresh = Object.fromEntries(Object.entries(JSON.parse(r.summary)).filter(([, v]) => v != null));
    merged.set(r.ref, { ...merged.get(r.ref), at: r.posted_at, ...fresh });
  }
  return [...merged.values()];
}

// Hooks used on these accounts in the last `days` days, by either strategist.
// excludeWeek leaves out the week being (re)planned, so a rerun does not reject
// its own earlier hooks as repeats.
export function recentHooks(accountIds, { days = 30, excludeWeek = "" } = {}) {
  const ids = JSON.stringify(accountIds);
  const since = `-${days} days`;
  const rows = [
    ...db.prepare("SELECT hook FROM plans WHERE account IN (SELECT value FROM json_each(?)) AND created_at > datetime('now', ?)").all(ids, since),
    ...db.prepare("SELECT hook FROM week_plans WHERE account IN (SELECT value FROM json_each(?)) AND created_at > datetime('now', ?) AND week <> ?").all(ids, since, excludeWeek),
  ];
  return [...new Set(rows.map((r) => r.hook).filter(Boolean))];
}

export function loadBrief(account, siblingIds, excludeWeek = "") {
  return briefFrom({ account: account.id, snapshots: latestSnapshots(account.id), posts: mergedPosts(account.id),
    recentHooks: recentHooks(siblingIds, { excludeWeek }) });
}

// ------------------------------------------------------------------ distinctiveness + experiments
// What each account posted (planned) in the last `days` days, so the planner can avoid it:
// format, pillar, visual (the one primary screen/footage/scene) and hook.
export function recentPosts(accountIds, { days = 14, excludeWeek = "" } = {}) {
  return db.prepare(`SELECT account, day, plan_json FROM week_plans
                     WHERE account IN (SELECT value FROM json_each(?)) AND week <> ? AND status NOT IN ('invalid','rejected')
                       AND day >= date('now', ?) ORDER BY day`).all(JSON.stringify(accountIds), excludeWeek, `-${days} days`)
    .map((r) => { const p = JSON.parse(r.plan_json); return { account: r.account, day: r.day, format: p.format, pillar: p.pillar, visual: p.visual ?? null, hook: p.hook?.text }; });
}

// Pure: one account-week's experiment against the views its posts got. Each arm needs at
// least 2 measured posts; a winner needs a 20% lead, otherwise it is inconclusive.
// Judged on watch time when the experiment's goal is about holding viewers, else on views
// (GUIDELINES §5 puts views last; most hypotheses target the hold).
export function readExperiment(experiment, posts) {
  const byWatch = /watch|hold|retention|second|3s/i.test(experiment?.success_metric ?? "");
  const field = byWatch ? "watch" : "views";
  const arm = (name) => {
    const vals = posts.filter((p) => p.experiment_arm === name && p[field] != null).map((p) => p[field]);
    const views = posts.filter((p) => p.experiment_arm === name && p.views != null).map((p) => p.views);
    const avg = (xs, d = 0) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10 ** d) / 10 ** d : null);
    return { n: vals.length, avg_views: avg(views), avg_watch_s: byWatch ? avg(vals, 2) : null };
  };
  const control = arm("control"), variant = arm("variant");
  const key = byWatch ? "avg_watch_s" : "avg_views";
  let verdict = "not enough measured posts yet";
  if (control.n >= 2 && variant.n >= 2) {
    const lead = (variant[key] - control[key]) / Math.max(control[key], byWatch ? 0.1 : 1);
    verdict = (lead >= 0.2 ? "variant won" : lead <= -0.2 ? "control won" : "inconclusive (under 20% apart)") + ` on ${byWatch ? "watch time" : "views"}`;
  }
  return { hypothesis: experiment?.hypothesis, control_desc: experiment?.control, variant_desc: experiment?.variant, control, variant, verdict };
}

// Last weeks' experiments per account with their results, read from the week files and the
// latest metrics of each post's queued job.
export function experimentReadout(accountIds, { weeks = [], dir = "auto_content_pipeline/output/weeks" } = {}) {
  const latest = (key) => (key ? db.prepare("SELECT views, avg_watch_s FROM metrics WHERE job_key=? ORDER BY id DESC LIMIT 1").get(key) : null);
  // Only posts live for 3+ days count: a scheduled post scrapes as 0 views, and a day-old
  // one has a fraction of its views (2026-10-03 review).
  const cutoff = new Date(Date.now() - 3 * 86_400_000).toLocaleDateString("sv");
  const out = [];
  for (const week of weeks) {
    for (const account of accountIds) {
      const file = `${dir}/${week}/${account}.json`;
      if (!existsSync(file)) continue;
      const plan = JSON.parse(readFileSync(file, "utf8"));
      if (!plan.experiment?.hypothesis) continue;
      const posts = plan.posts.map((p) => {
        const row = db.prepare("SELECT plan_json FROM week_plans WHERE key=?").get(p.key);
        const live = row ? JSON.parse(row.plan_json) : p;
        if (!live.day || live.day > cutoff) return { experiment_arm: live.experiment_arm, views: null, watch: null };
        const m = latest(live.queue_key);
        return { experiment_arm: live.experiment_arm, views: m?.views ?? null, watch: m?.avg_watch_s ?? null };
      });
      out.push({ account, week, ...readExperiment(plan.experiment, posts) });
    }
  }
  return out;
}

// The project's real screens and footage by name, so "visual" points at things that exist.
export function visualInventory(project) {
  const profile = loadRegistry().projects.find((p) => p.id === project);
  const root = profile ? projectWorkspace(profile) : null;
  if (!root || !existsSync(root)) return [];
  return ["assets/images", "assets/ui", "assets/clips", "capture/assets"].flatMap((d) => {
    const p = `${root}/${d}`;
    return existsSync(p) ? readdirSync(p).filter((f) => /\.(png|jpe?g|mp4|mov|webm)$/i.test(f)).map((f) => `${d}/${f}`) : [];
  }).slice(0, 60);
}
