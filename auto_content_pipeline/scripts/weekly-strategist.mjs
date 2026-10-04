// Weekly strategist: plans next Monday–Sunday for every enabled TikTok account.
// Fired by scripts/weekly-insights.mjs after the Saturday metrics run. Run from the
// repo root.
//
//   node auto_content_pipeline/scripts/weekly-strategist.mjs                   all enabled TikTok accounts
//   node auto_content_pipeline/scripts/weekly-strategist.mjs acme             one brand; the others keep their plans
//   node auto_content_pipeline/scripts/weekly-strategist.mjs acme-shop-tiktok  one account
//   node auto_content_pipeline/scripts/weekly-strategist.mjs --accept-styles   copy this week's style proposals into the profiles
//   --force   plan even when insights are older than 2 days
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { db, log } from "../../src/db.js";
import { loadRegistry } from "../../src/registry.js";
import { launch } from "../../src/browser.js";
import { notify } from "../../src/telegram.js";
import { nextWeek, isoWeekId } from "../src/schema.js";
import { loadBrief, latestSnapshots, recentHooks, recentPosts, experimentReadout, visualInventory } from "../src/brief.js";
import { researchBrand } from "../src/research.js";
import { groupAccounts, proposeStyles, acceptStyles } from "../src/styles.js";
import { planGroup, repairGroup, mergeRepairs, repairExperiments } from "../src/plan.js";
import { validateWeek, experimentProblems } from "../src/validate.js";
import { renderCalendar } from "../src/calendar.js";

if (existsSync("STOP_AUTOMATION")) { console.log("STOP_AUTOMATION present — nothing runs."); process.exit(0); }

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--")) ?? "all";
const week = nextWeek();
const dir = `auto_content_pipeline/output/weeks/${week.id}`;
mkdirSync(dir, { recursive: true });

if (args.includes("--accept-styles")) {
  console.log(`${acceptStyles(`${dir}/style-proposals.json`)} account style(s) written — now run: npm run registry`);
  process.exit(0);
}

const reg = loadRegistry();
const projects = new Map(reg.projects.map((p) => [p.id, p]));
const tiktok = reg.accounts.filter((a) => a.enabled && a.platform === "tiktok");
const accounts = tiktok.filter((a) => target === "all" || a.id === target || a.project === target);
if (!accounts.length) { console.error(`no enabled TikTok account matches "${target}"`); process.exit(1); }
const brands = [...new Set(accounts.map((a) => a.project))];
const models = new Set();
const fail = async (msg) => {
  console.error(msg);
  log(null, "strategist_failed", msg.slice(0, 300));
  await notify(`🗓️ Week plan ${week.id} stopped: ${msg}`);
  process.exit(1);
};

// Never plan on stale numbers: the Saturday metrics run must have landed.
const stale = accounts.filter((a) => {
  const s = latestSnapshots(a.id)[0];
  return !s || Date.now() - Date.parse(`${s.captured_at}Z`) > 2 * 86_400_000;
});
if (stale.length && !args.includes("--force")) {
  await fail(`no fresh insights for ${stale.map((a) => a.id).join(", ")}. Check logs/insights.log, then rerun: npm run strategist`);
}

const siblingsOf = (pid) => tiktok.filter((t) => t.project === pid).map((t) => t.id);
const briefs = Object.fromEntries(accounts.map((a) => [a.id, loadBrief(a, siblingsOf(a.project), week.id)]));
const hooks = recentHooks(tiktok.map((a) => a.id), { excludeWeek: week.id });
// Distinctiveness and experiments: what was posted lately, how last weeks' tests went, and
// which real screens and footage each brand has.
const tiktokIds = tiktok.map((a) => a.id);
const recent = recentPosts(tiktokIds, { excludeWeek: week.id });
const pastWeeks = existsSync("auto_content_pipeline/output/weeks")
  // Finished weeks only: the week still running has scheduled posts at 0 views.
  ? readdirSync("auto_content_pipeline/output/weeks").filter((w) => /^\d{4}-W\d{2}$/.test(w) && w < isoWeekId(new Date())).sort().slice(-2) : [];
const experiments = experimentReadout(tiktokIds, { weeks: pastWeeks });
const recordExperiment = (name, project, e, status = "active", result = null) => {
  if (!e?.hypothesis) return;
  const row = db.prepare("SELECT id FROM experiments WHERE name=?").get(name);
  if (row) db.prepare("UPDATE experiments SET hypothesis=?, control=?, variant=?, status=?, result=coalesce(?, result) WHERE id=?")
    .run(e.hypothesis, e.control ?? null, e.variant ?? null, status, result, row.id);
  else db.prepare("INSERT INTO experiments (name, hypothesis, control, variant, project, status, result) VALUES (?,?,?,?,?,?,?)")
    .run(name, e.hypothesis, e.control ?? null, e.variant ?? null, project, status, result);
};
// Close last weeks' tests that have a verdict, so the experiments table holds the record.
for (const e of experiments) {
  const done = /won|inconclusive/.test(e.verdict);
  recordExperiment(`${e.account} ${e.week}`, reg.accounts.find((a) => a.id === e.account)?.project ?? null,
    { hypothesis: e.hypothesis, control: e.control_desc, variant: e.variant_desc }, done ? "done" : "active",
    `control ${e.control.avg_views ?? "?"} avg views (n=${e.control.n}), variant ${e.variant.avg_views ?? "?"} (n=${e.variant.n}): ${e.verdict}`);
}

// 1. Research, once per brand, in a logged-out browser profile.
const research = {};
let researchError = null;
const browser = await launch({ profile: "research" });
try {
  const page = browser.pages()[0] ?? (await browser.newPage());
  for (const pid of brands) {
    const prev = db.prepare("SELECT raw FROM research WHERE project=? ORDER BY id DESC LIMIT 1").get(pid);
    const r = await researchBrand({ project: projects.get(pid), briefs: accounts.filter((a) => a.project === pid).map((a) => briefs[a.id]),
      previous: prev ? JSON.parse(prev.raw) : null, page });
    r.models.forEach((m) => models.add(m));
    db.prepare("INSERT INTO research (project, week, raw, summary) VALUES (?,?,?,?)").run(pid, week.id,
      JSON.stringify({ discovery: r.discovery, trends: r.trends, competitors: r.competitors, explore: r.explore, sounds: r.sounds, errors: r.errors }), JSON.stringify(r.summary));
    research[pid] = r;
  }
} catch (e) {
  researchError = e;
} finally {
  await browser.close().catch(() => {});
}
if (researchError) await fail(researchError.quota ? "Claude usage limit hit during research." : `research crashed: ${researchError.message}`);
// Merged with the file so a one-brand rerun keeps the other brands' research (the
// calendar shows every brand).
const researchFile = `${dir}/research.json`;
const allResearch = { ...(existsSync(researchFile) ? JSON.parse(readFileSync(researchFile, "utf8")) : {}), ...research };
writeFileSync(researchFile, JSON.stringify(allResearch, null, 2));

// 2. Styles: the profile's, or a proposal the user confirms with --accept-styles.
const styles = Object.fromEntries(accounts.filter((a) => a.style).map((a) => [a.id, a.style]));
const proposals = {};
for (const pid of brands) {
  const missing = accounts.filter((a) => a.project === pid && !a.style);
  if (!missing.length) continue;
  try {
    const r = proposeStyles({ project: projects.get(pid), accounts: missing, siblings: tiktok.filter((a) => a.project === pid && a.style), briefs });
    models.add(r.model);
    for (const a of missing) {
      if (r.styles[a.id]) { styles[a.id] = r.styles[a.id]; proposals[a.id] = { project: pid, style: r.styles[a.id] }; }
    }
  } catch (e) {
    if (e.quota) await fail("Claude usage limit hit while proposing styles.");
    console.log(`style proposal failed for ${pid}: ${e.message}`);
  }
}
// Merge: a one-brand rerun must not drop the other brands' pending proposals.
if (Object.keys(proposals).length) {
  const file = `${dir}/style-proposals.json`;
  const earlier = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  writeFileSync(file, JSON.stringify({ ...earlier, ...proposals }, null, 2));
}

// 3. Plan per group. Accounts outside this run keep their written plans and slots.
const readPlan = (id) => (existsSync(`${dir}/${id}.json`) ? JSON.parse(readFileSync(`${dir}/${id}.json`, "utf8")) : null);
const fixed = tiktok.filter((a) => !accounts.includes(a)).map((a) => readPlan(a.id)).filter(Boolean);
// Posts this rerun keeps: anything already past "planned", the post a creator is making right
// now, and posts waiting on a redo. They take part in validation (hooks, visuals, times).
const making = existsSync("CREATOR_RUNNING") ? readFileSync("CREATOR_RUNNING", "utf8").trim().split(" ")[1] : null;
const keptFor = (account) => db.prepare(`SELECT key, plan_json FROM week_plans WHERE account=? AND week=?
    AND (status NOT IN ('planned','invalid') OR key=? OR json_extract(plan_json,'$.feedback') IS NOT NULL)`)
  .all(account, week.id, making ?? "").map((r) => JSON.parse(r.plan_json));
const keptAll = accounts.flatMap((a) => keptFor(a.id));
if (keptAll.length) fixed.push({ posts: keptAll });
const busyFrom = (plans) => plans.flatMap((p) => p.posts).filter((p) => p.status !== "invalid")
  .map((p) => ({ day: p.day, post_at: p.post_at, key: p.key }));
const groups = groupAccounts(accounts, styles);
const inventory = Object.fromEntries(brands.map((pid) => [pid, visualInventory(pid)]));
const base = { projects, briefs, research, styles, days: week.days, recentHooks: hooks, week: week.id, recentPosts: recent, experiments, inventory };
const plans = [];
const failedGroups = [];
for (const [group, members] of groups) {
  try {
    const r = planGroup({ ...base, group, accounts: members, busy: busyFrom([...fixed, ...plans]) });
    models.add(r.model);
    plans.push(...r.plans);
  } catch (e) {
    failedGroups.push(`${group}: ${e.message.slice(0, 120)}`);
    if (e.quota) break;
  }
}
if (!plans.length) await fail(`no group could be planned — ${failedGroups.join("; ")}`);

// 4. Validate; one repair pass for every account-day without a valid post.
const vctx = { projects, recentHooks: hooks, recentVisuals: recent.map((r) => r.visual).filter(Boolean), days: week.days, fixed };
let checked = validateWeek(plans, vctx).plans;
for (const [group, members] of groups) {
  const gaps = validateWeek(checked, vctx).gaps.filter((g) => members.some((m) => m.id === g.account));
  if (!gaps.length) continue;
  try {
    const r = repairGroup({ ...base, group, accounts: members, busy: busyFrom([...fixed, ...checked]), plans: checked }, gaps);
    models.add(r.model);
    checked = mergeRepairs(checked, r.posts);
  } catch (e) {
    if (e.quota) break;
    console.log(`repair failed for ${group}: ${e.message}`);
  }
}
let final = validateWeek(checked, vctx);

// 4b. Experiments, always: one targeted pass for any account whose test is incomplete.
// An account with kept posts keeps this week's existing experiment (its arms are half-run).
for (const plan of final.plans) {
  if (keptFor(plan.account).length && readPlan(plan.account)?.experiment?.hypothesis) plan.experiment = readPlan(plan.account).experiment;
}
const hasKept = (p) => keptFor(p.account).length > 0;
const expProblems = Object.fromEntries(final.plans.filter((p) => !hasKept(p)).map((p) => [p.account, experimentProblems(p)]).filter(([, v]) => v.length));
if (Object.keys(expProblems).length) {
  try {
    const r = repairExperiments(base, final.plans.filter((p) => expProblems[p.account]), expProblems);
    models.add(r.model);
    const fixed2 = new Map(r.plans.map((p) => [p.account, p]));
    final = validateWeek(final.plans.map((p) => fixed2.get(p.account) ?? p), vctx);
  } catch (e) {
    console.log(`experiment repair failed: ${e.message}`);
  }
}
const noExperiment = final.plans.filter((p) => !hasKept(p) && experimentProblems(p).length).map((p) => `${p.account} (${experimentProblems(p).join("; ")})`);

// 5. Write — per account, all or nothing.
const insert = db.prepare(`INSERT OR REPLACE INTO week_plans (key, account, week, day, post_at, hook, status, plan_json)
                           VALUES (?,?,?,?,?,?,?,?)`);
const writeFailed = [];
for (const plan of final.plans) {
  // A rerun never replaces a post already in the creator/approval/queue flow: that day keeps it.
  const kept = keptFor(plan.account);
  if (kept.length) {
    plan.posts = [...plan.posts.filter((p) => !kept.some((k) => k.day === p.day)), ...kept]
      .sort((a, b) => String(a.day).localeCompare(String(b.day)));
  }
  plan.posts = plan.posts.map(({ repaired, ...p }) => p);
  // The database first, then the file: a failed transaction leaves both as they were.
  try {
    db.exec("BEGIN");
    db.prepare("DELETE FROM week_plans WHERE account=? AND week=?").run(plan.account, week.id);
    plan.posts.forEach((p, i) => insert.run(p.status === "invalid" ? `${p.key}-invalid-${i}` : p.key,
      plan.account, week.id, p.day ?? null, p.post_at ?? null, p.hook?.text ?? null, p.status, JSON.stringify(p)));
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    writeFailed.push(`${plan.account}: ${e.message.slice(0, 120)}`);
    continue;
  }
  const file = `${dir}/${plan.account}.json`;
  writeFileSync(`${file}.tmp`, JSON.stringify(plan, null, 2));
  renameSync(`${file}.tmp`, file);
  recordExperiment(`${plan.account} ${week.id}`, plan.project, plan.experiment);
}

// 6. Calendar + Telegram.
const all = tiktok.map((a) => readPlan(a.id)).filter(Boolean);
writeFileSync(`${dir}/calendar.html`, renderCalendar({ week: week.id, days: week.days, plans: all, research: allResearch, models: [...models] }));
const posts = final.plans.flatMap((p) => p.posts);
const valid = posts.filter((p) => p.status !== "invalid").length;
const lines = final.plans.map((p) => {
  const ok = p.posts.filter((x) => x.status !== "invalid");
  return `• ${p.account}: ${ok.length}/${week.days.length} — "${ok[0]?.hook?.text ?? "—"}"`;
});
const trendLines = Object.entries(research).flatMap(([pid, r]) => [
  ...(r.summary?.sounds ?? []).slice(0, 3).map((s) => `🎵 ${pid}: ${s.name}${s.business_safe === false ? " (not for business accounts)" : ""} — ${s.url ?? ""}`),
  ...(r.summary?.trends_to_leverage ?? []).slice(0, 3).map((t) => `📈 ${pid}: ${t.name} — ${t.how_to_use}${t.use_by ? ` (by ${t.use_by})` : ""}`),
]);
const notes = [
  ...final.plans.filter((p) => p.experiment?.hypothesis).map((p) => `🧪 ${p.account}: ${p.experiment.hypothesis}`),
  ...noExperiment.map((x) => `⚠️ experiment incomplete: ${x}`),
  ...writeFailed.map((x) => `❌ not saved: ${x}`),
  ...trendLines,
  ...Object.entries(research).filter(([, r]) => r.errors.length).map(([pid, r]) => `⚠️ ${pid} research: ${r.errors.join("; ")}`),
  ...failedGroups.map((g) => `❌ not planned: ${g}`),
  ...(Object.keys(proposals).length
    ? [`✋ Styles proposed for ${Object.keys(proposals).join(", ")} — review ${dir}/style-proposals.json, then: npm run strategist -- --accept-styles`]
    : []),
];
const text = [`🗓️ Week plan ${week.id} (${week.days[0]} → ${week.days[6]})`,
  `${valid}/${posts.length} posts valid · model ${[...models].join(", ")}`, "", ...lines, ...(notes.length ? ["", ...notes] : [])].join("\n");
console.log(text);
await notify(text, `${dir}/calendar.html`);
log(null, "strategist_week", `${week.id} accounts=${final.plans.length} valid=${valid}/${posts.length} models=${[...models].join("+")}`);
// exitCode, not exit(): forcing exit while fetch sockets close trips a libuv assertion on Windows.
process.exitCode = failedGroups.length ? 1 : 0;
