// The week at a glance: accounts down, days across, every post's time, hook, caption
// and hashtags; invalid posts in red with their reasons; research per brand below.
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const dayName = (d) => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

function cell(p) {
  if (!p) return `<td class="empty">—</td>`;
  const invalid = p.status === "invalid";
  return `<td><div class="post${invalid ? " invalid" : ""}">
    <b>${esc(p.post_at)}</b> <span class="muted">${esc(p.pillar)} · ${esc(p.format)}</span>
    ${p.experiment_arm ? `<span class="arm ${esc(p.experiment_arm)}">${esc(p.experiment_arm)}</span>` : ""}
    ${p.visual ? `<p class="muted">visual: ${esc(p.visual)}</p>` : ""}
    <p class="hook">${esc(p.hook?.text)}</p>
    <p>${esc((p.caption ?? "").slice(0, 140))}</p>
    <p class="tags">${esc((p.hashtags ?? []).join(" "))}</p>
    ${invalid ? `<p class="why">${esc((p.problems ?? []).join("; "))}</p>` : ""}
    <details><summary>script · ${esc(p.duration_s)}s</summary>
      <ol>${(p.script ?? []).map((s) => `<li><b>${esc(s.start)}–${esc(s.end)}s</b> ${esc(s.visual)}<br><i>${esc(s.voiceover)}</i> ${s.overlay ? `[${esc(s.overlay)}]` : ""}</li>`).join("")}</ol>
      <p><b>Why:</b> ${esc(p.rationale)}</p><p><b>Time:</b> ${esc(p.time_reason)}</p><p><b>Sound:</b> ${esc(p.sound)}</p>${p.trend ? `<p><b>Trend:</b> ${esc(p.trend)}</p>` : ""}
      <p><b>Search:</b> ${esc((p.search_keywords ?? []).join(", "))} · <b>AI label:</b> ${p.is_aigc ? "yes" : "no"}</p>
    </details></div></td>`;
}

const safeUrl = (u) => (/^https:\/\//.test(u ?? "") ? u : null);
const trendList = (title, items) => (items.length ? `<h3>${esc(title)}</h3><ul>${items.map((i) =>
  `<li>${safeUrl(i.url) ? `<a href="${esc(i.url)}">${esc(i.name)}</a>` : esc(i.name)} <span class="muted">${esc(i.text)}</span></li>`).join("")}</ul>` : "");

export function renderCalendar({ week, days, plans, research, models }) {
  const rows = plans.map((plan) => `<tr><th>${esc(plan.account)}<span class="muted">${esc(plan.style?.pillar ?? "")}</span>
    ${plan.experiment?.hypothesis ? `<span class="test">Test: ${esc(plan.experiment.hypothesis)}<br>control: ${esc(plan.experiment.control)}<br>variant: ${esc(plan.experiment.variant)}<br>metric: ${esc(plan.experiment.success_metric)}</span>` : ""}</th>
    ${days.map((d) => cell(plan.posts.find((p) => p.day === d && p.status !== "invalid") ?? plan.posts.find((p) => p.day === d))).join("")}</tr>`).join("");
  const brands = Object.entries(research ?? {}).map(([pid, r]) => `<section><h2>${esc(pid)} research</h2>
    <p><b>Markets:</b> ${esc((r.discovery?.markets ?? []).map((m) => m.code).join(", ") || "—")}
     · <b>Competitors:</b> ${esc((r.discovery?.competitors ?? []).map((c) => `@${c.handle}`).join(" ") || "—")}</p>
    <p><b>Working now:</b> ${esc((r.summary?.formats_working ?? []).join(" · ") || "—")}</p>
    <p><b>Hashtags:</b> ${esc((r.summary?.hashtags ?? []).join(" ") || "—")}</p>
    ${trendList("Sounds to use", (r.summary?.sounds ?? []).map((s) => ({ name: s.name, url: s.url,
      text: `${s.why ?? ""} ${s.how_to_use ?? ""}${s.business_safe === false ? " · not for business accounts" : ""}` })))}
    ${trendList("Trends to leverage", (r.summary?.trends_to_leverage ?? []).map((t) => ({ name: `${t.name} (${t.type})`, url: t.evidence,
      text: `${t.why_now ?? ""} → ${t.how_to_use ?? ""}${t.use_by ? ` · use by ${t.use_by}` : ""}` })))}
    ${(r.errors ?? []).length ? `<p class="why">${esc(r.errors.join("; "))}</p>` : ""}</section>`).join("");
  return `<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Week Plan ${esc(week)}</title><style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--card:#fff;--line:#e7e5e4;--bad:#dc2626;--accent:#0d9488}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--card:#292524;--line:#44403c;--bad:#f87171;--accent:#2dd4bf}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}main{padding:24px 16px}
.scroll{overflow-x:auto}table{border-collapse:collapse;min-width:1100px}th,td{border:1px solid var(--line);vertical-align:top;padding:8px;background:var(--card)}
thead th{position:sticky;top:0}tbody th{text-align:left;min-width:140px}th .muted{display:block;font-weight:400}
.post{min-width:190px}.post p{margin:4px 0}.hook{font-weight:600;color:var(--accent)}.tags{color:var(--muted);font-size:12px}
.muted{color:var(--muted);font-size:12px}.invalid{outline:2px solid var(--bad);outline-offset:2px}.why{color:var(--bad);font-size:12px}
.empty{color:var(--muted);text-align:center}.test{display:block;font-weight:400;font-size:12px;margin-top:6px;color:var(--fg)}
.arm{font-size:11px;padding:0 6px;border-radius:8px;border:1px solid var(--line)}.arm.variant{border-color:var(--accent);color:var(--accent)}details{font-size:12px}section{margin-top:24px}
</style></head><body><main><h1>Week plan ${esc(week)}</h1>
<p class="muted">${esc(days[0])} → ${esc(days[days.length - 1])} · model ${esc((models ?? []).join(", "))} · times are local (America/Los_Angeles)</p>
<div class="scroll"><table><thead><tr><th>Account</th>${days.map((d) => `<th>${esc(dayName(d))}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>
${brands}</main></body></html>`;
}
