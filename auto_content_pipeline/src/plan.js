// Planning: one call per style group writes the whole week for every account in it,
// so siblings are planned side by side and kept apart. Code stamps identity, keys and
// status afterwards — the model is never trusted for those.
import { existsSync, readFileSync } from "node:fs";
import { config, rootPath } from "../../src/config.js";
import { askClaude } from "./llm.js";
import { GAP_MINUTES, MAX_HASHTAGS, MAX_SAME, MAX_FORMAT } from "./validate.js";

// The shared content guidelines and the account facts (paths in studio.config.json):
// one copy each, read by every content generator. A missing CONTEXT.md is just empty.
const EMPTY = { context: "# Account context\n\nNo account facts yet (${config.paths.context} is missing). Rely on the profiles and the data in the brief.\n", guidelines: "# Content guidelines\n\n(none)\n" };
const agentDoc = (name) => { const f = rootPath(config.paths[name]); return existsSync(f) ? readFileSync(f, "utf8") : EMPTY[name]; };

const EXAMPLE_POST = {
  day: "YYYY-MM-DD", post_at: "HH:MM", time_reason: "which data picked this time", pillar: "the feature or theme", format: "...",
  visual: "the ONE primary screen, footage or real-world scene this post is built on",
  hook_type: "specific stakes | pain question | category reframe | numbered roundup | direct callout | other",
  hook: { text: "on-screen payoff text for second 1", first_frame_motion: "what is moving in the first frame" },
  script: [{ start: 0, end: 2, visual: "...", voiceover: "...", overlay: "..." }],
  duration_s: 15, caption: "...", hashtags: ["#..."], search_keywords: ["..."], cta: "...",
  sound: "trending sound name + URL + why, or original voiceover", trend: "the trends_to_leverage name this post rides, or null", is_aigc: false, references: ["https://..."],
  rationale: "the brief number, trend or competitor post behind this", experiment_arm: "control or variant",
  backups: [{ hook: "...", angle: "...", caption: "..." }, { hook: "...", angle: "...", caption: "..." }],
};

function contextBlock({ accounts, projects, briefs, research, styles, recentHooks, busy, recentPosts = [], experiments = [], inventory = {}, scorecard = "" }) {
  const brands = [...new Set(accounts.map((a) => a.project))];
  return `${agentDoc("guidelines")}

${agentDoc("context")}

BRANDS:
${brands.map((pid) => JSON.stringify({ ...projects.get(pid), accounts: undefined }, null, 2)).join("\n")}

ACCOUNTS (style + facts from TikTok Studio):
${JSON.stringify(accounts.map((a) => ({ id: a.id, brand: a.project, handle: a.handle, style: styles[a.id] ?? null, brief: briefs[a.id] })), null, 2)}

RESEARCH PER BRAND (target markets, competitors' best recent posts, trends, sounds and trends to leverage):
${JSON.stringify(Object.fromEntries(brands.map((pid) => [pid, research[pid] ? { discovery: research[pid].discovery, trends: research[pid].trends, summary: research[pid].summary, competitor_posts: research[pid].competitors?.posts } : null])), null, 2)}

RECENT HOOKS — never reuse or closely rephrase:
${recentHooks.length ? recentHooks.map((h) => `- ${h}`).join("\n") : "(none)"}

RECENT POSTS (last 2 weeks; this week must look different: new visuals, other formats and pillars):
${recentPosts.length ? recentPosts.map((r) => `- ${r.account} ${r.day} | ${r.format} | ${r.pillar} | visual: ${r.visual ?? "?"} | "${r.hook}"`).join("\n") : "(none)"}

LAST EXPERIMENTS AND RESULTS (build on these; never rerun a test that already has a winner):
${experiments.length ? experiments.map((e) => `- ${e.account} ${e.week}: "${e.hypothesis}" (control: ${e.control_desc}; variant: ${e.variant_desc}) -> control ${e.control.avg_views ?? "?"} avg views (n=${e.control.n}), variant ${e.variant.avg_views ?? "?"} (n=${e.variant.n}): ${e.verdict}`).join("\n") : "(none yet)"}

SCORECARD (views in each post's first 48 hours against its account's median; DROPPED is refused in code, WINNERs get at least 3 posts this week):
${scorecard || "(no scores yet)"}

REAL SCREENS AND FOOTAGE PER BRAND (visuals should come from these or from scenes the creator can film or build; the creator never invents app UI; prefer the [unused] ones, and avoid anything used in the last two weeks):
${Object.entries(inventory).map(([pid, files]) => `${pid}: ${files.length ? files.join(", ") : "(none listed)"}`).join("\n") || "(none)"}

BUSY SLOTS — other accounts already post at these times:
${busy.length ? busy.map((b) => `- ${b.day} ${b.post_at} (${b.key})`).join("\n") : "(none)"}`;
}

function rulesBlock({ accounts, projects }) {
  const brands = [...new Set(accounts.map((a) => a.project))].map((pid) => projects.get(pid));
  return `RULES:
- Language: ${brands.map((p) => `${p.id}: ${p.language_note}`).join(" | ")}
- Claims: ${brands.map((p) => (p.approved_claims ? `${p.id} may only claim its approved_claims (rephrasing is fine)` : `${p.id}: every fact verifiably true for the stated audience`)).join("; ")}. NEVER use a forbidden_claim.
- Duration: ${brands.map((p) => `${p.id} ${p.content.preferred_duration_seconds[0]}-${p.content.preferred_duration_seconds[1]}s`).join(", ")}.
- post_at is local HH:MM (America/Los_Angeles). Pick it from the account's best_post_hours and audience_peak_hours and say why in time_reason. Any two posts on the same day — across every account here AND the busy slots — must be at least ${GAP_MINUTES} minutes apart.
- Each account follows its own style and stays clearly different from its siblings: different angles, hooks and formats on the same day.
- Spread the product across the week: each account's posts cover at least 4 different features, screens or real-world scenes, and no two posts in this plan (any account) are built on the same screen or demo. Name the feature/screen in "pillar".
- Retention decides distribution. Second 1 opens mid-motion with the payoff as overlay text; never a logo, title card, brand name or static screen. No two posts in this plan share a hook.
- 3-${MAX_HASHTAGS} hashtags: trending ones from research when they fit, plus niche and brand tags. 2-4 search_keywords taken from the brief's search terms and what the target customers search.
- sound: a sound from the research summary's sounds when it fits the post (name + URL), otherwise "original voiceover". Only use a sound whose business_safe is true unless the account is known to be a personal account.
- trend: where one of the research summary's trends_to_leverage fits an account, build at least one post that week on it (before its use_by date) and name it in trend; null otherwise. Never force a trend onto a post it doesn't fit.
- references: only URLs that appear in RESEARCH; [] if none.
- Distinct posts (checked in code; a failing post is sent back): every post names its "visual", the ONE primary screen, footage or scene it is built on. No two posts in this plan (any account) share a visual, and none reuses a visual from RECENT POSTS. Name a visual by its file from REAL SCREENS AND FOOTAGE when it is one (files are compared by name), otherwise describe the scene. Per account, at most ${MAX_FORMAT} posts share a format family and at most ${MAX_SAME} share a pillar (compared by the part before any ":" or "("). Vary the layout too: full-bleed footage, split screen, before/after, list, POV, kinetic type, talking head, screen demo.
- Experiments, always: every account runs exactly ONE experiment this week that changes a single variable (hook type, format, length, first-frame motion, CTA, posting time, sound, caption style...). Fill experiment with hypothesis, control, variant and a measurable success_metric (e.g. "avg views", "3s hold"). Every post sets experiment_arm "control" or "variant", alternating day by day, with at least 2 posts in each arm. Use LAST EXPERIMENTS: keep a winner as the new default and test something new; repeat an inconclusive test only with a sharper difference.
- hook_type: which of the GUIDELINES hook types the hook is (exactly one of the names in the example), so the scorecard can rank them.
- Scorecard: never plan a DROPPED format or hook type for that account; give each WINNER at least 3 of the account's posts this week (it may also be the experiment's control).
- is_aigc: true when the video will show realistic AI-generated people or scenes or a cloned real voice; false for TTS over real footage, screen recordings or motion graphics. When unsure, true.
- backups: exactly 2 alternates with a different angle each.
- rationale: cite the data behind the post.`;
}

export function planPrompt(ctx) {
  const { accounts, days } = ctx;
  return `You are the content strategist for ${accounts.length} TikTok account(s), planning ${days[0]} to ${days[days.length - 1]}.

${contextBlock(ctx)}

TASK: for EVERY account above, plan exactly one post for EVERY one of these days: ${days.join(", ")}.

${rulesBlock(ctx)}

Respond with ONLY JSON:
{"plans":[{"account":"<account id>",
  "style":{"group":"...","pillar":"...","voice":"...","formats":["..."],"differentiator":"..."},
  "brief":{"audience":"one line","best_hours":["HH:MM"],"what_worked":"...","what_failed":"...","target_search_terms":["..."]},
  "experiment":{"hypothesis":"...","control":"...","variant":"...","success_metric":"..."},
  "posts":[${JSON.stringify(EXAMPLE_POST)}]}]}`;
}

export function repairPrompt(ctx, gaps) {
  const keep = ctx.plans.filter((p) => ctx.accounts.some((a) => a.id === p.account))
    .flatMap((p) => p.posts.filter((x) => x.status !== "invalid").map((x) => `- ${p.account} ${x.day} ${x.post_at}: ${x.hook.text} | format: ${x.format} | pillar: ${x.pillar} | visual: ${x.visual} | arm: ${x.experiment_arm}`));
  return `You planned a TikTok week; some posts failed validation. Write ONE replacement post for each gap below.

${contextBlock(ctx)}

POSTS ALREADY ACCEPTED (your replacements must not reuse their hooks, visuals or times, and must keep each account's format/pillar caps and experiment arms balanced):
${keep.join("\n") || "(none)"}

GAPS TO FILL (account, day, why the previous attempt failed):
${gaps.map((g) => `- ${g.account} ${g.day}: ${g.reasons.join("; ")}`).join("\n")}

${rulesBlock(ctx)}

Respond with ONLY JSON: {"posts":[{"account":"<account id>", ...one post object shaped like ${JSON.stringify(EXAMPLE_POST)}}]}`;
}

// Identity, keys and status come from the registry and the calendar, never the model.
export function stampPlan(raw, { account, week, style = null, now = new Date() }) {
  return {
    ...raw,
    account: account.id, project: account.project, platform: account.platform, handle: account.handle ?? null,
    week, generated_at: now.toISOString(),
    style: style ?? raw.style ?? {}, brief: raw.brief ?? {}, experiment: raw.experiment ?? {},
    posts: (raw.posts ?? []).map((p) => ({ ...p, key: `${account.id}-${p.day}-001`, status: "planned", experiment_arm: p.experiment_arm ?? null })),
  };
}

export function planGroup(ctx) {
  const { data, model } = askClaude(planPrompt(ctx));
  const byId = new Map((data.plans ?? []).map((p) => [p.account, p]));
  return { model, plans: ctx.accounts.map((a) => stampPlan(byId.get(a.id) ?? { posts: [] }, { account: a, week: ctx.week, style: ctx.styles[a.id] })) };
}

export function repairGroup(ctx, gaps) {
  const { data, model } = askClaude(repairPrompt(ctx, gaps));
  return { model, posts: data.posts ?? [] };
}

// Repaired posts replace the invalid post on their day (or fill an empty day); a day
// that already has a valid post is never overwritten.
export function mergeRepairs(plans, posts) {
  return plans.map((plan) => {
    const next = [...plan.posts];
    for (const { account, ...p } of posts.filter((x) => x.account === plan.account)) {
      if (next.some((x) => x.day === p.day && x.status !== "invalid")) continue;
      const post = { ...p, key: `${plan.account}-${p.day}-001`, status: "planned", experiment_arm: p.experiment_arm ?? null, repaired: true };
      const i = next.findIndex((x) => x.day === p.day);
      if (i >= 0) next[i] = post; else next.push(post);
    }
    return { ...plan, posts: next.sort((a, b) => String(a.day).localeCompare(String(b.day))) };
  });
}

// A plan that came back without a complete experiment or balanced arms: ask for just that.
export function experimentPrompt(ctx, plans, problems) {
  return `You planned these TikTok weeks, but some accounts' experiments are incomplete. Fix only the experiments.

${rulesBlock(ctx)}

LAST EXPERIMENTS AND RESULTS:
${(ctx.experiments ?? []).map((e) => `- ${e.account} ${e.week}: "${e.hypothesis}" -> ${e.verdict}`).join("\n") || "(none yet)"}

PLANS TO FIX (account, problems, then its posts as day | format | hook):
${plans.map((p) => `## ${p.account}: ${problems[p.account].join("; ")}\n${p.posts.filter((x) => x.status !== "invalid").map((x) => `- ${x.day} | ${x.format} | ${x.hook?.text}`).join("\n")}`).join("\n\n")}

For each account give ONE single-variable experiment that its posts can actually test, and assign every listed day to "control" or "variant" (at least 2 each, alternating where you can).
Respond with ONLY JSON: {"experiments":[{"account":"<id>","experiment":{"hypothesis":"...","control":"...","variant":"...","success_metric":"..."},"arms":{"YYYY-MM-DD":"control"}}]}`;
}

export function repairExperiments(ctx, plans, problems) {
  const { data, model } = askClaude(experimentPrompt(ctx, plans, problems));
  const fix = new Map((data.experiments ?? []).map((e) => [e.account, e]));
  return { model, plans: plans.map((p) => {
    const f = fix.get(p.account);
    if (!f) return p;
    return { ...p, experiment: f.experiment ?? p.experiment,
      posts: p.posts.map((x) => (["control", "variant"].includes(f.arms?.[x.day]) ? { ...x, experiment_arm: f.arms[x.day] } : x)) };
  }) };
}
