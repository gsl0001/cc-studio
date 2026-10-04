// The WeekPlan contract: one per account per week. The generation pipeline, the
// dashboard and the queue read this shape, so it changes only on purpose.
export const STATUSES = ["planned", "invalid", "rendered", "blocked", "approved", "rejected", "queued", "posted"];

const POST_FIELDS = {
  key: "string", day: "string", post_at: "string", time_reason: "string", pillar: "string",
  format: "string", hook: "object", script: "array", duration_s: "number", caption: "string",
  hashtags: "array", search_keywords: "array", cta: "string", sound: "string", is_aigc: "boolean",
  references: "array", rationale: "string", backups: "array", status: "string",
};
const typeOf = (v) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);

export function validateShape(plan) {
  const errors = [];
  for (const f of ["account", "project", "platform", "week", "generated_at"]) {
    if (typeof plan?.[f] !== "string") errors.push(`${f} missing`);
  }
  for (const f of ["style", "brief", "experiment"]) {
    if (typeOf(plan?.[f]) !== "object") errors.push(`${f} missing`);
  }
  if (!Array.isArray(plan?.posts)) return [...errors, "posts missing"];
  plan.posts.forEach((p, i) => errors.push(...postShapeErrors(p).map((e) => `posts[${i}] ${e}`)));
  return errors;
}

export function postShapeErrors(p) {
  const errors = [];
  for (const [f, t] of Object.entries(POST_FIELDS)) {
    if (typeOf(p?.[f]) !== t) errors.push(`${f} should be ${t}`);
  }
  if (typeOf(p?.hook) === "object" && (typeof p.hook.text !== "string" || typeof p.hook.first_frame_motion !== "string")) {
    errors.push("hook needs text and first_frame_motion");
  }
  if (!["control", "variant", null].includes(p?.experiment_arm ?? null)) errors.push("experiment_arm must be control, variant or null");
  if (typeof p?.day === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(p.day)) errors.push("day must be YYYY-MM-DD");
  if (typeof p?.post_at === "string" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(p.post_at)) errors.push("post_at must be HH:MM");
  if (typeof p?.status === "string" && !STATUSES.includes(p.status)) errors.push(`status ${p.status} unknown`);
  return errors;
}

// The plan covers the Monday–Sunday after `from` (a Monday plans the following week).
export function nextWeek(from = new Date()) {
  const d = new Date(Date.UTC(from.getFullYear(), from.getMonth(), from.getDate()));
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  const days = Array.from({ length: 7 }, (_, i) => new Date(d.getTime() + i * 86_400_000).toISOString().slice(0, 10));
  return { id: isoWeekId(d), days };
}

// ISO-8601 week id of a UTC date: the week's Thursday decides the year.
export function isoWeekId(date) {
  const t = new Date(date);
  t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7));
  const jan4 = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t - jan4) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
