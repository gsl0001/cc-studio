// Renders the latest insights snapshot per account to reports/insights-<date>.html.
//   node scripts/insights-report.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { db } from "../src/db.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const n = (v) => v == null ? "–" : Number(v).toLocaleString("en-US", { maximumFractionDigits: 1 });
const pct = (v) => v == null ? "–" : `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
const top = (obj, k = 5) => obj ? Object.entries(obj).filter(([key]) => key !== "Other").sort((a, b) => b[1] - a[1]).slice(0, k) : [];
const bars = (obj) => top(obj, 6).map(([k, v]) =>
  `<div class="bar"><span>${esc(k.replace(/_vv$/, ""))}</span><i style="width:${Math.round(v * 100)}%"></i><b>${pct(v)}</b></div>`).join("") || "<p class=muted>not enough data</p>";
const localTime = (iso) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const accounts = db.prepare(`SELECT account, summary, captured_at FROM insights i WHERE scope='account'
  AND id = (SELECT max(id) FROM insights WHERE account=i.account AND scope='account') ORDER BY account`).all();

const sections = accounts.map(({ account, summary, captured_at }) => {
  const s = JSON.parse(summary);
  // Older posts are only re-counted each week, not re-analysed: merge oldest -> newest so
  // the latest counts win and the last full analytics survive underneath them.
  const merged = new Map();
  for (const r of db.prepare("SELECT ref, posted_at, summary FROM insights WHERE account=? AND scope='post' ORDER BY id").all(account)) {
    const fresh = Object.fromEntries(Object.entries(JSON.parse(r.summary)).filter(([, v]) => v != null));
    merged.set(r.ref, { ...merged.get(r.ref), at: r.posted_at, ...fresh });
  }
  const posts = [...merged.values()].sort((a, b) => b.at.localeCompare(a.at));
  const countries = (s.locations ?? []).slice(0, 5).map((c) =>
    `<div class="bar"><span>${esc(c.country)}</span><i style="width:${Math.round(c.pct * 100)}%"></i><b>${pct(c.pct)}</b></div>`).join("") || "<p class=muted>not enough data</p>";
  const cities = (s.locations ?? []).flatMap((c) => top(c.cities, 3).map(([city, v]) => [`${city}, ${c.country}`, v * c.pct]))
    .sort((a, b) => b[1] - a[1]).slice(0, 6);
  const hrs = s.active_hours;
  const peak = hrs ? hrs.indexOf(Math.max(...hrs)) : null;
  const byHour = new Map();
  for (const p of posts) {
    const h = new Date(p.at).getHours();
    byHour.set(h, [...(byHour.get(h) ?? []), p.views]);
  }
  const bestPostHour = [...byHour].map(([h, v]) => [h, v.reduce((a, b) => a + b, 0) / v.length, v.length])
    .filter(([, , c]) => c >= 2).sort((a, b) => b[1] - a[1])[0];
  const avgWatch = posts.filter((p) => p.avg_watch_s != null);
  const rows = posts.map((p) => `<tr><td>${esc(localTime(p.at))}</td><td class=cap>${esc((p.caption ?? "").slice(0, 70))}</td>
    <td>${n(p.views)}</td><td>${n(p.likes)}</td><td>${n(p.comments)}</td><td>${n(p.shares)}</td><td>${n(p.saves)}</td>
    <td>${p.avg_watch_s == null ? "–" : `${n(p.avg_watch_s)}s`}</td><td>${pct(p.full_watch_pct)}</td>
    <td>${n(p.unique_viewers)}</td><td>${pct(p.new_viewer_pct)}</td>
    <td>${esc(p.locations?.[0] ? `${p.locations[0].country} ${pct(p.locations[0].pct)}` : "–")}</td>
    <td class=cap>${esc(top(p.search_terms, 3).map(([k]) => k).join(" · ") || "–")}</td></tr>`).join("");
  return `<section><h2>${esc(account)}</h2><p class=muted>snapshot ${esc(captured_at)} UTC · ${posts.length} posts</p>
  <div class=kpis>
    <div><b>${n(s.followers)}</b><span>followers</span></div>
    <div><b>${n(s.views_28d)}</b><span>views, 28 days</span></div>
    <div><b>${n(s.viewers_7d)}</b><span>unique viewers, 7 days</span></div>
    <div><b>${n(s.likes_28d)}</b><span>likes, 28 days</span></div>
    <div><b>${n(s.shares_28d)}</b><span>shares, 28 days</span></div>
    <div><b>${avgWatch.length ? `${n(avgWatch.reduce((t, p) => t + p.avg_watch_s, 0) / avgWatch.length)}s` : "–"}</b><span>avg watch time</span></div>
  </div>
  <div class=grid>
    <div><h3>Viewer age</h3>${bars(s.age)}</div>
    <div><h3>Viewer gender</h3>${bars(s.gender)}</div>
    <div><h3>Top countries</h3>${countries}</div>
    <div><h3>Top cities</h3>${cities.map(([k, v]) => `<div class="bar"><span>${esc(k)}</span><i style="width:${Math.round(v * 100)}%"></i><b>${pct(v)}</b></div>`).join("") || "<p class=muted>not enough data</p>"}</div>
    <div><h3>Traffic sources</h3>${bars(s.traffic)}</div>
    <div><h3>What viewers searched to find you</h3>${bars(s.search_terms)}</div>
    <div><h3>Your viewers also watch</h3>${(s.also_watched_creators ?? []).slice(0, 8).map((c) =>
      `<div class="row"><span>@${esc(c.handle)}</span><b>${n(c.followers)} followers</b></div>`).join("") || "<p class=muted>not enough data</p>"}</div>
    <div><h3>Timing</h3><p>Viewers most active around <b>${peak == null ? "–" : `${peak}:00`}</b> (TikTok's clock).</p>
      <p>Best posting hour so far: <b>${bestPostHour ? `${bestPostHour[0]}:00` : "–"}</b>${bestPostHour ? ` (avg ${n(bestPostHour[1])} views over ${bestPostHour[2]} posts)` : " (needs 2+ posts per hour)"}.</p></div>
  </div>
  <details><summary>All posts</summary><div class=scroll><table><thead><tr><th>Posted</th><th>Caption</th><th>Views</th><th>Likes</th><th>Comm.</th><th>Shares</th><th>Saves</th><th>Avg watch</th><th>Full watch</th><th>Viewers</th><th>New viewers</th><th>Top country</th><th>Search terms</th></tr></thead>
  <tbody>${rows}</tbody></table></div></details></section>`;
}).join("");

const html = `<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Account Insights</title><style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--card:#fff;--line:#e7e5e4;--bar:#0d9488}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--card:#292524;--line:#44403c;--bar:#2dd4bf}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px}h1{margin:0 0 4px}h2{margin:0}h3{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:0 0 8px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin:20px 0}
.muted{color:var(--muted);margin:2px 0 12px}.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:16px}
.kpis div{border:1px solid var(--line);border-radius:8px;padding:10px}.kpis b{display:block;font-size:22px;font-variant-numeric:tabular-nums}.kpis span{color:var(--muted);font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:20px}
.bar{display:grid;grid-template-columns:110px 1fr 48px;align-items:center;gap:8px;font-size:13px;margin:3px 0}.bar span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar i{display:block;height:8px;border-radius:4px;background:var(--bar);min-width:2px}.bar b{font-weight:500;text-align:right;font-variant-numeric:tabular-nums}
.row{display:flex;justify-content:space-between;gap:8px;font-size:13px;margin:3px 0}.row b{font-weight:500;color:var(--muted)}
details{margin-top:16px}summary{cursor:pointer;font-weight:600}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px;margin-top:8px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap;font-variant-numeric:tabular-nums}td.cap{white-space:normal;min-width:220px}
</style></head><body><main><h1>Account insights</h1><p class=muted>Latest weekly snapshot per account, generated ${esc(new Date().toLocaleString())}. Percentages are shares of views.</p>
${sections || "<p>No insights collected yet — run npm run insights.</p>"}</main></body></html>`;

mkdirSync("reports", { recursive: true });
const out = `reports/insights-${new Date().toLocaleDateString("sv")}.html`;
writeFileSync(out, html);
console.log(out);
