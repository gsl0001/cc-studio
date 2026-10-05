// Local dashboard — http://localhost:4820  (localhost only; no auth by design)
//
// It reads state AND drives the pipeline: every scheduled task (tick, agents,
// authcheck, plan, metrics) can be fired from the desk and watched live, so a
// human at 1am does not need a second terminal to answer "is it wedged?".
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync, mkdirSync, statSync, createReadStream } from "node:fs";
import { db, log, TERMINAL } from "./db.js";
import { lifecycle, note, readLog } from "./log.js";
import { ROOT, config, model, projectWorkspace, rootPath } from "./config.js";
import { loadRegistry } from "./registry.js";
import { decide, nextVideo, resolveHandoff } from "../scripts/posts.mjs";
import { creatorRunning, nextPost } from "../scripts/creator.mjs";
import { nextWeek, isoWeekId } from "../auto_content_pipeline/src/schema.js";

const PORT = Number(process.env.PORT) || 4820;
const STOP_FILE = "STOP_AUTOMATION";
const TEMPLATE = "agents/creator.md";

// ---------------------------------------------------------------- task runner
// One run at a time, on purpose: these tasks drive browsers, spend money and
// write the same SQLite rows. Two of them at once is the failure this repo
// exists to avoid, and a queue would just hide it.
const TASKS = {
  tick:      { label: "publish tick",   args: ["scripts/tick.mjs"] },
  agents:    { label: "content creator", args: ["scripts/creator.mjs"], account: "one" },
  authcheck: { label: "login check",    args: ["src/authcheck.js"], account: "all" },
  plan:      { label: "strategist",     args: ["src/strategist.js"], account: "one" },
  registry:  { label: "registry lint",  args: ["src/registry.js"] },
  metrics:   { label: "metrics sweep",  args: ["src/metrics.js", "sweep"] },
  export:    { label: "export perf",    args: ["src/export-performance.js"] },
};
const MAX_LINES = 600;
const runs = [];   // newest last; the live one is the only unfinished entry
let runSeq = 0;

const activeRun = () => runs.find((r) => !r.ended);

function startRun(task, account) {
  const spec = TASKS[task];
  if (!spec) throw new Error(`unknown task "${task}"`);
  if (activeRun()) throw new Error(`"${activeRun().task}" is still running`);
  if (account && !loadRegistry().accounts.some((a) => a.id === account) && account !== "all") {
    throw new Error(`unknown account "${account}"`);
  }
  const args = [...spec.args, ...(spec.account && account ? [account] : [])];
  const run = { id: ++runSeq, task, label: spec.label, account: account ?? null,
                started: new Date().toISOString(), ended: null, exit: null, lines: [] };
  const push = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) run.lines.push(line);
    if (run.lines.length > MAX_LINES) run.lines.splice(0, run.lines.length - MAX_LINES);
  };
  // shell:false so a timeout/kill reaches node itself, not a cmd.exe wrapper.
  const child = spawn(process.execPath, args, { shell: false, env: process.env });
  child.stdout.on("data", push);
  child.stderr.on("data", push);
  child.on("error", (e) => push(`spawn failed: ${e.message}`));
  child.on("close", (code) => {
    run.ended = new Date().toISOString();
    run.exit = code;
    log(null, "desk_run", `${task}${account ? ` ${account}` : ""} exit=${code}`);
  });
  // Measured on this box: killing this node also takes its grandchildren
  // (publish.js, the claude CLI) with it, so Cancel cannot orphan a publisher.
  run.kill = () => child.kill();
  runs.push(run);
  if (runs.length > 30) runs.shift();
  log(null, "desk_run_start", `${task}${account ? ` ${account}` : ""}`);
  return run;
}

const publicRun = (r, from = 0) => r && ({
  id: r.id, task: r.task, label: r.label, account: r.account, started: r.started,
  ended: r.ended, exit: r.exit, total: r.lines.length, from, lines: r.lines.slice(from),
});

// ---------------------------------------------------------------- read models
function agentState(accounts) {
  const rows = db.prepare(`SELECT detail, at FROM events WHERE event IN ('agent_run','agent_quota_exhausted')
                            ORDER BY id DESC LIMIT 200`).all();
  const history = rows.map((r) => ({
    at: r.at,
    account: (/account=(\S+)/.exec(r.detail) ?? [])[1] ?? null,
    model: (/model=(\S+)/.exec(r.detail) ?? [])[1] ?? null,
    rc: Number((/rc=(-?\d+)/.exec(r.detail) ?? [])[1] ?? NaN),
    quota: /QUOTA|quota/.test(r.detail),
    detail: r.detail,
  }));
  const byAccount = new Map();
  for (const h of history) if (h.account && !byAccount.has(h.account)) byAccount.set(h.account, h);

  const plannedToday = new Map(db.prepare(`SELECT account, count(*) n FROM plans
      WHERE date(created_at,'localtime')=date('now','localtime') GROUP BY account`).all()
    .map((r) => [r.account, r.n]));
  const queuedToday = new Map(db.prepare(`SELECT account, count(*) n FROM jobs
      WHERE date(created_at,'localtime')=date('now','localtime') GROUP BY account`).all()
    .map((r) => [r.account, r.n]));

  return {
    template: existsSync(TEMPLATE) ? readFileSync(TEMPLATE, "utf8") : "",
    model: model("plan"),
    quota_hit: history.slice(0, 8).some((h) => h.quota),
    history: history.slice(0, 40),
    accounts: accounts.map((a) => {
      const last = byAccount.get(a.id) ?? null;
      return {
        ...a,
        agent_last: last,
        // Same gate creator.mjs applies, spelled out so the desk shows WHY
        // an account got no run instead of just showing nothing.
        agent_blocked: !a.enabled ? "disabled"
          : a.config_error ? "config errors"
          : a.paused ? "paused"
          : a.ok === 0 ? "login dead"
          : null,
        planned_today: plannedToday.get(a.id) ?? 0,
        queued_today: queuedToday.get(a.id) ?? 0,
      };
    }),
  };
}

function state() {
  const reg = loadRegistry();
  const jobs = db.prepare("SELECT * FROM jobs ORDER BY updated_at DESC LIMIT 120").all();
  const plans = db.prepare("SELECT key, app, account, angle, hook, caption, slot, created_at FROM plans ORDER BY created_at DESC LIMIT 60").all();
  const metrics = db.prepare(`
    SELECT m.job_key, m.account, max(m.views) views, max(m.likes) likes, max(m.comments) comments, max(m.shares) shares
    FROM metrics m GROUP BY m.job_key ORDER BY max(m.captured_at) DESC LIMIT 60
  `).all();
  const experiments = db.prepare("SELECT * FROM experiments ORDER BY id DESC LIMIT 10").all();
  // The content library. Thumbnails are served by /thumb, never inlined — 100
  // base64 jpegs would make /api/state the heaviest thing on the desk.
  const library = db.prepare(`
    SELECT c.sha, c.duration, c.width, c.height, c.bytes, c.first_seen,
           c.thumb IS NOT NULL AS has_thumb,
           count(j.key) used, group_concat(DISTINCT j.account) accounts, max(j.updated_at) last_used
    FROM content c LEFT JOIN jobs j ON j.content_sha = c.sha
    -- Most recently used first; the whole archive was catalogued in one import,
    -- so first_seen only breaks ties between videos nothing has ever carried.
    GROUP BY c.sha ORDER BY max(j.created_at) IS NULL DESC, max(j.created_at) DESC, c.first_seen DESC
    LIMIT 200
  `).all();
  const events = db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT 120").all();
  const queue = existsSync("queue")
    ? readdirSync("queue", { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name)
    : [];

  // Counters over the WHOLE table — the old LIMIT-50 array hid 12 MANUAL_REVIEW
  // and 3 UNKNOWN jobs from the only screen that can resolve them.
  const counts = {};
  for (const r of db.prepare("SELECT status, count(*) c FROM jobs GROUP BY status").all()) counts[r.status] = r.c;
  const byAccountStatus = db.prepare("SELECT account, status, count(*) c FROM jobs GROUP BY account, status").all();
  const healthRows = new Map(db.prepare("SELECT * FROM account_health").all().map((r) => [r.account, r]));

  const today = new Date().toLocaleDateString("sv");
  const accounts = reg.accounts.map((a) => {
    const mine = byAccountStatus.filter((r) => r.account === a.id);
    const open = mine.filter((r) => !["SCHEDULED", "PUBLISHED"].includes(r.status)).reduce((n, r) => n + r.c, 0);
    const postedToday = db.prepare(`SELECT count(*) n FROM jobs WHERE account=? AND status IN ('SCHEDULED','PUBLISHED')
                                     AND date(updated_at,'localtime')=date('now','localtime')`).get(a.id).n;
    const depth = db.prepare(`SELECT count(*) n FROM jobs WHERE account=? AND status NOT IN (${TERMINAL.map(() => "?").join(",")})`)
      .get(a.id, ...TERMINAL).n;
    const h = healthRows.get(a.id) ?? {};
    const days = [0, 1, 2, 3, 4].map((offset) => {
      const d = new Date(Date.now() + offset * 86_400_000).toLocaleDateString("sv");
      const rows = jobs.filter((j) => j.account === a.id &&
        ((j.scheduled_for ?? "").startsWith(d) || j.key.includes(d)));
      const scheduled = rows.filter((j) => ["SCHEDULED", "PUBLISHED"].includes(j.status));
      const attention = rows.filter((j) => ["MANUAL_REVIEW", "UNKNOWN"].includes(j.status));
      const planned = rows.filter((j) => !["SCHEDULED", "PUBLISHED", "MANUAL_REVIEW", "UNKNOWN"].includes(j.status));
      return { date: d, offset, scheduled: scheduled.length, attention: attention.length, planned: planned.length,
               state: attention.length ? "attention" : scheduled.length ? "scheduled" : planned.length ? "queued" : "empty",
               job: (attention[0] ?? scheduled[0] ?? planned[0])?.key ?? null };
    });
    return {
      id: a.id, project: a.project, platform: a.platform, handle: a.handle,
      profile: a.browser_profile, profile_exists: existsSync(`browser-profile/${a.browser_profile}`),
      slots: a.slots, enabled: a.enabled, can_schedule: a.can_schedule,
      mode: a.mode, allow_final: a.allow_final, lead_days: a.lead_days,
      auto: a.mode === "SCHEDULE" && a.allow_final,
      config_error: reg.errors.some((e) => e.startsWith(`${a.id}:`)),
      ok: h.ok ?? null, paused: !!h.paused, note: h.note ?? null, checked_at: h.checked_at ?? null,
      posted_today: postedToday, cap: a.slots.length,
      queue_depth: depth, queue_days: (depth / a.slots.length).toFixed(1),
      open, days,
    };
  });

  const health = {
    stop_file: existsSync(STOP_FILE),
    queue_depth: db.prepare(`SELECT count(*) n FROM jobs WHERE status NOT IN (${TERMINAL.map(() => "?").join(",")})`).get(...TERMINAL).n,
    unknown_jobs: counts.UNKNOWN ?? 0,
    manual_review: counts.MANUAL_REVIEW ?? 0,
    failed: counts.FAILED ?? 0,
    unregistered: db.prepare("SELECT count(*) n FROM jobs WHERE account IS NULL").get().n,
    orphan_queue: queue.filter((k) => !jobs.some((j) => j.key === k)).length,
    config_errors: reg.errors,
    config_warnings: reg.warnings,
    last_event: events[0]?.at ?? null,
    today,
  };

  return {
    jobs, plans, metrics, experiments, events, queue, accounts, counts, health, library,
    projects: reg.projects.map((p) => ({ id: p.id, name: p.name, category: p.category,
                                         language_note: p.language_note, render: p.render ?? null,
                                         accounts: reg.accounts.filter((a) => a.project === p.id).length })),
    agents: agentState(accounts),
    run: publicRun(activeRun() ?? runs[runs.length - 1]),
    runs: runs.map((r) => ({ id: r.id, task: r.task, label: r.label, account: r.account,
                             started: r.started, ended: r.ended, exit: r.exit })).reverse(),
  };
}

// ---------------------------------------------------------------------- widget
// The desk widget (dashboard/widget.html): the pipeline at a glance and its controls.
const SCHED = ["cc-studio bot", "cc-studio pulse", "cc-studio tick", "cc-studio insights"];
let taskCache = { at: 0, tasks: [] };
function scheduledTasks() {
  if (Date.now() - taskCache.at < 60_000) return taskCache.tasks;
  const tasks = SCHED.map((name) => {
    const r = spawnSync("schtasks", ["/query", "/tn", name, "/fo", "csv", "/v"], { encoding: "utf8", windowsHide: true });
    const [head, row] = (r.stdout ?? "").trim().split(/\r?\n/).map((l) => l.slice(1, -1).split('","'));
    const get = (col) => row?.[head?.indexOf(col)] ?? null;
    return { name: name.replace("cc-studio ", ""), status: get("Status"), next: get("Next Run Time"), last: get("Last Run Time"), result: get("Last Result") };
  });
  taskCache = { at: Date.now(), tasks };
  return tasks;
}

const ageS = (f) => (existsSync(f) ? Math.round((Date.now() - statSync(f).mtimeMs) / 1000) : null);
function widgetState() {
  const today = new Date().toLocaleDateString("sv");
  const weeks = [isoWeekId(new Date()), nextWeek().id];
  const posts = db.prepare(`SELECT key, account, week, day, post_at, status, plan_json FROM week_plans
                            WHERE week IN (?, ?) ORDER BY day, post_at`).all(...weeks)
    .map((r) => ({ ...r, plan: JSON.parse(r.plan_json), plan_json: undefined }));
  // A rendered video is reviewable once the creator has checked it and sent it (reminded_at);
  // before that it may still go back for a similarity remake.
  const reviewable = (p) => p.status === "rendered" && !!p.plan.reminded_at;
  const counts = Object.fromEntries(["planned", "rendered", "blocked", "approved", "queued", "posted", "rejected"]
    .map((s) => [s, posts.filter((p) => (s === "rendered" ? reviewable(p) : p.status === s)).length]));
  const job = (key) => (key ? db.prepare("SELECT status, scheduled_for, attempts, error FROM jobs WHERE key=?").get(key) : null);
  const reg = loadRegistry();
  const health = new Map(db.prepare("SELECT account, ok, paused FROM account_health").all().map((r) => [r.account, r]));
  return {
    now: new Date().toISOString(),
    paused: existsSync(STOP_FILE),
    bot_heartbeat_s: ageS("logs/.bot-heartbeat"),
    creator: creatorRunning(),
    creator_since_s: ageS("CREATOR_RUNNING"),
    quota_pause: (ageS("CLAUDE_QUOTA") ?? Infinity) < 7200,
    counts,
    review: posts.filter(reviewable).map((p) => ({ key: p.key, account: p.account, day: p.day, post_at: p.post_at,
      hook: p.plan.hook?.text, note: p.plan.note, cut: p.plan.cut ?? 1, is_aigc: !!p.plan.is_aigc, has_video: !!p.plan.video && existsSync(p.plan.video) })),
    blocked: posts.filter((p) => p.status === "blocked").map((p) => ({ key: p.key, note: p.plan.note })),
    upcoming: posts.filter((p) => ["approved", "queued", "posted"].includes(p.status) && p.day >= today).map((p) => {
      const j = job(p.plan.queue_key);
      return { key: p.key, account: p.account, day: p.day, post_at: p.post_at, status: p.status, slot: j?.scheduled_for ?? null, job: j?.status ?? null };
    }),
    attention: db.prepare(`SELECT key, status, attempts, substr(replace(coalesce(error,''), char(10), ' '), 1, 140) error FROM jobs
                           WHERE status IN ('MANUAL_REVIEW','UNKNOWN') OR (status='FAILED' AND attempts >= 3) ORDER BY updated_at DESC`).all(),
    // FAILED with attempts left: the tick retries these on its own, so they are news, not alarms.
    retrying: db.prepare("SELECT key, attempts FROM jobs WHERE status='FAILED' AND attempts < 3").all(),
    folders: FOLDERS.map(({ key, label }) => ({ key, label })),
    // For cc: account names for post keys, and how to say words the voice gets wrong (profiles' "pronounce").
    names: accountNames(), pronounce: Object.assign({}, ...reg.projects.map((p) => p.pronounce ?? {})),
    accounts: reg.accounts.filter((a) => a.enabled).map((a) => ({ id: a.id, name: accountName(a.id), login_ok: health.get(a.id)?.ok !== 0, paused: !!health.get(a.id)?.paused })),
    tasks: scheduledTasks(),
    events: db.prepare(`SELECT at, job_key, event, substr(coalesce(detail,''), 1, 120) detail FROM events
                        WHERE event NOT IN ('week_post') ORDER BY id DESC LIMIT 12`).all(),
    calendar: existsSync(`auto_content_pipeline/output/weeks/${weeks[1]}/calendar.html`) ? weeks[1] : weeks[0],
  };
}

const runTask = (name) => spawnSync("schtasks", ["/run", "/tn", name], { encoding: "utf8", windowsHide: true });
// "5pm", "5 pm", "5:30pm", "17:00", "5" (afternoon is assumed for 1-7 without am/pm) -> "HH:MM".
function clockTime(s) {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(String(s).trim().replace(/\.$/, ""));
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2] ?? 0), ap = m[3]?.[0];
  if (min > 59 || h > 23 || (ap && (h < 1 || h > 12))) return null;
  if (ap === "p" && h < 12) h += 12;
  if (ap === "a" && h === 12) h = 0;
  if (!ap && !m[2] && h >= 1 && h <= 7) h += 12;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}
const nice12 = (t) => { const [h, m] = t.split(":").map(Number); return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`; };

// One daily posting time for every account (or one): written to each profile as post_time (the
// strategist uses it instead of picking) and slots, then the week posts and videos not uploaded
// yet move to it. Posts already scheduled on the platform are in its hands and keep their time.
// "auto" removes post_time so the strategist picks from the numbers again.
function setPostTime(time, only) {
  if (time !== "auto" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time ?? "")) return { error: "say a time like 5pm or 17:00" };
  if (only && !accountIds().includes(only)) return { error: `no account called ${only}` };
  const ids = [];
  for (const d of readdirSync("apps", { withFileTypes: true }).filter((x) => x.isDirectory() && x.name !== "example" && existsSync(`apps/${x.name}/profile.json`))) {
    const file = `apps/${d.name}/profile.json`, p = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    let changed = false;
    for (const a of p.accounts ?? []) {
      if (only && a.id !== only) continue;
      if (time === "auto") delete a.post_time; else { a.post_time = time; a.slots = [time]; }
      ids.push(a.id); changed = true;
    }
    if (changed) writeFileSync(file, JSON.stringify(p, null, 2) + "\n");
  }
  if (time === "auto") {
    log(null, "post_time", `auto for ${only ?? "every account"} (desk)`);
    return { ok: true, message: `The strategist picks the times for ${only ? accountName(only) : "every account"} again from next week's plan.` };
  }
  const soon = Date.now() + 30 * 60_000, moved = [];
  const repost = (key) => {   // the week post and its plan file follow
    const row = db.prepare("SELECT plan_json FROM week_plans WHERE key=?").get(key);
    if (row) { const pj = JSON.parse(row.plan_json); pj.post_at = time; db.prepare("UPDATE week_plans SET post_at=?, plan_json=? WHERE key=?").run(time, JSON.stringify(pj), key); }
  };
  for (const j of db.prepare("SELECT key, account, scheduled_for FROM jobs WHERE status IN ('PLANNED','FAILED') AND scheduled_for IS NOT NULL").all()) {
    if (!ids.includes(j.account)) continue;
    const at = `${j.scheduled_for.slice(0, 10)}T${time}`;
    if (at === j.scheduled_for || new Date(at).getTime() < soon) continue;
    db.prepare("UPDATE jobs SET scheduled_for=? WHERE key=?").run(at, j.key);
    const sf = join("queue", j.key, "schedule.json");
    if (existsSync(sf)) writeFileSync(sf, JSON.stringify({ scheduled_for: at }) + "\n");
    const pf = `plans/${j.key}.json`;
    if (existsSync(pf)) { const pj = JSON.parse(readFileSync(pf, "utf8").replace(/^\uFEFF/, "")); repost(pj.week_post ?? j.key); pj.post_at = time; writeFileSync(pf, JSON.stringify(pj, null, 2)); }
    moved.push(j.key);
  }
  for (const r of db.prepare("SELECT key, account FROM week_plans WHERE status IN ('planned','rendered','approved','blocked')").all()) {
    if (ids.includes(r.account)) repost(r.key);
  }
  const scheduled = db.prepare(`SELECT count(*) n FROM jobs WHERE status='SCHEDULED' AND scheduled_for > ? AND account IN (${ids.map(() => "?").join(",")})`)
    .get(new Date().toISOString().slice(0, 16), ...ids).n;
  log(null, "post_time", `${time} for ${only ?? "every account"}; moved ${moved.length} not-yet-uploaded videos (desk)`);
  return { ok: true, message: `Done: ${only ? accountName(only) : "every account"} posts at ${nice12(time)} from now on. I moved ${moved.length} video${moved.length === 1 ? "" : "s"} not uploaded yet.${scheduled ? ` ${scheduled} already scheduled on TikTok keep their old time.` : ""}` };
}

function widgetAct(a) {
  const r = doAct(a);
  note(r.error ? "warn" : "info", `action ${a.action}${a.key ? ` ${a.key}` : ""}: ${r.message ?? r.error ?? "done"}`.slice(0, 400), a.key ? { key: a.key } : {});
  return r;
}
function doAct({ action, key, cut, feedback, time }) {
  if (["approve", "skip", "redo"].includes(action)) {
    if (action === "redo" && !String(feedback ?? "").trim()) return { error: "say what to change" };
    const message = decide(key, action, String(feedback ?? ""), cut ?? null, "the desk");
    if (!existsSync(STOP_FILE)) nextVideo();
    return { ok: true, message };
  }
  if (action === "next") {
    if (key && !accountIds().includes(key)) return { error: `no account called ${key}` };
    const why = whyNoVideo(key);
    if (why) return { error: why };
    nextVideo(key || null);
    return { ok: true, message: `Starting ${niceKey(nextPost(key || undefined).key)}.` };
  }
  if (action === "pause_account" || action === "resume_account") {
    if (!accountIds().includes(key)) return { error: `no account called ${key}` };
    const paused = action === "pause_account" ? 1 : 0;
    db.prepare(`INSERT INTO account_health (account, paused) VALUES (?,?)
                ON CONFLICT(account) DO UPDATE SET paused=excluded.paused`).run(key, paused);
    log(null, "account_paused", `${key} paused=${paused} (desk)`);
    return { ok: true, message: paused ? `${accountName(key)} is paused: no new videos or uploads for it until you resume it.` : `${accountName(key)} is back on.` };
  }
  if (action === "post_time") return setPostTime(time ?? null, key ?? null);
  if (action === "check") {
    // The pulse runs the login check with its locks (never during an upload); forget today's.
    rmSync("logs/.authcheck-day", { force: true });
    const r = runTask("cc-studio pulse");
    return r.status === 0 ? { ok: true, message: "Checking every account's login now. Problems will show here and in Telegram." } : { error: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
  }
  if (action === "posted" || action === "retry") return { ok: true, message: resolveHandoff(key, action) };
  if (action === "pause") { writeFileSync(STOP_FILE, `paused from the desk widget ${new Date().toISOString()}\n`); log(null, "kill_switch", "engaged (widget)"); return { ok: true }; }
  if (action === "resume") { rmSync(STOP_FILE, { force: true }); log(null, "kill_switch", "cleared (widget)"); nextVideo(); return { ok: true }; }
  const tasks = { pulse: "cc-studio pulse", tick: "cc-studio tick", bot: "cc-studio bot" };
  if (tasks[action]) {
    const r = runTask(tasks[action]);
    taskCache.at = 0;
    const said = { pulse: "Running a pulse check now.", tick: "Uploading the next queued video now.", bot: "Restarting the Telegram bot. It's back in a few seconds." };
    return r.status === 0 ? { ok: true, message: said[action] } : { error: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
  }
  // Only the fixed FOLDERS list; nothing from the request reaches the command line.
  if (action === "open") {
    const f = FOLDERS.find((x) => x.key === key);
    if (!f) return { error: `no folder called ${key}` };
    const target = f.url ? `http://localhost:${PORT}${f.url}` : f.find ? f.find() : resolve(f.path);
    if (!target) return { error: f.key === "waiting" ? "No video is waiting for you." : `Nothing to open for ${f.label} yet.` };
    if (!f.url && !existsSync(target.replace(/^\/select,/, ""))) return { error: `${f.label} isn't there: ${target}` };
    spawn("explorer", [target], { detached: true, windowsHide: true }).unref();
    return { ok: true, message: `Opening ${f.label}.` };
  }
  return { error: `unknown action ${action}` };
}

// The desk chat: plain commands run at once; anything else goes to Claude with the live
// state and streams back (cc shows the words as they come and speaks them sentence by
// sentence). Whatever Claude suggests doing comes back as a button, never a silent action.
const chatLog = [];   // last few turns, so follow-ups ("and the other one?") have context
const ACTIONS = ["approve", "skip", "redo", "next", "pause", "resume", "pause_account", "resume_account", "check", "pulse", "tick", "bot", "open", "retry", "posted", "post_time"];

// Quick access: every folder the pipeline uses, by the names people say ("open <brand> workspace"),
// built from studio.config.json and the projects. `find` opens a file selected in its folder
// (the video waiting for you, the newest report).
const FOLDERS = [
  { key: "finals", label: "Finals", path: rootPath(config.paths.finals), also: ["videos", "finals folder", "pipeline finals"] },
  { key: "waiting", label: "Waiting video", also: ["the video", "video", "waiting", "the waiting video"], find: () => {
    const v = db.prepare("SELECT json_extract(plan_json,'$.video') v FROM week_plans WHERE status='rendered' ORDER BY day, post_at").get()?.v;
    return v && existsSync(v) ? `/select,${resolve(v)}` : null; } },
  ...loadRegistry().projects.flatMap((p) => [
    { key: `finals-${p.id}`, label: `${p.name ?? p.id} finals`, path: join(rootPath(config.paths.finals), p.id), also: [`${p.id} finals`] },
    { key: `work-${p.id}`, label: `${p.name ?? p.id} workspace`, path: projectWorkspace(p), also: [`${p.id} workspace`, `${(p.name ?? p.id).toLowerCase()} work`, (p.name ?? p.id).toLowerCase()] },
  ]),
  ...(config.paths.handPost ? [{ key: "hand", label: "Hand-post folder", path: rootPath(config.paths.handPost), also: ["hand finals", "hand post"] }] : []),
  { key: "weeks", label: "Week plans", path: "auto_content_pipeline/output/weeks", also: ["plans", "weeks", "week plans", "plan folder"] },
  { key: "calendar", label: "Calendar", url: "/calendar", also: ["the calendar", "week calendar"] },
  { key: "report", label: "Latest report", also: ["report", "insights", "insights report", "the report"], find: () => {
    const f = existsSync("reports") ? readdirSync("reports").filter((n) => n.endsWith(".html")).sort().at(-1) : null;
    return f ? `/select,${resolve("reports", f)}` : null; } },
  { key: "reports", label: "All reports", path: "reports" },
  { key: "content", label: "Guidelines", path: dirname(rootPath(config.paths.guidelines)), also: ["content", "context", "guidelines folder"] },
  { key: "logs", label: "Logs", path: "logs", also: ["log folder"] },
  { key: "studio", label: "cc-studio", path: ROOT, also: ["project", "the project", "cc studio", "studio"] },
  { key: "dashboard", label: "Dashboard", url: "/", also: ["the dashboard"] },
];
const folderFrom = (words) => FOLDERS.find((f) => f.key === words || f.label.toLowerCase() === words || f.also?.includes(words))?.key ?? null;

// Accounts by the names people use ("pause <name>", "next <name>"): an account's "name" in its
// profile, else the project's name when it has one account, else the project's name and handle.
function accountNames() {
  const reg = loadRegistry(), names = {};
  for (const a of reg.accounts) {
    const p = reg.projects.find((x) => x.id === a.project), pn = p?.name ?? a.project;
    names[a.id] = a.name ?? (p?.accounts?.length > 1 ? `${pn} ${a.handle ?? a.platform}` : pn);
  }
  return names;
}
const accountName = (id) => accountNames()[id] ?? id;
const accountIds = () => loadRegistry().accounts.filter((a) => a.enabled).map((a) => a.id);
const accountFrom = (words) => accountIds().find((id) => id === words || accountName(id).toLowerCase() === words) ?? null;

// Why the creator won't start a video right now, in words; null when it will.
function whyNoVideo(account = null) {
  if (existsSync(STOP_FILE)) return "Everything is paused. Say resume first.";
  const busy = creatorRunning();
  if (busy) return `I'm already making ${niceKey(busy)}. One video at a time.`;
  const waiting = db.prepare("SELECT key FROM week_plans WHERE status='rendered'").get();
  if (waiting) return `${niceKey(waiting.key)} is waiting for your answer first.`;
  if (!nextPost(account || undefined)) return account ? `${accountName(account)} has nothing planned to make in the next week.` : "Nothing planned is due in the next week.";
  return null;
}
const hm = (t) => { const [h, m] = String(t ?? "").split(":").map(Number); return Number.isNaN(h) ? "" : `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`; };
const chats = new Map();   // id -> { text, done, suggest, chips }
let chatSeq = 0;

// "mybrand-tiktok-2026-10-06-001" -> "My Brand's Tue, Oct 6 post": what people (and the voice) say.
const niceKey = (k) => {
  const m = /^(.+)-(\d{4})-(\d{2})-(\d{2})-\d{3}$/.exec(k ?? "");
  if (!m) return k;
  const d = new Date(+m[2], +m[3] - 1, +m[4]).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return `${accountName(m[1])}'s ${d} post`;
};

function summary(st) {
  const c = st.counts;
  const bits = [st.paused ? "Paused" : "Running",
    st.bot_heartbeat_s != null && st.bot_heartbeat_s < 300 ? "the Telegram bot is fine" : "the Telegram bot is DOWN",
    st.creator ? `making ${niceKey(st.creator)}` : st.quota_pause ? "the creator is waiting out a Claude limit" : "the creator is idle"];
  return `${bits.join(", ")}.\n${c.rendered} waiting for you, ${c.blocked} blocked, ${c.planned} planned, ${c.approved + c.queued} queued, ${c.posted} posted.`;
}

// The same, written to be heard: what matters first, numbers only where they mean something.
const plural = (n, one, many = `${one}s`) => `${n === 0 ? "no" : n === 1 ? "one" : n} ${n === 1 ? one : many}`;
function spokenSummary(st) {
  const c = st.counts, says = [];
  says.push(st.paused ? "I'm paused." : "Everything's running.");
  if (!(st.bot_heartbeat_s != null && st.bot_heartbeat_s < 300)) says.push("The Telegram bot is down, so approvals can't reach me.");
  if (st.creator) says.push(`I'm making ${niceKey(st.creator)}.`);
  else if (st.quota_pause) says.push("I'm waiting for the Claude limit to reset before the next video.");
  says.push(c.rendered ? `${plural(c.rendered, "video is", "videos are")} waiting for you.` : "Nothing is waiting for you.");
  if (c.blocked) says.push(`${plural(c.blocked, "post is", "posts are")} blocked.`);
  says.push(`${plural(c.approved + c.queued, "post is", "posts are")} queued${c.posted ? `, and ${c.posted} posted so far` : ""}.`);
  return says.map((x) => x[0].toUpperCase() + x.slice(1)).join(" ");
}
function spokenProblems() {
  const p = readLog({ lvl: "warn", n: 50, sinceMs: 24 * 3_600_000 });
  if (!p.length) return "No warnings or errors in the last day. All clear.";
  const last = p.at(-1), errors = p.filter((e) => e.lvl === "error").length;
  const at = new Date(last.t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `I found ${plural(p.length, "problem")} in the last day${errors ? `, ${errors} of them errors` : ""}. `
    + `The latest was at ${at}, from ${last.src === "cc" ? "me" : `the ${last.src.replace("-", " ")}`}: ${last.msg.split("\n")[0].slice(0, 160)}. The full list is in the chat.`;
}

function quick(text, st) {
  const t = text.trim(), w = t.toLowerCase().replace(/[.!?]+$/, "");
  const only = st.review.length === 1 ? st.review[0] : null;
  if (/^(status|\?|hi|hey|hello)$/.test(w)) return { reply: summary(st), speech: spokenSummary(st), chips: ["What's posting next?", "Anything broken?"] };
  if (/^(errors?|logs?|problems?)$/.test(w)) {
    const p = problems(10);
    return { reply: p.length ? `Problems in the last 24 hours:\n${p.map((x) => `- ${x}`).join("\n")}` : "No warnings or errors in the last 24 hours.",
      speech: spokenProblems(), chips: ["Why did the last one happen?", "Is everything running?"] };
  }
  // Only the plain verbs act at once; "ok", "go" and the like are too easy to say by accident
  // (or for the Mic to hear) and go to Claude, which can only suggest.
  if (w === "pause") return { reply: "Paused. Nothing renders or publishes until you say resume. Approvals still queue.", run: { action: "pause" } };
  if (w === "resume") return { reply: "Resumed.", run: { action: "resume" } };
  if (/^(make )?(the )?next( video)?$/.test(w)) return { reply: "", run: { action: "next" } };
  if (/^(help|commands|controls|menu|options|what can (you|i) do)$/.test(w)) return { reply: HELP, controls: true,
    speech: "Here's what I can do. Tap a control, or just ask me in your own words." };
  if (/^(queue|upcoming|what'?s next|what'?s posting next|next posts?|what'?s coming up)$/.test(w)) {
    const next = st.upcoming.filter((u) => u.status !== "posted").slice(0, 6);
    if (!next.length) return { reply: "Nothing is queued to post yet.", chips: ["What's waiting for me?"] };
    const line = (u) => `${niceKey(u.key)} at ${hm(u.post_at)}${u.job === "SCHEDULED" ? ", scheduled on TikTok" : ""}`;
    return { reply: `Coming up:\n${next.map((u) => `- ${line(u)}`).join("\n")}`,
      speech: `Next up is ${line(next[0])}.${next.length > 1 ? ` Then ${next.length - 1} more; they're in the chat.` : ""}`, chips: ["This week", "Any issues?"] };
  }
  if (/^(week|this week|plan|week plan|the plan)$/.test(w)) {
    const c = st.counts, nx = st.creator ? null : nextPost();
    const making = st.creator ? `Making now: ${niceKey(st.creator)}.` : nx ? `Next to make: ${niceKey(nx.key)}.` : "";
    const reply = `This week and next: ${c.planned} planned, ${c.rendered} waiting for you, ${c.approved + c.queued} queued, ${c.posted} posted, ${c.blocked} blocked, ${c.rejected} skipped.`
      + (making ? `\n${making}` : "");
    return { reply, speech: `${c.planned} posts are planned and ${c.approved + c.queued} are queued.${st.creator ? ` I'm making ${niceKey(st.creator)} now.` : nx ? ` The next one I'll make is ${niceKey(nx.key)}.` : ""}`,
      chips: ["What's next?", "Open the calendar"] };
  }
  // "post at 5pm", "change posting times to 17:00 for <account>", "posting time auto": a button to confirm.
  const pt = /^(?:(?:change|set|move|make)\s+)?(?:the\s+|my\s+|all\s+)?(?:posting|post|upload)\s*times?\s+(?:to\s+|at\s+)?(.+?)(?:\s+(?:every\s*day|daily))?(?:\s+for\s+(.+))?$|^post(?:\s+everything)?\s+at\s+(.+?)(?:\s+(?:every\s*day|daily))?(?:\s+for\s+(.+))?$/.exec(w);
  if (pt) {
    const when = pt[1] ?? pt[3], who = pt[2] ?? pt[4];
    const time = /^(auto|automatic|best|default|off)$/.test(when) ? "auto" : clockTime(when);
    const id = who ? accountFrom(who) : null;
    if (who && !id) return { reply: `I don't know an account called "${who}". Try ${accountIds().map(accountName).join(", ")}.` };
    if (!time) return { reply: `I didn't catch the time in "${when}". Try "post at 5pm" or "post at 17:30".` };
    const whom = id ? accountName(id) : "every account";
    return { reply: time === "auto"
      ? `Let the strategist pick the posting times for ${whom} again, from each account's numbers?`
      : `Post ${whom} at ${nice12(time)} every day? Videos not uploaded yet move to ${nice12(time)}; ones already scheduled on TikTok keep their time.`,
      suggest: { action: "post_time", time, key: id ?? undefined, label: time === "auto" ? "Yes, pick automatically" : `Yes, ${nice12(time)}` } };
  }
  const acct = /^(pause|resume|next|make)\s+(?:a |the )?(?:next )?(?:video )?(?:for )?(.+)$/.exec(w);
  if (acct) {
    const toggle = acct[1] === "pause" || acct[1] === "resume";
    if (toggle && /^(everything|all|it all|all accounts)$/.test(acct[2])) return quick(acct[1], st);
    const id = accountFrom(acct[2]);
    // "next week?" is a question, not an account: only pause/resume insist on a name.
    if (!id) return toggle ? { reply: `I don't know an account called "${acct[2]}". Try ${accountIds().map(accountName).join(", ")}.` } : null;
    return { reply: "", run: { action: acct[1] === "pause" ? "pause_account" : acct[1] === "resume" ? "resume_account" : "next", key: id } };
  }
  if (/^(publish|upload|post)( now)?$/.test(w)) return { reply: "", run: { action: "tick" } };
  if (/^(check )?(the )?logins?( check)?$|^check accounts$/.test(w)) return { reply: "", run: { action: "check" } };
  if (/^(run )?(a )?pulse( check)?$/.test(w)) return { reply: "", run: { action: "pulse" } };
  if (/^restart (the )?(telegram )?bot$/.test(w)) return { reply: "", run: { action: "bot" } };
  if (/^(folders|open( a)? folder|quick access|show( me)? (the )?folders)$/.test(w)) return {
    reply: `Folders I can open:\n${FOLDERS.map((f) => `- ${f.label}`).join("\n")}\nSay "open" and the name, or tap one.`,
    speech: "Here are the folders I can open. Tap one, or say open and its name.", folders: true };
  const open = /^(?:open|show|go to)(?: the| my)? (.+?)(?: folder)?$/.exec(w);
  if (open && folderFrom(open[1])) return { reply: "", run: { action: "open", key: folderFrom(open[1]) } };
  if (w === "approve" || w === "skip") {
    if (!only) return { reply: st.review.length ? "More than one video is waiting. Use the buttons on the one you mean." : "Nothing is waiting for review." };
    return { reply: "", run: { action: w === "skip" ? "skip" : "approve", key: only.key, cut: only.cut } };
  }
  // "change"/"fix" mean Redo only while a video is waiting; otherwise ("change posting times
  // to 5pm") they're a request for Claude, not a redo with nothing to redo.
  const redo = /^(redo|change|fix)\s*[:,-]?\s*(.+)$/i.exec(t);
  if (redo && (redo[1].toLowerCase() === "redo" || st.review.length)) {
    if (!only) return { reply: st.review.length ? "More than one video is waiting. Use Redo on the one you mean." : "Nothing is waiting for review." };
    return { reply: "", run: { action: "redo", key: only.key, cut: only.cut, feedback: redo[2] } };
  }
  return null;
}

const HELP = `Here's what I can do. Tap a control, or type or say it:
- status, what's next, this week, errors
- approve, skip, or redo: what to change (for the video waiting)
- next, or next and an account name, to make a video now
- publish now, check logins, run a pulse, restart bot
- pause or resume everything, or one account: pause and its name
- open any folder: say folders to see them, or open and a project's workspace
- for me: mute, unmute, size small, medium or large, clear chat
Anything else, just ask in your own words.`;

// Warnings and errors from the system log, newest last, as short readable lines.
function problems(n = 6) {
  return readLog({ lvl: "warn", n, sinceMs: 24 * 3_600_000 }).map((e) =>
    `${new Date(e.t).toLocaleString("en-CA", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })} ${e.src}${e.key ? ` ${e.key}` : ""}: ${e.msg.split("\n")[0].slice(0, 200)}`);
}

// The state as short readable lines: fewer tokens than raw JSON, and easier to answer from.
function deskBrief(st) {
  const c = st.counts;
  const lines = [summary(st)];
  const list = (title, rows) => rows.length && lines.push(`${title}:\n${rows.map((r) => `- ${r}`).join("\n")}`);
  list("Waiting for review (key, cut)", st.review.map((v) => `${v.key} cut ${v.cut}: "${v.hook}" for ${v.day} ${v.post_at}, AI label ${v.is_aigc ? "on" : "off"}`));
  list("Coming up (approved, queued, posted)", st.upcoming.slice(0, 10).map((u) => `${u.key}: ${u.status}${u.slot ? `, scheduled ${u.slot}` : `, planned ${u.day} ${u.post_at}`}${u.job ? `, upload ${u.job}` : ""}`));
  list("Blocked", st.blocked.map((b) => `${b.key}: ${b.note ?? ""}`));
  list("Uploads that need a human", st.attention.map((a) => `${a.key}: ${a.status} after ${a.attempts} tries, ${a.error}`));
  list("Uploads being retried", (st.retrying ?? []).map((r) => `${r.key}: ${r.attempts} of 3 tries used`));
  list("Accounts", st.accounts.map((a) => `${a.id}: login ${a.login_ok ? "ok" : "BROKEN"}${a.paused ? ", paused" : ""}`));
  list("Scheduled tasks", st.tasks.map((t) => `${t.name}: ${t.status}, next ${t.next}`));
  list("Warnings and errors in the system log, last 24 h", problems());
  list("Recent events", st.events.slice(0, 8).map((e) => `${e.at} ${e.job_key ?? ""} ${e.event} ${e.detail ?? ""}`.trim()));
  lines.push(`${c.planned} posts are still planned this week and next.`);
  return lines.join("\n");
}

// One persistent Claude session for the desk chat (stream-json in and out). Starting the
// CLI costs ~8 s (hooks, plugins, config), so it is paid once, at server start: a reply
// then starts in about a second. Hooks, MCP servers and skills are off and it runs from
// the temp folder (no project CLAUDE.md); cc's rules are its appended system prompt. The
// session is recycled after RECYCLE_AFTER messages to keep its context small.
const DESK_DIR = tmpdir();
const DESK_SETTINGS = join(DESK_DIR, "cc-desk-settings.json");
const DESK_RULES = join(DESK_DIR, "cc-desk-rules.md");
writeFileSync(DESK_SETTINGS, JSON.stringify({ disableAllHooks: true }));
writeFileSync(DESK_RULES, `You are ${config.assistant.name}, the friendly desk assistant for cc-studio, the user's social video pipeline:
the weekly strategist plans posts, the content creator makes one video at a time, the user
approves each in Telegram or here, the scheduler queues it, and the tick uploads it with
TikTok's scheduler (the pulse checks everything every 30 min).

Each user turn gives you NOW, a fresh STATE and the USER's words. Your replies are shown in a
small chat AND read aloud, so:
- Answer in 1 to 3 short, plain sentences. Calm and friendly, never chatty. Lead with the answer.
- Write for the ear: full day and month names ("Wednesday, October 7"), times like "8 PM",
  "one" or "two" rather than digits for small counts, no parentheses, slashes, abbreviations,
  symbols or technical log text. Say what happened in plain words ("the upload failed twice").
- If a list really helps, use at most 4 lines starting with "- ", each a short full sentence.
- No markdown (no **, #, backticks), no emoji. Say names, not keys: "My Brand's Monday post"
  or "My Brand's October 6 post", never "mybrand-tiktok-2026-10-06-001". Use the day names in NOW.
- Answer only from STATE. Never invent posts, numbers, times or keys. If STATE doesn't say, say so.

If the user wants something done, add ONE line: ACTION: {"action":"...","key":"...","cut":1,"feedback":"..."}
using one of: ${ACTIONS.join(", ")} (approve/skip/redo need the key and cut of a video waiting
for review; redo needs feedback; next may take an account id as key to make that account's
next post; pause_account/resume_account need an account id (${accountIds().join(", ")});
post_time sets the daily posting time: "time":"HH:MM" (24 h) or "auto", with an account id as
key for just one account (posts already scheduled on TikTok keep their time; never use redo for
times, redo only remakes a video waiting for review); check runs the login check; open needs one of these keys: ${FOLDERS.map((f) => f.key).join(", ")}; retry/posted need
the key of an upload that needs a human). It becomes a button the user taps; say what it will do.
Always end with ONE line of 2 or 3 short follow-up QUESTIONS the user might ask next (questions,
not commands; actions belong in ACTION): CHIPS: first | second | third
`);
const RECYCLE_AFTER = 12;
const desk = { proc: null, buf: "", queue: [], current: null, turns: 0 };

function deskStart() {
  const args = ["-p", "--model", model("desk"), "--input-format", "stream-json",
    "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--strict-mcp-config", "--disable-slash-commands",
    "--no-session-persistence", "--no-chrome", "--settings", `"${DESK_SETTINGS}"`, "--append-system-prompt-file", `"${DESK_RULES}"`];   // shell:true, and temp paths can hold spaces
  const p = spawn("claude", args, { shell: true, windowsHide: true, cwd: DESK_DIR });
  desk.proc = p; desk.buf = ""; desk.turns = 0;
  note("info", "chat session started");
  let lastErr = "";
  p.stdout.on("data", (d) => {
    desk.buf += d;
    let i;
    while ((i = desk.buf.indexOf("\n")) >= 0) {
      const line = desk.buf.slice(0, i); desk.buf = desk.buf.slice(i + 1);
      let j; try { j = JSON.parse(line); } catch { continue; }
      const job = desk.current;
      if (!job) continue;
      const delta = j.event?.delta?.text;
      if (delta) { job.raw += delta; job.text = visible(job.raw); job.first ??= Date.now() - job.t0; }
      if (j.type === "result") finish(job, j.is_error ? String(j.result) : null, j.result);
    }
  });
  p.stderr.on("data", (d) => { lastErr = String(d).trim().slice(-300) || lastErr; });
  p.on("close", (code) => {
    // A recycled session closes on purpose (desk.proc already moved on); anything else is news.
    note(desk.proc === p ? "warn" : "info", `chat session stopped (code ${code})${desk.proc === p && lastErr ? `: ${lastErr}` : ""}`);
    if (desk.proc === p) desk.proc = null;
    if (desk.current) finish(desk.current, "the chat session stopped");   // the next message starts a new one
  });
}

const visible = (raw) => raw.split(/\n(?=ACTION:|CHIPS:)/)[0].replace(/\n?(ACTION|CHIPS):?[^\n]*$/, "").trimEnd();

function finish(job, error, result) {
  clearTimeout(job.timer);
  if (typeof result === "string" && !error) job.raw = result;
  const act = /\nACTION:\s*(\{.*\})/.exec(job.raw);
  const chips = /\n?CHIPS:\s*(.+)/.exec(job.raw);
  try { const a = act && JSON.parse(act[1]); if (a && ACTIONS.includes(a.action)) job.suggest = a; } catch {}
  job.chips = chips ? chips[1].split("|").map((x) => x.trim()).filter(Boolean).slice(0, 3) : [];
  job.text = visible(job.raw) || (/limit/i.test(error ?? "") ? "Claude's usage limit is hit. Plain commands still work: status, pause, next, approve."
    : "I couldn't get an answer from Claude just now. Plain commands still work.");
  job.done = true;
  note(error ? "warn" : "info", error ? `chat failed: ${error.slice(0, 300)}` : `chat answered: first words ${job.first ?? "-"} ms, done ${Date.now() - job.t0} ms`,
    { q: job.user.slice(0, 200) });
  chatLog.push({ user: job.user, bot: job.text });
  chatLog.splice(0, Math.max(0, chatLog.length - 12));
  setTimeout(() => chats.delete(job.id), 10 * 60_000);
  desk.current = null;
  if (++desk.turns >= RECYCLE_AFTER && desk.proc) { const old = desk.proc; desk.proc = null; old.stdin.end(); deskStart(); }
  pump();
}

function pump() {
  if (desk.current || !desk.queue.length) return;
  if (!desk.proc) deskStart();
  const job = desk.current = desk.queue.shift();
  job.timer = setTimeout(() => { if (desk.current === job) { desk.proc?.kill(); } }, 90_000);
  const fresh = desk.turns === 0 && chatLog.length;   // a new session: carry the last few turns over
  const content = `NOW (local): ${new Date().toLocaleString("en-CA", { weekday: "long", hour12: false })}
STATE:
${deskBrief(job.state)}${fresh ? `\nEARLIER IN THIS CHAT: ${JSON.stringify(chatLog.slice(-4))}` : ""}
USER: ${job.user}`;
  desk.proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
}

function startDesk(text, st) {
  const id = String(++chatSeq);
  const job = { id, user: text, state: st, text: "", raw: "", done: false, suggest: null, chips: [], t0: Date.now() };
  chats.set(id, job);
  desk.queue.push(job);
  pump();
  return id;
}

// Quick commands answer at once ({done, reply}); anything else streams ({id}, then poll).
function chat(text) {
  const st = widgetState();
  let r = quick(text, st);
  if (r?.run) {
    const done = widgetAct(r.run);
    r = { ...r, reply: [r.reply, done.message ?? done.error ?? ""].filter(Boolean).join("\n") };
  }
  if (r) {
    note("info", "chat answered from a quick command", { q: text.slice(0, 200) });
    chatLog.push({ user: text, bot: r.reply });
    chatLog.splice(0, Math.max(0, chatLog.length - 12));
    return { done: true, reply: r.reply, speech: r.speech, chips: r.chips ?? [], controls: !!r.controls, folders: !!r.folders, suggest: r.suggest };
  }
  return { id: startDesk(text, st) };
}

// A rendered video by post key; the path comes from the database, never the request.
function streamVideo(req, res, key) {
  const file = JSON.parse(db.prepare("SELECT plan_json FROM week_plans WHERE key=?").get(key)?.plan_json ?? "{}").video;
  if (!file || !existsSync(file)) { res.writeHead(404); return res.end(); }
  const size = statSync(file).size;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  if (!m) {
    res.writeHead(200, { "content-type": "video/mp4", "content-length": size, "accept-ranges": "bytes" });
    return createReadStream(file).pipe(res);
  }
  const start = m[1] ? Number(m[1]) : 0, end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start > end || start >= size) { res.writeHead(416, { "content-range": `bytes */${size}` }); return res.end(); }
  res.writeHead(206, { "content-type": "video/mp4", "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes" });
  createReadStream(file, { start, end }).pipe(res);
}

// ---------------------------------------------------------------------- routes
const server = createServer(async (req, res) => {
  const send = (code, body, type = "application/json") => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-frame-options": "DENY" });
    res.end(type === "application/json" ? JSON.stringify(body) : body);
  };
  try {
    // Only this machine's own pages may use the desk: a Host check stops DNS rebinding, and
    // an Origin check stops other websites from POSTing controls to localhost.
    const self = new RegExp(`^(localhost|127\\.0\\.0\\.1):${PORT}$`);
    if (!self.test(req.headers.host ?? "")) return send(403, { error: "bad host" });
    if (req.method === "POST" && req.headers.origin && !self.test(req.headers.origin.replace(/^http:\/\//, ""))) return send(403, { error: "bad origin" });
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/widget") {
      return send(200, readFileSync("dashboard/widget.html", "utf8"), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/api/widget") return send(200, widgetState());
    if (req.method === "GET" && url.pathname === "/api/logs") {
      const q = (k) => url.searchParams.get(k) || undefined;
      return send(200, readLog({ src: q("src"), lvl: q("lvl"), q: q("q"), n: Math.min(Number(q("n")) || 100, 1000),
        sinceMs: q("hours") ? Number(q("hours")) * 3_600_000 : undefined }));
    }
    if (req.method === "GET" && url.pathname === "/api/chat/poll") {
      const j = chats.get(url.searchParams.get("id") ?? "");
      return j ? send(200, { text: j.text, done: j.done, suggest: j.suggest, chips: j.chips }) : send(404, { error: "no such chat" });
    }
    if (req.method === "GET" && url.pathname === "/video") return streamVideo(req, res, url.searchParams.get("key") ?? "");
    if (req.method === "GET" && url.pathname === "/calendar") {
      const week = /^\d{4}-W\d{2}$/.test(url.searchParams.get("week") ?? "") ? url.searchParams.get("week") : nextWeek().id;
      const f = `auto_content_pipeline/output/weeks/${week}/calendar.html`;
      return existsSync(f) ? send(200, readFileSync(f, "utf8"), "text/html; charset=utf-8") : send(404, { error: "no calendar" });
    }
    if (req.method === "GET" && url.pathname === "/") {
      return send(200, readFileSync("dashboard/index.html", "utf8"), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/api/state") return send(200, state());
    if (req.method === "GET" && url.pathname === "/thumb") {
      // The path comes from the database, never from the query string: the
      // client sends a sha and gets whatever file we catalogued for it.
      const row = db.prepare("SELECT thumb FROM content WHERE sha=?").get(url.searchParams.get("sha") ?? "");
      if (!row?.thumb || !existsSync(row.thumb)) return send(404, { error: "no thumbnail" });
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "max-age=86400" });
      return res.end(readFileSync(row.thumb));
    }
    if (req.method === "GET" && url.pathname === "/api/run") {
      const from = Number(url.searchParams.get("from") ?? 0);
      const id = Number(url.searchParams.get("id") ?? 0);
      const r = id ? runs.find((x) => x.id === id) : (activeRun() ?? runs[runs.length - 1]);
      return send(200, publicRun(r, from) ?? { id: null, lines: [], total: 0, from: 0 });
    }
    if (req.method === "GET" && url.pathname === "/api/job") {
      const key = url.searchParams.get("key");
      const job = db.prepare("SELECT * FROM jobs WHERE key=?").get(key);
      if (!job) return send(404, { error: "no such job" });
      return send(200, {
        job,
        plan: db.prepare("SELECT * FROM plans WHERE key=?").get(key) ?? null,
        metrics: db.prepare("SELECT * FROM metrics WHERE job_key=? ORDER BY id DESC").all(key),
        events: db.prepare("SELECT * FROM events WHERE job_key=? ORDER BY id DESC LIMIT 40").all(key),
        queue_files: existsSync(`queue/${key}`) ? readdirSync(`queue/${key}`) : [],
        evidence: existsSync(`evidence/${key}`) ? readdirSync(`evidence/${key}`) : [],
      });
    }

    if (req.method === "POST") {
      const body = JSON.parse(await new Promise((r) => {
        let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d || "{}"));
      }));

      if (url.pathname === "/api/chat") {
        if (typeof body.text !== "string" || !body.text.trim()) return send(400, { error: "empty message" });
        return send(200, chat(body.text.slice(0, 2000)));
      }
      if (url.pathname === "/api/widget/act") {
        const r = widgetAct(body);
        return send(r.error ? 400 : 200, r);
      }
      if (url.pathname === "/api/run") {
        try { return send(200, publicRun(startRun(body.task, body.account)) ); }
        catch (e) { return send(409, { error: e.message }); }
      }
      if (url.pathname === "/api/run/cancel") {
        const r = activeRun();
        if (!r) return send(409, { error: "nothing is running" });
        r.kill();
        return send(200, { ok: true });
      }
      if (url.pathname === "/api/stop") {
        if (body.on) writeFileSync(STOP_FILE, `stopped from the desk at ${new Date().toISOString()}\n`);
        else if (existsSync(STOP_FILE)) rmSync(STOP_FILE);
        log(null, "kill_switch", body.on ? "engaged" : "cleared");
        return send(200, { ok: true, stop_file: existsSync(STOP_FILE) });
      }
      if (url.pathname === "/api/resolve") {
        const { key, status } = body;
        if (!["SCHEDULED", "PUBLISHED", "FAILED", "PLANNED", "ARCHIVED"].includes(status)) return send(400, { error: "bad status" });
        // PLANNED means "try again" — a job that already burnt 3 attempts would
        // otherwise be re-marked and then silently skipped by the tick forever.
        const attempts = status === "PLANNED" ? ", attempts=0, claimed_at=NULL" : "";
        db.prepare(`UPDATE jobs SET status=?, error=NULL${attempts}, updated_at=datetime('now') WHERE key=?`).run(status, key);
        log(key, "manual_resolve", status);
        return send(200, { ok: true });
      }
      if (url.pathname === "/api/pause") {
        const { account, paused } = body;
        db.prepare(`INSERT INTO account_health (account, paused) VALUES (?,?)
                    ON CONFLICT(account) DO UPDATE SET paused=excluded.paused`).run(account, paused ? 1 : 0);
        log(null, "account_paused", `${account} paused=${paused ? 1 : 0}`);
        return send(200, { ok: true });
      }
      if (url.pathname === "/api/metrics") {
        const { key, views, likes, comments, shares } = body;
        const account = db.prepare("SELECT account FROM jobs WHERE key=?").get(key)?.account ?? null;
        db.prepare("INSERT INTO metrics (job_key, account, views, likes, comments, shares) VALUES (?,?,?,?,?,?)")
          .run(key, account, +views || 0, +likes || 0, +comments || 0, +shares || 0);
        log(key, "metrics_added", `views=${views}`);
        return send(200, { ok: true });
      }
      if (url.pathname === "/api/experiment") {
        if (body.close_id) {
          db.prepare("UPDATE experiments SET status='done', result=? WHERE id=?").run(body.result ?? null, body.close_id);
          return send(200, { ok: true });
        }
        if (!body.name) return send(400, { error: "name is required" });
        db.prepare("INSERT INTO experiments (name, hypothesis, control, variant, project) VALUES (?,?,?,?,?)")
          .run(body.name, body.hypothesis ?? null, body.control ?? null, body.variant ?? null, body.project ?? null);
        return send(200, { ok: true });
      }
      if (url.pathname === "/api/agent-template") {
        if (typeof body.text !== "string" || body.text.length < 200) {
          return send(400, { error: "refusing to write a template that short" });
        }
        mkdirSync("agents", { recursive: true });
        if (existsSync(TEMPLATE)) writeFileSync(`${TEMPLATE}.bak`, readFileSync(TEMPLATE));
        writeFileSync(TEMPLATE, body.text);
        log(null, "agent_template_edited", `${body.text.length} chars`);
        return send(200, { ok: true });
      }
    }
    send(404, { error: "not found" });
  } catch (e) {
    send(500, { error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => { console.log(`Dashboard: http://localhost:${PORT}`); lifecycle(`on port ${PORT}`); deskStart(); });
