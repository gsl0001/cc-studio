// Content strategist — decides one post's angle and script for one account,
// avoiding repetition, honouring the active experiment, never inventing claims.
//
//   npm run plan -- mybrand-tiktok        next free slot for that account
//   npm run plan -- mybrand-tiktok 2      slot #2 in the account's slot list
//
// Output: plans/<account>-<date>-<NNN>.json — the render step reads it, and the
// finished video is queued under the SAME key.
//
// Generation goes through the `claude` CLI (already authed on this machine); its
// exit code is recorded, because a silent usage-limit failure looked like success
// for a whole day on 2026-08-21.
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { db, log } from "./db.js";
import { loadRegistry, nextSlot } from "./registry.js";
import { model } from "./config.js";

const id = process.argv[2];
const slotArg = Number(process.argv[3] || 0);
const reg = loadRegistry();
const account = reg.accounts.find((a) => a.id === id);
if (!account) {
  console.error(`unknown account "${id ?? ""}". Try: ${reg.accounts.map((a) => a.id).join(", ")}`);
  process.exit(1);
}
const project = reg.projects.find((p) => p.id === account.project);
if (reg.errors.some((e) => e.startsWith(`${account.id}:`))) {
  console.error(`${account.id} has config errors — run: npm run registry`);
  process.exit(1);
}

// Which slot are we planning for? Default: the next free one for this account.
const slots = [...account.slots].sort();
const at = slotArg ? null : nextSlot(account, {
  taken: new Set(db.prepare("SELECT scheduled_for s FROM jobs WHERE account=? AND scheduled_for IS NOT NULL").all(account.id).map((r) => r.s)),
});
const date = at ? at.slice(0, 10) : new Date().toLocaleDateString("sv");
const seq = slotArg || (at ? slots.indexOf(at.slice(11, 16)) + 1 : 1);
const key = `${account.id}-${date}-${String(seq).padStart(3, "0")}`;
if (db.prepare("SELECT 1 FROM plans WHERE key=?").get(key)) {
  console.log(`${key} already planned — one plan per slot.`);
  process.exit(0);
}

// --- context: novelty across sibling accounts, performance for THIS account ----
const siblings = reg.accounts.filter((a) => a.project === account.project && a.platform === account.platform).map((a) => a.id);
const recent = db.prepare(`SELECT account, angle, hook FROM plans
                            WHERE account IN (SELECT value FROM json_each(?))
                            ORDER BY created_at DESC LIMIT 30`).all(JSON.stringify(siblings));
const perf = db.prepare(`
  SELECT p.angle, p.hook, j.status, m.views, m.likes, m.comments, m.shares,
         m.avg_watch_s, m.full_watch_pct, m.stop_at_s
    FROM jobs j
    LEFT JOIN plans   p ON p.key     = j.key
    LEFT JOIN metrics m ON m.job_key = j.key
   WHERE j.account = ? AND j.status IN ('SCHEDULED','PUBLISHED')
   ORDER BY j.updated_at DESC LIMIT 20`).all(account.id);
const experiment = db.prepare(`SELECT * FROM experiments WHERE status='active'
                                AND (project IS NULL OR project=?) ORDER BY id DESC LIMIT 1`).get(account.project);

// Retention is the distribution signal; views are the echo. Summarise it hard.
const ret = perf.filter((r) => r.avg_watch_s !== null && r.views > 0);
const avgWatch = ret.length ? (ret.reduce((t, r) => t + r.avg_watch_s, 0) / ret.length).toFixed(1) : null;
const retentionNote = avgWatch !== null
  ? `Aired posts on this account average ${avgWatch}s watch time. Every post where viewers stop at second 1 was a hook failure regardless of its view count.`
  : "No retention data yet — assume the first second decides everything.";

const kind = (project.type ?? "app") === "channel" ? "content channel growing a following" : "marketing pipeline";
const claimsRule = project.approved_claims
  ? "- Only claims from approved_claims may appear (rephrasing is fine). NEVER use forbidden_claims."
  : "- Every fact must be verifiably true and pitched for the stated audience — when unsure, cut it. NEVER use forbidden_claims.";
const prompt = `You are the content strategist for a daily ${account.platform === "instagram" ? "Instagram Reels" : "TikTok"} ${kind}.

ACCOUNT: ${account.id} (${account.handle ?? "?"}) — one post for the ${slots[seq - 1] ?? slots[0]} slot on ${date}.

PROJECT PROFILE:
${JSON.stringify({ ...project, accounts: undefined }, null, 2)}

RECENT POSTS ON THIS BRAND'S ${account.platform.toUpperCase()} ACCOUNTS (never repeat these hooks or angles two days running):
${recent.length ? recent.map((r) => `- [${r.account}] [${r.angle}] ${r.hook}`).join("\n") : "(none yet — this is the first post)"}

PERFORMANCE FOR THIS ACCOUNT (a post with null numbers aired but has no metrics yet):
${perf.length ? JSON.stringify(perf) : "(no performance data yet for this account — optimise for variety across the approved styles and a strong first second)"}

ACTIVE EXPERIMENT:
${experiment ? `${experiment.name}: ${experiment.hypothesis} (control: ${experiment.control}, variant: ${experiment.variant}) — alternate control/variant day by day.` : "(none)"}

RULES:
- Content language: ${project.language_note}
${claimsRule}
- Duration ${project.content.preferred_duration_seconds[0]}-${project.content.preferred_duration_seconds[1]} seconds.
- RETENTION IS THE ONLY SIGNAL THAT MATTERS. ${retentionNote}
  Hard first-second rules for scene 1 (0-1s): open mid-action with visible motion
  or change; the overlay text states the payoff in the viewer's language; NEVER
  a logo, title card, brand name, static app screen, or slow fade. Scene 1's
  "visual" must describe what is MOVING in the first frame.
- is_aigc: true when the video will show realistic AI-generated people/scenes or a cloned voice of a real person; false for generic TTS narration over real or stock footage, screen recordings, or plain motion graphics. Platforms strike unlabeled synthetic media — when unsure, true.
- Choose an angle from: ${project.content.preferred_styles.join(", ")}

Produce THREE distinct candidates — different angles or sharply different hooks,
not three phrasings of one idea. viral_score is your honest 0-10 rating of the
hook's stop-scrolling power (rate the first second, not the concept).

Respond with ONLY a JSON object, no markdown fence, in this exact shape:
{"candidates": [{
  "angle": "...",
  "hook": "...",
  "viral_score": 7,
  "hypothesis": "why this should work, one sentence",
  "duration_target": 12,
  "is_aigc": false,
  "scenes": [{"start":0,"end":2,"visual":"described shot or app screen","overlay":"on-screen text"}],
  "caption": "...",
  "hashtags": ["...","..."],
  "cta": "..."
}, {...}, {...}]}`;

log(key, "strategist_start", `account=${account.id} recent=${recent.length} perf=${perf.length} exp=${experiment?.name ?? "none"}`);

let raw;
try {
  // Prompt goes via stdin — passing it as a shell argument mangles quoting on Windows.
  raw = execFileSync("claude", ["-p", "--model", model("plan")], {
    input: prompt, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 180_000, shell: true,
  });
} catch (e) {
  const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  const quota = /(reached|hit) your .*limit|usage limit|session limit/i.test(out);
  log(key, "strategist_failed", `rc=${e.status}${quota ? " QUOTA" : ""} ${out.slice(-200).replace(/\s+/g, " ")}`);
  console.error(quota ? "claude CLI is out of quota — no plan written." : `claude CLI failed (rc=${e.status}).`);
  process.exit(1);
}

const jsonText = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
let parsed;
try { parsed = JSON.parse(jsonText); }
catch { parsed = JSON.parse(jsonText.replace(/,\s*([\}\]])/g, "$1")); } // ponytail: LLMs emit trailing commas; strip only when strict parse fails
const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [parsed];

// --- ranking (AutoViralAI-style): 0.4 self-rated viral + 0.3 pattern history +
// 0.3 novelty, plus an exploration bonus so accounts do not converge on one
// format. Pattern history = this account's normalised avg views per angle.
const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
const angleViews = new Map();
for (const r of perf) {
  if (r.angle && r.views > 0) angleViews.set(r.angle, [...(angleViews.get(r.angle) ?? []), r.views]);
}
const angleAvg = new Map([...angleViews].map(([a, v]) => [a, v.reduce((x, y) => x + y, 0) / v.length]));
const maxAvg = Math.max(1, ...angleAvg.values());
const recentHooks = recent.map((r) => r.hook).filter(Boolean).map(norm).slice(0, 20);
const overlap = (a, b) => {
  const A = new Set(a.split(" ")), B = new Set(b.split(" "));
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / Math.max(1, Math.min(A.size, B.size));
};
const scoreOf = (c) => {
  const viral = Math.min(10, Math.max(0, Number(c.viral_score) || 5)) / 10;
  const pattern = angleAvg.has(c.angle) ? angleAvg.get(c.angle) / maxAvg : 0.5;
  const novelty = 1 - Math.max(0, ...recentHooks.map((h) => overlap(norm(c.hook ?? ""), h)));
  const explore = angleAvg.size && !angleAvg.has(c.angle) ? 0.15 : 0;
  return 0.4 * viral + 0.3 * pattern + 0.3 * novelty + explore;
};

// --- guardrails: try candidates best-first; the first clean one wins ------------
const ranked = candidates.map((c) => ({ c, score: scoreOf(c) })).sort((a, b) => b.score - a.score);
let plan = null;
for (const { c, score } of ranked) {
  const allText = [c.hook, c.caption, c.cta, ...(c.hashtags ?? []),
                   ...(c.scenes ?? []).map((sc) => sc.overlay)].join(" ").toLowerCase();
  const bad = project.forbidden_claims.find((b) => allText.includes(b.toLowerCase()));
  if (bad) { log(key, "candidate_rejected", `forbidden claim "${bad}": ${c.hook}`); continue; }
  if (recentHooks.some((h) => h === norm(c.hook ?? ""))) {
    log(key, "candidate_rejected", `duplicate hook: ${c.hook}`); continue;
  }
  if (typeof c.is_aigc !== "boolean") { log(key, "candidate_rejected", `is_aigc missing: ${c.hook}`); continue; }
  plan = c;
  log(key, "candidate_chosen", `score=${score.toFixed(3)} of ${ranked.length} — ${c.angle}: ${c.hook}`);
  break;
}
if (!plan) {
  log(key, "strategist_rejected", `all ${ranked.length} candidate(s) failed guardrails`);
  console.error("REJECTED — every candidate hit a guardrail. Re-run.");
  process.exit(1);
}
mkdirSync("plans", { recursive: true });
const out = { key, account: account.id, app: account.project, platform: account.platform,
              date, slot: slots[seq - 1] ?? slots[0], experiment_id: experiment?.id ?? null, ...plan };
writeFileSync(`plans/${key}.json`, JSON.stringify(out, null, 2));
db.prepare(`INSERT INTO plans (key, app, account, slot, angle, hook, caption, experiment_id, plan_json)
            VALUES (?,?,?,?,?,?,?,?,?)`)
  .run(key, account.project, account.id, out.slot, plan.angle, plan.hook, plan.caption,
       experiment?.id ?? null, JSON.stringify(out));
log(key, "plan_created", `${plan.angle} — ${plan.hook}`);
console.log(`\nPlan written: plans/${key}.json  (slot ${out.slot} on ${date})`);
console.log(`Next: render it, then: npm run queue -- ${key} <path-to-final.mp4>`);
