// The scorecard: how each post did in its first 48 hours against its own account's median.
// The 48-hour figure comes from the views-over-time TikTok Studio keeps per post (hourly, then
// daily buckets from the moment it went up), which the Saturday insights run already collects,
// so every post counts, hand-posted ones too, and nothing new is scraped. Rolled up per format
// and per hook type, it gives the strategist fixed rules:
//   dropped  the last 3 scored posts of a format (or hook type) on an account were all in that
//            account's bottom quarter: not planned there for 4 weeks
//   winner   3+ scored posts of it in the last 60 days with a median of 1.25x the account's or
//            better: at least 3 posts a week, and proven enough to post without review
//
//   node src/scorecard.js            score every post, print each account's rules
//   node src/scorecard.js test       self-check
import { db } from "./db.js";
import { family, norm } from "../auto_content_pipeline/src/validate.js";

const HOUR = 3_600_000, DAY = 24 * HOUR;
export const RULES = { baseline: 30, minPosts: 8, dropAfter: 3, dropDays: 28, winnerN: 3, winnerRatio: 1.25, windowDays: 60 };

db.exec(`CREATE TABLE IF NOT EXISTS scores (
  ref TEXT PRIMARY KEY, account TEXT NOT NULL, key TEXT, posted_at TEXT NOT NULL, views48 INTEGER NOT NULL,
  format TEXT, hook_type TEXT, pillar TEXT, arm TEXT, scored_at TEXT DEFAULT (datetime('now')))`);

// Views in the first 48 hours, or null while the post is younger than that at capture.
export function views48(insight, postedAt, capturedAt) {
  const posted = Date.parse(postedAt), age = Date.parse(capturedAt) - posted;
  if (!(age >= 48 * HOUR)) return null;
  const h = insight?.realtime_video_view_history;
  const list = (h?.list ?? []).map((x) => ({ t: Number(x.key) * 1000, v: Number(x.value) || 0 })).sort((a, b) => a.t - b.t);
  if (list.length && h.interval === 1) return list.filter((x) => x.t < posted + 48 * HOUR).reduce((s, x) => s + x.v, 0);
  if (list.length) return list.slice(0, 2).reduce((s, x) => s + x.v, 0);
  const d = (insight?.video_vv_history_7d ?? []).map((x) => Number(x.value) || 0);
  return d.length ? d[0] + (d[1] ?? 0) : null;
}

const quantile = (vals, q) => {
  const s = [...vals].sort((a, b) => a - b);
  if (!s.length) return null;
  const i = (s.length - 1) * q, lo = Math.floor(i);
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
};
const captionKey = (c) => norm(c).slice(0, 30);

// Every post with insights: its 48-hour views, and the plan behind it when the pipeline made it.
export function scoreAll() {
  const latest = db.prepare(`SELECT i.account, i.ref, i.posted_at, i.captured_at, i.raw FROM insights i
    JOIN (SELECT ref, max(id) id FROM insights WHERE scope='post' GROUP BY ref) m ON m.id = i.id`).all();
  const plans = db.prepare(`SELECT j.account, j.caption, w.key, w.plan_json FROM jobs j JOIN week_plans w ON w.key = j.key WHERE j.caption IS NOT NULL`).all()
    .map((r) => ({ account: r.account, cap: captionKey(r.caption), key: r.key, plan: JSON.parse(r.plan_json) }))
    // Posts from before the weekly strategist (src/strategist.js) kept their format as "angle".
    .concat(db.prepare(`SELECT j.account, j.caption, p.key, p.angle FROM jobs j JOIN plans p ON p.key = j.key WHERE j.caption IS NOT NULL`).all()
      .map((r) => ({ account: r.account, cap: captionKey(r.caption), key: r.key, plan: { format: r.angle } })));
  const upsert = db.prepare(`INSERT INTO scores (ref, account, key, posted_at, views48, format, hook_type, pillar, arm) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(ref) DO UPDATE SET key=excluded.key, views48=excluded.views48, format=excluded.format, hook_type=excluded.hook_type,
      pillar=excluded.pillar, arm=excluded.arm, scored_at=datetime('now')`);
  let n = 0;
  for (const r of latest) {
    const raw = JSON.parse(r.raw), v = views48(raw.insight, r.posted_at, `${String(r.captured_at).replace(" ", "T")}Z`);
    if (v == null) continue;
    const cap = captionKey(raw.item?.desc ?? "");
    const p = (cap && plans.find((x) => x.account === r.account && x.cap && (x.cap.startsWith(cap) || cap.startsWith(x.cap)))) || null;
    upsert.run(r.ref, r.account, p?.key ?? null, r.posted_at, v, p ? family(p.plan.format) || null : null,
      p?.plan.hook_type ? norm(p.plan.hook_type) : null, p ? family(p.plan.pillar) || null : null, p?.plan.experiment_arm ?? null);
    n++;
  }
  return n;
}

// Pure: one account's scored posts -> its baseline, each format's and hook type's record, and the rules.
export function deriveRules(rows, now = Date.now()) {
  const posts = [...rows].sort((a, b) => Date.parse(a.posted_at) - Date.parse(b.posted_at));
  const base = posts.slice(-RULES.baseline).map((p) => p.views48);
  if (base.length < RULES.minPosts) return { n: base.length, median: null, p25: null, dims: [], dropped: [], winners: [] };
  const median = quantile(base, 0.5), p25 = quantile(base, 0.25);
  const dims = [], dropped = [], winners = [];
  for (const dim of ["format", "hook_type"]) {
    const groups = new Map();
    for (const p of posts) if (p[dim]) groups.set(p[dim], [...(groups.get(p[dim]) ?? []), p]);
    for (const [name, list] of groups) {
      const recent = list.filter((p) => now - Date.parse(p.posted_at) < RULES.windowDays * DAY);
      const m = recent.length ? quantile(recent.map((p) => p.views48), 0.5) : null;
      const ratio = m != null && median > 0 ? Math.round((m / median) * 100) / 100 : null;
      const last = list.slice(-RULES.dropAfter);
      const until = last.length === RULES.dropAfter && last.every((p) => p.views48 < p25)
        ? new Date(Date.parse(last.at(-1).posted_at) + RULES.dropDays * DAY).toISOString().slice(0, 10) : null;
      const row = { dim, name, n: recent.length, ratio };
      dims.push(row);
      if (until && Date.parse(until) > now) dropped.push({ ...row, until, keys: last.map((p) => p.key ?? p.ref) });
      else if (recent.length >= RULES.winnerN && ratio >= RULES.winnerRatio) winners.push(row);
    }
  }
  return { n: base.length, median: Math.round(median), p25: Math.round(p25), dims, dropped, winners };
}

export function rulesFor(accounts) {
  const get = db.prepare("SELECT * FROM scores WHERE account=?");
  return Object.fromEntries(accounts.map((a) => [a, deriveRules(get.all(a))]));
}

const dimName = (d) => (d.dim === "format" ? `format "${d.name}"` : `hook type "${d.name}"`);
// The strategist's view, one block per account.
export function scorecardLines(rules) {
  return Object.entries(rules).map(([a, r]) => {
    if (r.median == null) return `- ${a}: only ${r.n} scored posts, no rules yet (needs ${RULES.minPosts})`;
    const rec = r.dims.filter((d) => d.ratio != null).sort((x, y) => y.ratio - x.ratio).map((d) => `${d.dim === "format" ? "" : "hook "}${d.name} ${d.ratio}x (n=${d.n})`);
    return [`- ${a}: median ${r.median} views in 48 h over its last ${r.n} posts. ${rec.join(", ") || "no planned posts scored yet"}`,
      ...r.winners.map((w) => `    WINNER ${dimName(w)}: ${w.ratio}x the median; use it in at least 3 posts this week`),
      ...r.dropped.map((d) => `    DROPPED ${dimName(d)} until ${d.until} (bottom quarter 3 times in a row: ${d.keys.join(", ")}); do not plan it`)].join("\n");
  }).join("\n");
}

// What validation refuses: account -> Set of "format:<family>" / "hook_type:<type>".
export const droppedSets = (rules) => new Map(Object.entries(rules).map(([a, r]) => [a, new Set(r.dropped.map((d) => `${d.dim}:${d.name}`))]));

if (import.meta.filename === process.argv[1]) {
  if (process.argv[2] === "test") {
    const { default: assert } = await import("node:assert/strict");
    const t0 = Date.parse("2026-10-01T10:00:00Z");
    const hourly = { realtime_video_view_history: { interval: 1, list: Array.from({ length: 60 }, (_, i) => ({ key: String((t0 + i * HOUR) / 1000), value: 1 })) } };
    assert.equal(views48(hourly, "2026-10-01T10:00:00Z", "2026-10-04T10:00:00Z"), 48, "hourly buckets: the first 48");
    const daily = { realtime_video_view_history: { interval: 2, list: [{ key: "3", value: 30 }, { key: "1", value: 100 }, { key: "2", value: 20 }] } };
    assert.equal(views48(daily, "2026-10-01T10:00:00Z", "2026-10-09T10:00:00Z"), 120, "daily buckets: the first 2 in time order");
    assert.equal(views48(daily, "2026-10-01T10:00:00Z", "2026-10-02T10:00:00Z"), null, "younger than 48 h: not scored");
    assert.equal(views48({ video_vv_history_7d: [{ value: 538 }, { value: 6 }, { value: "" }] }, "2026-10-01T10:00:00Z", "2026-10-09T10:00:00Z"), 544);

    const now = Date.parse("2026-10-10T12:00:00Z");
    const at = (d) => new Date(now - d * DAY).toISOString();
    const rows = [];
    for (let i = 0; i < 10; i++) rows.push({ ref: `x${i}`, posted_at: at(40 - i), views48: 100 });   // the account's usual
    rows.push({ ref: "l1", key: "k1", posted_at: at(9), views48: 10, format: "listicle", hook_type: "pain question" });
    rows.push({ ref: "l2", key: "k2", posted_at: at(7), views48: 12, format: "listicle" });
    rows.push({ ref: "l3", key: "k3", posted_at: at(5), views48: 8, format: "listicle" });
    for (let i = 0; i < 3; i++) rows.push({ ref: `w${i}`, posted_at: at(4 - i), views48: 200, format: "before after", hook_type: "specific stakes" });
    const r = deriveRules(rows, now);
    assert.equal(r.median, 100);
    assert.deepEqual(r.dropped.map((d) => [d.dim, d.name, d.until]), [["format", "listicle", "2026-11-02"]], "3 in the bottom quarter: dropped 4 weeks");
    assert.deepEqual(r.winners.map((w) => w.name).sort(), ["before after", "specific stakes"], "3 posts at 2x: winners");
    assert.equal(deriveRules(rows, Date.parse("2026-11-03T00:00:00Z")).dropped.length, 0, "a drop ends after 4 weeks");
    const two = deriveRules([...rows.slice(0, 10), rows[10], rows[11], { ...rows[12], views48: 100 }], now);
    assert.equal(two.dropped.length, 0, "one recovery breaks the run");
    assert.equal(deriveRules(rows.slice(0, 5), now).median, null, "too few posts: no rules");
    assert.ok(scorecardLines({ a: r }).includes("DROPPED format \"listicle\""));
    assert.ok(droppedSets({ a: r }).get("a").has("format:listicle"));
    console.log("scorecard ok");
  } else {
    console.log(`${scoreAll()} posts scored`);
    const accounts = db.prepare("SELECT DISTINCT account FROM scores ORDER BY account").all().map((r) => r.account);
    console.log(scorecardLines(rulesFor(accounts)));
  }
}
