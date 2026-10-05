// Week validation: the brand and calendar rules every planned post must pass before
// it is written. Failing posts come back marked invalid with their reasons, and
// `gaps` lists each account-day that has no valid post (the repair pass targets these).
import { postShapeErrors } from "./schema.js";

export const GAP_MINUTES = 45; // the publisher's floor between two posts on one platform
export const MAX_HASHTAGS = 8;
export const MAX_SAME = 2;     // per account per week: the most posts sharing one pillar
export const MAX_FORMAT = 4;   // ...or one format (room for a format A/B test's arm)
// The family of a format or pillar: "feature_demo: tag filter" and "feature demo (no signal)"
// are both "feature demo" (2026-10-03 review: 5 feature demos passed as 5 formats).
export const family = (t) => norm(String(t ?? "").split(/[:(\[—–]| - /)[0].replace(/[_-]+/g, " "));
// A visual names a file from the brand's inventory or a scene; a file is compared by its name,
// so "assets/ui/02-Camera.png" and "the 02-Camera.png screen" are the same visual.
export const visualId = (v) => {
  const file = /([\w-]+\.(?:png|jpe?g|mp4|mov|webm))/i.exec(String(v ?? ""));
  return file ? file[1].toLowerCase() : norm(v);
};
const ARMS = ["control", "variant"];
export const norm = (t) => String(t ?? "").toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// Every piece of text a viewer sees or hears — the forbidden-claim check reads all of it.
export function postText(p) {
  return [p.hook?.text, p.caption, p.cta, ...(p.hashtags ?? []),
    ...(p.script ?? []).flatMap((s) => [s.overlay, s.voiceover])].join(" ").toLowerCase();
}

// plans: WeekPlan[] across brands. fixed: already-written plans for accounts not being
// replanned this run — they hold their times, hooks and visuals but are not re-checked.
// Distinctiveness is enforced here, not just asked for: every post names its one primary
// visual, and no visual repeats across this run or the last weeks (recentVisuals); one
// format or pillar carries at most MAX_SAME posts per account; every post is in an arm of
// the account's experiment.
// `pinned` maps an account to the posting time you fixed for it (profile post_time): its posts
// take that time whatever the model picked, and the spacing rule does not apply to them.
export function validateWeek(plans, { projects, recentHooks = [], recentVisuals = [], days, fixed = [], pinned = new Map() }) {
  const seenHooks = new Set(recentHooks.map(norm));
  const seenVisuals = new Map(recentVisuals.map((v) => [visualId(v), "a recent post"]));
  const taken = [];
  for (const p of fixed.flatMap((f) => f.posts).filter((p) => p.status !== "invalid")) {
    taken.push({ day: p.day, min: minutes(p.post_at), key: p.key });
    seenHooks.add(norm(p.hook?.text));
    if (p.visual) seenVisuals.set(visualId(p.visual), p.key);
  }
  const invalid = [], gaps = [];
  const out = plans.map((plan) => {
    const project = projects.get(plan.project);
    const [lo, hi] = project?.content?.preferred_duration_seconds ?? [0, Infinity];
    const valid = new Map(); // day -> key
    const failed = new Map(); // day -> reasons
    const formats = new Map(), pillars = new Map(); // norm -> count of valid posts
    const pin = pinned.get(plan.account);
    const posts = plan.posts.map((p) => {
      if (pin && p.post_at !== pin) p = { ...p, post_at: pin, time_reason: "your fixed posting time" };
      const reasons = postShapeErrors(p);
      if (!reasons.length) {
        const bad = (project?.forbidden_claims ?? []).find((c) => postText(p).includes(c.toLowerCase()));
        if (bad) reasons.push(`forbidden claim "${bad}"`);
        if (seenHooks.has(norm(p.hook.text))) reasons.push("hook repeats a recent hook");
        if (!days.includes(p.day)) reasons.push(`day ${p.day} is outside the week`);
        if (valid.has(p.day)) reasons.push(`second post on ${p.day}`);
        if (p.duration_s < lo || p.duration_s > hi) reasons.push(`duration ${p.duration_s}s outside ${lo}-${hi}s`);
        if (p.hashtags.length > MAX_HASHTAGS) reasons.push(`${p.hashtags.length} hashtags (max ${MAX_HASHTAGS})`);
        const clash = !pin && taken.find((t) => t.day === p.day && Math.abs(t.min - minutes(p.post_at)) < GAP_MINUTES);
        if (clash) reasons.push(`within ${GAP_MINUTES} min of ${clash.key}`);
        if (typeof p.visual !== "string" || !norm(p.visual)) reasons.push("visual missing: name the one primary screen, footage or scene");
        else if (seenVisuals.has(visualId(p.visual))) reasons.push(`visual "${p.visual}" already used by ${seenVisuals.get(visualId(p.visual))}: pick a different screen, footage or scene`);
        if ((formats.get(family(p.format)) ?? 0) >= MAX_FORMAT) reasons.push(`format "${family(p.format)}" already used ${MAX_FORMAT}x this week by this account`);
        if ((pillars.get(family(p.pillar)) ?? 0) >= MAX_SAME) reasons.push(`pillar "${family(p.pillar)}" already used ${MAX_SAME}x this week by this account`);
        if (!ARMS.includes(p.experiment_arm)) reasons.push('experiment_arm must be "control" or "variant"');
      }
      if (reasons.length) {
        invalid.push({ account: plan.account, key: p.key, reasons });
        if (typeof p.day === "string") failed.set(p.day, reasons);
        return { ...p, status: "invalid", problems: reasons };
      }
      seenHooks.add(norm(p.hook.text));
      seenVisuals.set(visualId(p.visual), p.key);
      formats.set(family(p.format), (formats.get(family(p.format)) ?? 0) + 1);
      pillars.set(family(p.pillar), (pillars.get(family(p.pillar)) ?? 0) + 1);
      valid.set(p.day, p.key);
      taken.push({ day: p.day, min: minutes(p.post_at), key: p.key });
      const { problems, ...clean } = p;
      return { ...clean, status: p.status === "invalid" ? "planned" : p.status };
    });
    for (const day of days) {
      if (!valid.has(day)) gaps.push({ account: plan.account, day, reasons: failed.get(day) ?? ["no post planned"] });
    }
    return { ...plan, posts };
  });
  return { plans: out, invalid, gaps };
}

// Plan-level: a complete experiment, and at least 2 valid posts in each arm.
export function experimentProblems(plan) {
  const e = plan.experiment ?? {};
  const out = ["hypothesis", "control", "variant", "success_metric"].filter((f) => typeof e[f] !== "string" || !e[f].trim()).map((f) => `experiment.${f} missing`);
  const valid = plan.posts.filter((p) => p.status !== "invalid");
  for (const arm of ARMS) {
    const n = valid.filter((p) => p.experiment_arm === arm).length;
    if (n < 2) out.push(`only ${n} valid post(s) in the ${arm} arm (need 2)`);
  }
  return out;
}
