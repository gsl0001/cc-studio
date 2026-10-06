// Week posts after planning. The content creator agent renders them, you approve each
// video, and `schedule` hands approved ones to the queue (the tick then uploads them
// with TikTok's own scheduler). Status flow:
//   planned -> rendered | blocked -> approved | rejected -> queued -> posted
//
//   node scripts/posts.mjs due [days]                    planned posts for today..today+days (default 2), JSON
//   node scripts/posts.mjs show <key>                    one post as JSON
//   node scripts/posts.mjs set <key> <status> [--video <mp4>] [--note <text>]
//   node scripts/posts.mjs review                        rendered videos waiting for you
//   node scripts/posts.mjs approve <key>                 approve, then schedule it
//   node scripts/posts.mjs reject <key> <reason>
//   node scripts/posts.mjs schedule                      queue every approved post; mark posted ones
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { db, log } from "../src/db.js";
import { loadRegistry } from "../src/registry.js";
import { STATUSES } from "../auto_content_pipeline/src/schema.js";
import { notify, sendVideo } from "../src/telegram.js";
import { parseUses, recordUse } from "./clips.mjs";
import { config, rootPath } from "../src/config.js";

const row = (key) => db.prepare("SELECT * FROM week_plans WHERE key=?").get(key);
const today = () => new Date().toLocaleDateString("sv");
const addDays = (d, n) => new Date(new Date(`${d}T12:00`).getTime() + n * 86_400_000).toLocaleDateString("sv");

// The DB row and the week file hold the same post; both change together.
export function setPost(key, status, extra = {}) {
  const r = row(key);
  if (!r) throw new Error(`${key}: no such week post`);
  if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(", ")}`);
  const post = { ...JSON.parse(r.plan_json), ...extra, status };
  db.prepare("UPDATE week_plans SET status=?, plan_json=? WHERE key=?").run(status, JSON.stringify(post), key);
  const file = `auto_content_pipeline/output/weeks/${r.week}/${r.account}.json`;
  if (existsSync(file)) {
    const plan = JSON.parse(readFileSync(file, "utf8"));
    plan.posts = plan.posts.map((p) => (p.key === key ? post : p));
    writeFileSync(`${file}.tmp`, JSON.stringify(plan, null, 2));
    renameSync(`${file}.tmp`, file);
  }
  log(key, "week_post", `${status}${extra.note ? `: ${extra.note}` : ""}`.slice(0, 300));
  return post;
}

export function duePosts(days = 2) {
  const live = new Set(loadRegistry().accounts.filter((a) => a.enabled).map((a) => a.id));
  // A redo (feedback pending) of a post whose day has passed is still made: approving it
  // schedules it at the next free slot. Without this it sat in "planned" forever.
  return db.prepare(`SELECT key, account, week, day, post_at FROM week_plans WHERE status='planned'
                       AND (day BETWEEN ? AND ? OR (json_extract(plan_json,'$.feedback') IS NOT NULL AND day >= ?))
                     ORDER BY day, post_at`)
    .all(today(), addDays(today(), days), addDays(today(), -7)).filter((r) => live.has(r.account));
}

// If you also post videos by hand from a folder (paths.handPost), pipeline videos must never
// sit there: they post automatically, so one there gets posted twice. Moves the video, cover,
// caption, manifest entry and README line to the finals folder, whatever the agent did.
// Copy + delete: the folder may be on another drive or synced to a phone.
const norm = (p) => (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
const HAND = config.paths.handPost ? norm(rootPath(config.paths.handPost)) : null;
const FINALS = norm(rootPath(config.paths.finals));
const under = (dir, file) => {   // [project, name] when file is <dir>/<project>/<name>.mp4
  const f = norm(file);
  return f.toLowerCase().startsWith(dir.toLowerCase() + "/") ? /\/([^/]+)\/([^/]+)\.mp4$/i.exec(f)?.slice(1) ?? null : null;
};
export function relocateFinal(key) {
  if (!HAND) return false;
  const post = JSON.parse(row(key).plan_json);
  const m = under(HAND, post.video);
  if (!m) {
    // The agent may have saved to finals AND copied to the hand-post folder (a project
    // CLAUDE.md told it to): an identical copy there would get posted twice.
    const f = under(FINALS, post.video);
    if (!f) return false;
    let removed = 0;
    for (const ext of [".mp4", ".jpg", "-caption.txt"]) {
      const copy = `${HAND}/${f[0]}/${f[1]}${ext}`, ours = `${FINALS}/${f[0]}/${f[1]}${ext}`;
      if (existsSync(copy) && existsSync(ours) && statSync(copy).size === statSync(ours).size) { rmSync(copy); removed++; }
    }
    if (removed) log(key, "final_copy_removed", `${removed} file(s) of ${f[1]} removed from the hand-post folder`);
    return false;
  }
  const [brand, name] = m;
  mkdirSync(`${FINALS}/${brand}`, { recursive: true });
  for (const f of [`${name}.mp4`, `${name}.jpg`, `${name}-caption.txt`]) {
    const from = `${HAND}/${brand}/${f}`, to = `${FINALS}/${brand}/${f}`;
    if (!existsSync(from)) continue;
    copyFileSync(from, to);
    if (statSync(from).size !== statSync(to).size) throw new Error(`copy of ${f} is incomplete`);
    rmSync(from);
  }
  const file = `${brand}/${name}.mp4`;
  if (existsSync(`${HAND}/manifest.json`)) {
    const hand = JSON.parse(readFileSync(`${HAND}/manifest.json`, "utf8"));
    const i = hand.findIndex((e) => e.file === file);
    if (i >= 0) {
      const ours = existsSync(`${FINALS}/manifest.json`) ? JSON.parse(readFileSync(`${FINALS}/manifest.json`, "utf8")) : [];
      ours.push(...hand.splice(i, 1));
      writeFileSync(`${HAND}/manifest.json`, JSON.stringify(hand, null, 2).replace(/\n/g, "\r\n"));
      writeFileSync(`${FINALS}/manifest.json`, JSON.stringify(ours, null, 2) + "\n");
    }
  }
  if (existsSync(`${HAND}/README.md`)) {
    const lines = readFileSync(`${HAND}/README.md`, "utf8").split(/(?<=\n)/);   // keeps each line's ending
    const line = lines.find((l) => l.includes(`(${file})`));
    if (line) {
      writeFileSync(`${HAND}/README.md`, lines.filter((l) => l !== line).join(""));
      writeFileSync(`${FINALS}/README.md`, `${existsSync(`${FINALS}/README.md`) ? readFileSync(`${FINALS}/README.md`, "utf8").trimEnd() + "\n" : ""}${line.trimEnd()}\n`);
    }
  }
  setPost(key, row(key).status, { video: `${FINALS}/${file}` });   // current status: it may have moved on meanwhile
  log(key, "final_relocated", `${post.video} -> ${FINALS}/${file}`);
  return true;
}

// First queue key for this post that no queue dir or job row holds yet.
function queueKey(account, day) {
  for (let n = 1; n < 100; n++) {
    const k = `${account}-${day}-${String(n).padStart(3, "0")}`;
    if (!existsSync(`queue/${k}`) && !db.prepare("SELECT 1 FROM jobs WHERE key=?").get(k)) return k;
  }
  throw new Error(`${account} ${day}: no free queue key`);
}

const SCHED_LOCK = "SCHEDULING";
export function schedule() {
  // One scheduler at a time: the pulse, the bot and the desk all call this, and two at once
  // picked the same queue key, one failed and wrote "blocked" over "queued".
  if (existsSync(SCHED_LOCK) && Date.now() - statSync(SCHED_LOCK).mtimeMs < 2 * 60_000) return [];
  writeFileSync(SCHED_LOCK, String(process.pid));
  try { return scheduleOnce(); } finally { rmSync(SCHED_LOCK, { force: true }); }
}
function scheduleOnce() {
  const out = [];
  // Posted: the tick has handed the job to TikTok (scheduled there, or live).
  for (const r of db.prepare("SELECT key, plan_json FROM week_plans WHERE status='queued'").all()) {
    const job = db.prepare("SELECT status, attempts FROM jobs WHERE key=?").get(JSON.parse(r.plan_json).queue_key ?? "");
    if (["SCHEDULED", "PUBLISHED"].includes(job?.status)) { setPost(r.key, "posted"); out.push(`posted   ${r.key}`); }
    // Back in the publisher's hands (retried from the desk or by hand): a stale alert must not
    // trigger a hand-off while the tick uploads the same video.
    else if (job && ["PLANNED", "UPLOADING", "AWAITING_FINAL_ACTION"].includes(job.status) && JSON.parse(r.plan_json).alert) {
      setPost(r.key, "queued", { alert: null, handoff_sent: null });
    }
    // A job a human must look at is reported once per status, not on every pulse. A
    // FAILED job with attempts left is the tick's to retry, not yours.
    else if (job && (["MANUAL_REVIEW", "UNKNOWN", "ARCHIVED"].includes(job.status) || (job.status === "FAILED" && job.attempts >= 3))
             && JSON.parse(r.plan_json).alert !== job.status) {
      setPost(r.key, "queued", { alert: job.status });
      out.push(`CHECK    ${r.key}: job is ${job.status} — see npm run status`);
    }
  }
  for (const r of db.prepare("SELECT key, account, day, plan_json FROM week_plans WHERE status='approved' ORDER BY day, post_at").all()) {
    relocateFinal(r.key);
    const post = JSON.parse(row(r.key).plan_json);
    if (!post.video || !existsSync(post.video)) { setPost(r.key, "blocked", { note: `approved but the video is missing: ${post.video ?? "(none)"}` }); out.push(`BLOCKED  ${r.key}: video missing`); continue; }
    const qkey = queueKey(r.account, r.day);
    // queue.js reads caption, hashtags, is_aigc and the planned time from plans/<key>.json.
    mkdirSync("plans", { recursive: true });
    writeFileSync(`plans/${qkey}.json`, JSON.stringify({ key: qkey, week_post: r.key, account: r.account, day: post.day, post_at: post.post_at,
      caption: post.caption, hashtags: post.hashtags, is_aigc: post.is_aigc, hook: post.hook?.text }, null, 2));
    const q = spawnSync(process.execPath, ["src/queue.js", qkey, post.video], { encoding: "utf8" });
    const msg = `${q.stdout ?? ""}${q.stderr ?? ""}`.trim();
    if (q.status === 0) { setPost(r.key, "queued", { queue_key: qkey }); out.push(`queued   ${r.key} -> ${msg.split("\n").at(-1)}`); }
    // Blocked, not retried: a refused queue (a duplicate, a bad caption) fails the same way every pulse.
    else { setPost(r.key, "blocked", { note: `queue refused it: ${msg.split("\n").at(-1)}` }); out.push(`BLOCKED  ${r.key}: queue refused it — ${msg.split("\n").at(-1)}`); }
  }
  return out;
}

// The key and cut go in the caption and buttons: the Telegram bot reads them back from the
// message you answer, and an answer to an older cut (from before a redo) is refused.
export async function sendForReview(key, title) {
  const post = JSON.parse(row(key).plan_json);
  const cut = post.cut ?? 1;
  // The AI-content label is the user's call (GUIDELINES §1): approving the video approves it.
  const caption = [`${title} · ${post.day} ${post.post_at}`, `"${post.hook?.text ?? ""}"`,
    `TikTok AI-content label: ${post.is_aigc ? "ON" : "off"} (reply with what to change if wrong)`, post.note ? `\n${post.note}` : "",
    "", `KEY: ${key} CUT: ${cut}`, `Tap a button, or reply "approve", "skip" or what to change.`].join("\n");
  const cover = post.video?.replace(/\.mp4$/i, ".jpg");
  const sent = post.video && existsSync(post.video) && await sendVideo(post.video, caption, [
    { text: "✅ Approve", callback_data: `approve:${key}:${cut}` },
    { text: "🔁 Redo", callback_data: `redo:${key}:${cut}` },
    { text: "⏭ Skip", callback_data: `skip:${key}:${cut}` },
  ], cover && existsSync(cover) ? cover : null);
  if (!sent) await notify(`${caption}\n\n(video upload failed — file: ${post.video})`);
  // Re-read: the user may approve while the upload to Telegram runs (2026-10-03 a stale
  // "rendered" written here undid an approval and blocked a queued post).
  setPost(key, row(key).status, { reminded_at: new Date().toISOString() });
}

// Start the next video in the background; creator.mjs holds the lock that keeps it to one.
export function nextVideo(account = null) {   // account: make that account's next post
  const out = openSync("logs/creator.log", "a");
  spawn(process.execPath, ["scripts/creator.mjs", ...(account ? [account] : [])], { detached: true, windowsHide: true, stdio: ["ignore", out, out] }).unref();
}

// Your answer to a rendered video, from Telegram or the desk widget. `cut` comes from the
// message or card you answered; null (older messages) means the current cut.
export function decide(key, verdict, feedback = "", cut = null, where = "Telegram") {
  const row = db.prepare("SELECT status, plan_json FROM week_plans WHERE key=?").get(key);
  if (!row) return `${key}: no such post.`;
  if (!["rendered", "blocked"].includes(row.status)) return `${key} is already ${row.status} — nothing to do.`;
  const post = JSON.parse(row.plan_json);
  // Rendered but not yet sent for review = the creator's similarity check is still running.
  if (row.status === "rendered" && !post.reminded_at) return `${key} is still being checked; it comes to you in a minute.`;
  const current = post.cut ?? 1;
  if (cut && Number(cut) !== current) return `That message shows an older cut of ${key} (cut ${cut}; the newest is cut ${current}). Answer the newest one.`;
  if (verdict === "approve") {
    setPost(key, "approved");
    const lines = schedule().filter((l) => l.includes(key));
    return `✅ ${key}\n${lines.join("\n") || "approved; it will be queued on the next scheduling pass"}`;
  }
  if (verdict === "skip") { setPost(key, "rejected", { note: `skipped in ${where}` }); return `⏭ ${key} skipped.`; }
  setPost(key, "planned", { feedback, note: `redo requested: ${feedback}`, cut: current + 1, pending_feedback: null, creator_runs: 0, reminded_at: null });
  return `🔁 ${key} goes back for a remake with your note: "${feedback}"`;
}

// ------------------------------------------------------------------ videos that can't be scheduled
// After the tick's 3 attempts (or a job a human must resolve), the video comes to the user
// to post by hand: the file and caption in Telegram with "I posted it" / "Retry".
const weekRow = (key) => db.prepare("SELECT key, status, plan_json FROM week_plans WHERE key=? OR json_extract(plan_json,'$.queue_key')=?").get(key, key);

export async function sendHandoff(key) {
  const r = weekRow(key);
  if (!r) return;
  const post = JSON.parse(r.plan_json);
  const job = db.prepare("SELECT key, status, attempts, scheduled_for, error FROM jobs WHERE key=?").get(post.queue_key ?? "");
  if (!job) return;
  if (!(["MANUAL_REVIEW", "UNKNOWN"].includes(job.status) || (job.status === "FAILED" && job.attempts >= 3))) {
    setPost(r.key, row(r.key).status, { alert: null, handoff_sent: null });   // the tick has it again
    return;
  }
  const dir = `queue/${job.key}`;
  const file = existsSync(`${dir}/final.mp4`) ? `${dir}/final.mp4` : post.video;
  const caption = existsSync(`${dir}/caption.txt`) ? readFileSync(`${dir}/caption.txt`, "utf8").trim() : post.caption ?? "";
  const unknown = job.status === "UNKNOWN";   // the post button may have fired: never offer a blind retry
  const text = [`✋ Couldn't schedule this one automatically: ${r.key.replace(/-tiktok-/, " ").replace(/-001$/, "")}, meant for ${job.scheduled_for ?? post.day + " " + post.post_at}.`,
    `Why: ${(job.error ?? job.status).slice(0, 160)}`,
    unknown ? "TikTok may already have it: check the account first." : "Post it by hand in TikTok (caption below), or tap Retry to let the publisher try again.",
    "", caption, "", `KEY: ${r.key}`].join("\n");
  const buttons = [{ text: "✅ I posted it", callback_data: `posted:${r.key}` }];
  if (!unknown) buttons.push({ text: "🔁 Retry", callback_data: `retry:${r.key}` });
  const sent = file && existsSync(file) ? await sendVideo(file, text, buttons) : null;
  if (!sent) await notify(`${text}\n\n(file: ${file ?? "missing"})`);
  setPost(r.key, row(r.key).status, { handoff_sent: new Date().toISOString() });
}

// The user's answer to a hand-off: posted by hand, or put the job back for the tick.
export function resolveHandoff(key, action) {
  const r = weekRow(key);
  if (!r) return `${key}: no such post.`;
  const qkey = JSON.parse(r.plan_json).queue_key;
  const job = db.prepare("SELECT status FROM jobs WHERE key=?").get(qkey ?? "");
  if (!job || !["FAILED", "MANUAL_REVIEW", "UNKNOWN"].includes(job.status)) return `${r.key}: its upload is ${job?.status ?? "missing"}, nothing to resolve.`;
  if (action === "posted") {
    db.prepare("UPDATE jobs SET status='PUBLISHED', error='posted by hand' WHERE key=?").run(qkey);
    log(qkey, "manual_resolve", "PUBLISHED: posted by hand");
    setPost(r.key, "posted", { alert: null });
    return `✅ ${r.key} marked as posted by hand.`;
  }
  if (job.status === "UNKNOWN") return `${r.key}: the post button may have fired, so I won't retry blind. Check TikTok, then tap "I posted it".`;
  db.prepare("UPDATE jobs SET status='PLANNED', attempts=0, claimed_at=NULL, error=NULL WHERE key=?").run(qkey);
  log(qkey, "manual_resolve", "PLANNED: retry requested");
  setPost(r.key, "queued", { alert: null, handoff_sent: null });
  return `🔁 ${r.key} goes back to the publisher (3 fresh attempts).`;
}

if (import.meta.filename === process.argv[1]) {
  const [cmd, key, ...rest] = process.argv.slice(2);
  const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  if (cmd === "due") console.log(JSON.stringify(duePosts(Number(key ?? 2)), null, 2));
  else if (cmd === "show") console.log(row(key)?.plan_json ?? `${key}: no such week post`);
  else if (cmd === "set") {
    const extra = {};
    if (flag("--video")) extra.video = flag("--video").replace(/\\/g, "/");
    if (flag("--note")) extra.note = flag("--note");
    if (flag("--aigc")) extra.is_aigc = flag("--aigc") === "true";
    if (rest[0] === "rendered") {
      // What the video used is recorded here, at hand-off, so reuse never depends on memory.
      const list = flag("--assets");
      if (list === undefined) {
        console.error(`Not marked rendered: list what the video uses with --assets "<file>[@start-end]; <file>" (every asset and clip, with the seconds you cut), or --assets none.`);
        process.exit(2);
      }
      const account = loadRegistry().accounts.find((a) => a.id === row(key)?.account);
      const uses = list.trim().toLowerCase() === "none" ? [] : parseUses(list);
      const missing = uses.filter((u) => !recordUse(u.file, key, { ...u, project: account?.project }));
      extra.assets = uses;
      for (const u of missing) console.log(`(not in the catalogue or library, not tracked: ${u.file})`);
    }
    setPost(key, rest[0], extra);
    console.log(`${key} -> ${rest[0]}`);
  } else if (cmd === "review") {
    const rows = db.prepare("SELECT key, day, post_at, plan_json FROM week_plans WHERE status IN ('rendered','blocked') ORDER BY day, post_at").all();
    for (const r of rows) {
      const p = JSON.parse(r.plan_json);
      console.log(`${p.status.padEnd(9)} ${r.key}  ${r.day} ${r.post_at}  "${p.hook?.text ?? ""}"\n          ${p.video ?? ""}${p.note ? `\n          note: ${p.note}` : ""}`);
    }
    if (!rows.length) console.log("Nothing waiting for review.");
  } else if (cmd === "approve") {
    setPost(key, "approved");
    for (const line of schedule()) console.log(line);
  } else if (cmd === "reject") {
    setPost(key, "rejected", { note: rest.join(" ") || "rejected" });
    console.log(`${key} -> rejected`);
  } else if (cmd === "schedule") {
    const lines = schedule();
    console.log(lines.length ? lines.join("\n") : "Nothing to schedule.");
  } else {
    console.error("usage: node scripts/posts.mjs due|show|set|review|approve|reject|schedule — see the header");
    process.exit(1);
  }
}
