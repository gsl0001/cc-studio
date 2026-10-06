// Auto-approval: a finished video in a format the scorecard has proven on that account, made
// the plain way (the experiment's control, first try, no redo), that passes the file checks,
// goes out without waiting for you. It is held 6 hours first; Telegram shows it with a Stop
// button, and a morning digest lists what went out on its own. Everything else (experiment
// variants, new or unproven formats, anything a check flags) still comes to you for review.
//
//   node scripts/autoapprove.mjs check <key>    would this post auto-approve? (reasons)
//   node scripts/autoapprove.mjs test           self-check
//
// Off switch: the file AUTO_APPROVE_OFF (Telegram "auto off" / "auto on").
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { db, log } from "../src/db.js";
import { loadRegistry } from "../src/registry.js";
import { rulesFor } from "../src/scorecard.js";
import { family, postText } from "../auto_content_pipeline/src/validate.js";
import { channel, notify, sendVideo, tg } from "../src/telegram.js";
import { held, setPost } from "./posts.mjs";

export const OFF = "AUTO_APPROVE_OFF";
export const HOLD_HOURS = 6;
export const PROVEN = { n: 3, ratio: 1.0 };   // 3+ scored posts at the account's median or better
const LUFS = [-17, -11];                      // the creator aims at -14

// Pure: the decision from what is known about the post.
export function decide({ post, record, dropped = false, sim, checks = [], off = false }) {
  const why = [];
  if (off) why.push("auto-approval is off");
  if (post.experiment_arm !== "control") why.push(`it is the experiment's ${post.experiment_arm ?? "unassigned"} arm`);
  if (dropped) why.push(`format "${family(post.format)}" is dropped`);
  else if (!record || record.n < PROVEN.n || !(record.ratio >= PROVEN.ratio)) {
    why.push(record ? `format "${record.name}" isn't proven yet (${record.n} scored, ${record.ratio ?? "?"}x the median; needs ${PROVEN.n} at ${PROVEN.ratio}x)` : `format "${family(post.format)}" has no scored posts on this account`);
  }
  if ((post.creator_runs ?? 1) > 1 || post.feedback || (post.cut ?? 1) > 1) why.push("it took more than one try or has your notes");
  if (!sim) why.push("the similarity check didn't run");
  else if (sim.near_duplicate) why.push(`${Math.round(sim.share * 100)}% like a recent video`);
  if (/⚠/.test(post.note ?? "")) why.push("the creator flagged it");
  why.push(...checks);
  return { ok: why.length === 0, why };
}

const probe = (f) => {
  const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", f]).toString());
  const v = j.streams.find((s) => s.codec_type === "video") ?? {};
  return { w: v.width, h: v.height, s: Number(j.format?.duration), audio: j.streams.some((s) => s.codec_type === "audio") };
};
export function loudness(f) {
  // ffmpeg prints the measurement on stderr.
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", f, "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8" }).stderr ?? "";
  const m = /Integrated loudness:\s*I:\s*(-?[\d.]+)\s*LUFS/.exec(r);
  return m ? Number(m[1]) : null;
}

// The file checks: what a reviewer would catch at a glance.
export function fileChecks(post, project) {
  const out = [], f = post.video;
  if (!f || !existsSync(f)) return ["the video file is missing"];
  if (statSync(f).size < 100_000) out.push("the video is under 100 KB");
  const m = probe(f), [lo, hi] = project?.content?.preferred_duration_seconds ?? [0, 600];
  if (m.w !== 1080 || m.h !== 1920) out.push(`it is ${m.w}x${m.h}, not 1080x1920`);
  if (!m.audio) out.push("it has no sound");
  if (!(m.s >= lo - 2 && m.s <= hi + 2)) out.push(`it runs ${Math.round(m.s)} s (plan: ${lo}-${hi} s)`);
  const lufs = m.audio ? loudness(f) : null;
  if (m.audio && !(lufs >= LUFS[0] && lufs <= LUFS[1])) out.push(`loudness ${lufs ?? "unknown"} LUFS (needs ${LUFS[0]} to ${LUFS[1]})`);
  const caption = String(post.caption ?? "");
  if (!caption.trim() || /\$\{|placeholder|TODO|lorem/i.test(caption)) out.push("the caption is empty or a placeholder");
  if ((caption + " " + (post.hashtags ?? []).join(" ")).length > 2200) out.push("the caption is over 2200 characters");
  const bad = (project?.forbidden_claims ?? []).find((c) => postText(post).includes(c.toLowerCase()));
  if (bad) out.push(`it says "${bad}", a forbidden claim`);
  return out;
}

const row = (key) => db.prepare("SELECT key, account, status, plan_json FROM week_plans WHERE key=?").get(key);
export function evaluate(key, sim) {
  const r = row(key), post = JSON.parse(r.plan_json);
  const reg = loadRegistry(), account = reg.accounts.find((a) => a.id === r.account), project = reg.projects.find((p) => p.id === account?.project);
  const rules = rulesFor([r.account])[r.account];
  const record = rules.dims.find((d) => d.dim === "format" && d.name === family(post.format)) ?? null;
  const dropped = rules.dropped.some((d) => d.dim === "format" && d.name === family(post.format));
  return { ...decide({ post, record, dropped, sim, checks: fileChecks(post, project), off: existsSync(OFF) }), record, post, account: r.account };
}

const when = (iso) => new Date(iso).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
// Approves a qualifying post with a hold, shows it in Telegram, and returns true; false = review it.
export async function tryAutoApprove(key, sim) {
  const e = evaluate(key, sim);
  log(key, "auto_approve", e.ok ? "yes" : `no: ${e.why.join("; ")}`);
  if (!e.ok) { setPost(key, row(key).status, { auto_declined: e.why }); return false; }
  const hold = new Date(Date.now() + HOLD_HOURS * 3_600_000).toISOString();
  setPost(key, "approved", { reminded_at: new Date().toISOString(), auto: { at: new Date().toISOString(), hold_until: hold, format: e.record.name, ratio: e.record.ratio, n: e.record.n } });
  const p = e.post;
  await sendVideo(p.video, [`🤖 Auto-approved · ${p.day} ${p.post_at}`, `"${p.hook?.text ?? ""}"`,
    `Proven format "${e.record.name}": ${e.record.ratio}x this account's median over ${e.record.n} posts. Checks passed.`,
    `TikTok AI-content label: ${p.is_aigc ? "ON" : "off"}`, "", `It goes to TikTok after ${when(hold)} unless you stop it.`, `KEY: ${key}`].join("\n"),
    [{ text: "⛔ Stop it", callback_data: `stop:${key}` }]).catch(() => notify(`🤖 Auto-approved ${key}; stop it with "stop ${key}" before ${when(hold)}.`));
  return true;
}

// Stop: a held post goes back to you for review; a queued one not uploaded yet is pulled.
export function stopAuto(key) {
  const r = row(key);
  if (!r) return `${key}: no such post.`;
  const post = JSON.parse(r.plan_json);
  if (r.status === "approved") {
    setPost(key, "rendered", { auto: { ...(post.auto ?? {}), stopped: new Date().toISOString() }, reminded_at: null });
    return `⛔ Stopped ${key}. It's back with you: approve, redo or skip it below.`;
  }
  if (r.status === "queued") {
    const job = db.prepare("SELECT key, status FROM jobs WHERE key=?").get(post.queue_key ?? "");
    if (job && ["PLANNED", "FAILED"].includes(job.status)) {
      db.prepare("UPDATE jobs SET status='ARCHIVED', error='stopped from Telegram', updated_at=datetime('now') WHERE key=?").run(job.key);
      log(job.key, "cancelled", "auto-approval stopped");
      setPost(key, "rejected", { note: "auto-approved, then stopped before upload" });
      return `⛔ Stopped ${key} before it was uploaded.`;
    }
    return `${key} is already in TikTok's scheduler. Delete it in TikTok Studio (Posts > Scheduled) to stop it.`;
  }
  return `${key} is ${r.status}; there's nothing to stop.`;
}

// The morning digest: what went out on its own in the last day, what still can be stopped.
export async function digest() {
  const since = Date.now() - 86_400_000;
  const rows = db.prepare("SELECT key, status, plan_json FROM week_plans WHERE json_extract(plan_json,'$.auto.at') IS NOT NULL").all()
    .map((r) => ({ ...r, post: JSON.parse(r.plan_json) })).filter((r) => Date.parse(r.post.auto.at) > since);
  const reviewed = db.prepare("SELECT count(*) n FROM week_plans WHERE status IN ('approved','queued','posted') AND json_extract(plan_json,'$.auto.at') IS NULL AND json_extract(plan_json,'$.reminded_at') > ?").get(new Date(since).toISOString()).n;
  if (!rows.length) return false;
  const lines = rows.map((r) => `• ${r.key} (${r.post.auto.format}, ${r.post.auto.ratio}x): "${r.post.hook?.text ?? ""}" — ${r.post.auto.stopped ? "stopped" : r.status}`);
  const stoppable = rows.filter((r) => !r.post.auto.stopped && ["approved", "queued"].includes(r.status));
  await sendDigest([`🤖 Auto-approved in the last day: ${rows.length} (you reviewed ${reviewed}).`, ...lines, "",
    stoppable.length ? "Tap one to stop it (a post already in TikTok's scheduler has to be deleted in Studio)." : "Nothing left to stop."].join("\n"),
    stoppable.slice(0, 8).map((r) => [{ text: `⛔ ${r.key.replace(/-\d{3}$/, "")}`, callback_data: `stop:${r.key}` }]));
  return true;
}
async function sendDigest(text, rows) {
  const c = channel();
  if (!c) return;
  await tg("sendMessage", { chat_id: c.chatId, text, ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}) }).catch(() => notify(text));
}

if (import.meta.filename === process.argv[1]) {
  const [cmd, key] = process.argv.slice(2);
  if (cmd === "test") {
    const { default: assert } = await import("node:assert/strict");
    const post = { experiment_arm: "control", format: "before_after: wall", creator_runs: 1, note: "" };
    const record = { name: "before after", n: 4, ratio: 1.3 }, sim = { near_duplicate: false, share: 0.1 };
    assert.deepEqual(decide({ post, record, sim }), { ok: true, why: [] }, "proven control, clean: approved");
    assert.match(decide({ post: { ...post, experiment_arm: "variant" }, record, sim }).why[0], /variant/);
    assert.match(decide({ post, record: { ...record, n: 2 }, sim }).why[0], /isn't proven/);
    assert.match(decide({ post, record: { ...record, ratio: 0.8 }, sim }).why[0], /isn't proven/);
    assert.match(decide({ post, record: null, sim }).why[0], /no scored posts/);
    assert.match(decide({ post, record, dropped: true, sim }).why[0], /dropped/);
    assert.match(decide({ post: { ...post, creator_runs: 2 }, record, sim }).why[0], /more than one try/);
    assert.match(decide({ post: { ...post, feedback: "x" }, record, sim }).why[0], /your notes/);
    assert.match(decide({ post, record, sim: null }).why[0], /similarity/);
    assert.match(decide({ post, record, sim: { near_duplicate: true, share: 0.4 } }).why[0], /40% like/);
    assert.match(decide({ post: { ...post, note: "⚠ still 40% like x" }, record, sim }).why[0], /flagged/);
    assert.match(decide({ post, record, sim, checks: ["loudness -20 LUFS"] }).why[0], /loudness/);
    assert.match(decide({ post, record, sim, off: true }).why[0], /off/);
    const now = Date.parse("2026-10-06T12:00:00Z");
    assert.ok(held({ auto: { hold_until: "2026-10-06T15:00:00Z" } }, now));
    assert.ok(!held({ auto: { hold_until: "2026-10-06T11:00:00Z" } }, now), "hold over");
    assert.ok(!held({ auto: { hold_until: "2026-10-06T15:00:00Z", stopped: "x" } }, now));
    assert.ok(!held({}, now));
    console.log("autoapprove ok");
    process.exit(0);
  }
  if (cmd === "check" && key) {
    const e = evaluate(key, { near_duplicate: false, share: 0 });
    console.log(e.ok ? `${key}: would auto-approve (similarity assumed clean)` : `${key}: comes to you, because\n- ${e.why.join("\n- ")}`);
  } else console.log("usage: node scripts/autoapprove.mjs check <key> | test");
}
