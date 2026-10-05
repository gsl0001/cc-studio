// node auto_content_pipeline/tests/weekly.test.mjs   (from the repo root)
// Unit checks for the weekly strategist's code-only stages. AI stages are not unit
// tested; their output always passes through validate.js.
import assert from "node:assert";
import { validateShape, postShapeErrors, nextWeek, isoWeekId } from "../src/schema.js";

export const goodPost = (over = {}) => ({
  key: "mybrand-tiktok-2026-10-05-001", day: "2026-10-05", post_at: "18:00",
  time_reason: "audience peak", pillar: "demo", format: "screen-recording + voiceover",
  hook: { text: "Your taskbar is lying to you", first_frame_motion: "cursor flicks across a cluttered taskbar" },
  script: [{ start: 0, end: 2, visual: "cluttered taskbar", voiceover: "Stop hunting apps", overlay: "Stop hunting apps" }],
  duration_s: 12, caption: "One flick, every app. #windows", hashtags: ["#windows", "#productivity"],
  search_keywords: ["offline notes app"], cta: "Try MyBrand — link in bio", sound: "original voiceover",
  is_aigc: false, references: [], rationale: "top post pattern", experiment_arm: "control", visual: "cluttered taskbar recording",
  backups: [{ hook: "b1", angle: "a1", caption: "c1" }, { hook: "b2", angle: "a2", caption: "c2" }],
  status: "planned", ...over,
});
export const goodPlan = (over = {}) => ({
  account: "mybrand-tiktok", project: "mybrand", platform: "tiktok", handle: "mybrand.notes",
  week: "2026-W41", generated_at: "2026-10-03T19:00:00Z",
  style: { group: "mybrand", pillar: "demos", voice: "calm", formats: ["demo"], differentiator: "x" },
  brief: {}, experiment: { hypothesis: "h", control: "c", variant: "v", success_metric: "avg watch" },
  posts: [goodPost()], ...over,
});

// --- schema
assert.deepStrictEqual(validateShape(goodPlan()), []);
assert.ok(validateShape(goodPlan({ posts: undefined })).includes("posts missing"));
assert.ok(postShapeErrors(goodPost({ caption: 5 })).some((e) => e.startsWith("caption")));
assert.ok(postShapeErrors(goodPost({ post_at: "6pm" })).some((e) => e.includes("HH:MM")));
assert.ok(postShapeErrors(goodPost({ hook: { text: "x" } })).some((e) => e.includes("first_frame_motion")));
assert.ok(postShapeErrors(goodPost({ experiment_arm: "maybe" })).length > 0);
assert.ok(postShapeErrors(goodPost({ status: "done" })).length > 0);
const w = nextWeek(new Date(2026, 9, 3)); // Saturday 2026-10-03
assert.strictEqual(w.id, "2026-W41");
assert.strictEqual(w.days[0], "2026-10-05");
assert.strictEqual(w.days[6], "2026-10-11");
assert.strictEqual(nextWeek(new Date(2026, 9, 5)).days[0], "2026-10-12", "a Monday plans the following week");
assert.strictEqual(isoWeekId(new Date("2026-12-28T00:00:00Z")), "2026-W53");
console.log("schema ok");

// --- brief
import { briefFrom, dropOff } from "../src/brief.js";
const at = (d, h) => new Date(2026, 8, d, h, 0).toISOString(); // local hour h on 2026-09-d
const post = (d, h, views, extra = {}) => ({ at: at(d, h), caption: `post ${d}`, views, ...extra });
const brief = briefFrom({
  account: "mybrand-tiktok",
  now: new Date(2026, 8, 30),
  snapshots: [
    { followers: 30, views_28d: 6709, age: { "25-34": 0.49, "18-24": 0.29 }, gender: { Male: 0.7, Female: 0.3 },
      locations: [{ country: "CA", pct: 0.5, cities: { Surrey: 0.4, Other: 0.6 } }],
      traffic: { "For You": 0.8 }, search_terms: { "mybrand app": 0.5, "study notes": 0.2 },
      active_hours: Array.from({ length: 24 }, (_, h) => (h === 9 ? 90 : h === 14 ? 80 : h === 20 ? 70 : 10)),
      also_watched_creators: [{ handle: "carterpcs", followers: 7e6 }] },
    { followers: 27 },
  ],
  posts: [
    post(28, 18, 900, { avg_watch_s: 3.2, retention: [[0, 1], [1, 0.6], [2, 0.4]], traffic: { "For You": 0.9 } }),
    post(27, 18, 700), post(26, 11, 50), post(25, 11, 70), post(24, 9, 400), post(1, 18, 5000), // 09-01 is >28 days old
  ],
  recentHooks: ["old hook"],
});
assert.strictEqual(brief.followers, 30);
assert.strictEqual(brief.follower_delta, 3);
assert.deepStrictEqual(brief.audience_peak_hours, [9, 14, 20]);
assert.deepStrictEqual(brief.best_post_hours[0], { hour: 18, avg_views: 2200, posts: 3 }, "60-day window includes 09-01");
assert.strictEqual(brief.top_posts[0].views, 900, "top posts use the 28-day window only");
assert.strictEqual(brief.top_posts[0].drop_off_s, 2);
assert.strictEqual(brief.bottom_posts[0].views, 50);
assert.deepStrictEqual(brief.search_terms, ["mybrand app", "study notes"]);
assert.deepStrictEqual(brief.also_watched, ["carterpcs"]);
assert.strictEqual(brief.audience.cities[0].city, "Surrey, CA");
assert.strictEqual(dropOff(null), null);
const gappy = briefFrom({ account: "x", now: new Date(2026, 8, 30), posts: [], recentHooks: [],
  snapshots: [{ followers: 987, locations: null }, { followers: 980, locations: [{ country: "PH", pct: 0.44, cities: null }] }] });
assert.strictEqual(gappy.audience.countries[0].country, "PH", "a field TikTok skipped this week falls back to last week's");
assert.strictEqual(gappy.follower_delta, 7);
console.log("brief ok");

// --- validate
import { validateWeek, experimentProblems, family, visualId, GAP_MINUTES, MAX_SAME, MAX_FORMAT } from "../src/validate.js";
const projects = new Map([["mybrand", { forbidden_claims: ["guaranteed"], content: { preferred_duration_seconds: [8, 20] } }]]);
const days = ["2026-10-05", "2026-10-06"];
const vctx = { projects, recentHooks: ["Old hook!"], days };
const run = (posts, extra = {}) => validateWeek([goodPlan({ posts })], { ...vctx, ...extra });

const second = (over = {}) => goodPost({ key: "mybrand-tiktok-2026-10-06-001", day: "2026-10-06", hook: { text: "Second hook", first_frame_motion: "m" },
  visual: "settings screen", experiment_arm: "variant", ...over });
let r = run([goodPost(), second()]);
assert.deepStrictEqual(r.invalid, [], "a good week passes");
assert.deepStrictEqual(r.gaps, []);
r = run([goodPost({ caption: "Guaranteed faster PC" })]);
assert.ok(r.invalid[0].reasons[0].includes("forbidden claim"));
assert.strictEqual(r.plans[0].posts[0].status, "invalid");
r = run([goodPost({ hook: { text: "old hook", first_frame_motion: "m" } })]);
assert.ok(r.invalid[0].reasons.some((x) => x.includes("recent hook")), "hook repeat is case/punctuation blind");
r = run([goodPost(), goodPost({ key: "k2", hook: { text: "Other", first_frame_motion: "m" } })]);
assert.ok(r.invalid[0].reasons.some((x) => x.includes("second post on")));
r = run([goodPost({ hashtags: Array(9).fill("#x") })]);
assert.ok(r.invalid[0].reasons.some((x) => x.includes("hashtags")));
r = run([goodPost({ duration_s: 45 })]);
assert.ok(r.invalid[0].reasons.some((x) => x.includes("duration")));
r = validateWeek([goodPlan(), goodPlan({ account: "mybrand-desk-tiktok", posts: [goodPost({ key: "mybrand-desk-tiktok-2026-10-05-001", post_at: "18:30", hook: { text: "Sibling", first_frame_motion: "m" }, visual: "other" })] })], vctx);
assert.ok(r.invalid[0].reasons.some((x) => x.includes(`${GAP_MINUTES} min`)), "siblings 30 min apart clash");
assert.ok(r.gaps.some((g) => g.account === "mybrand-desk-tiktok" && g.day === "2026-10-05"));
assert.ok(r.gaps.some((g) => g.account === "mybrand-tiktok" && g.day === "2026-10-06" && g.reasons[0] === "no post planned"));
// a fixed posting time (profile post_time) overrides the model's pick and the spacing rule
r = validateWeek([goodPlan(), goodPlan({ account: "mybrand-desk-tiktok", posts: [goodPost({ key: "mybrand-desk-tiktok-2026-10-05-001", post_at: "18:30", hook: { text: "Sibling", first_frame_motion: "m" }, visual: "other" })] })],
  { ...vctx, pinned: new Map([["mybrand-tiktok", "17:00"], ["mybrand-desk-tiktok", "17:00"]]) });
assert.strictEqual(r.invalid.length, 0, "pinned siblings at one time are fine");
assert.deepStrictEqual(r.plans.flatMap((p) => p.posts.map((x) => x.post_at)), ["17:00", "17:00"]);
// distinctiveness and experiments
r = run([goodPost(), second({ visual: "Cluttered taskbar recording!" })]);
assert.ok(r.invalid[0].reasons.some((x) => x.includes("already used by mybrand-tiktok-2026-10-05-001")), "a visual repeats across the plan, wording-blind");
r = run([goodPost({ visual: "settings screen" })], { recentVisuals: ["Settings screen"] });
assert.ok(r.invalid[0].reasons.some((x) => x.includes("a recent post")), "a visual from recent weeks is refused");
r = run([goodPost({ visual: "" })]);
assert.ok(r.invalid[0].reasons.some((x) => x.includes("visual missing")));
r = run([goodPost({ experiment_arm: null })]);
assert.ok(r.invalid[0].reasons.some((x) => x.includes("experiment_arm")), "every post is in an arm");
const days5 = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"];
const five = (over) => days5.map((d, i) => goodPost({ key: `mybrand-tiktok-${d}-001`, day: d, visual: `v${i}`,
  hook: { text: `hook ${i}`, first_frame_motion: "m" }, format: `f${i}`, pillar: `p${i}`, ...over(i) }));
r = validateWeek([goodPlan({ posts: five((i) => ({ pillar: ["Tagging: on site", "tagging (offline)", "Tagging"][i] ?? `p${i}` })) })], { ...vctx, days: days5 });
assert.deepStrictEqual(r.invalid.map((x) => x.key), ["mybrand-tiktok-2026-10-07-001"], `a third post in one pillar family is refused (max ${MAX_SAME})`);
r = validateWeek([goodPlan({ posts: five(() => ({ format: "feature_demo: something" })) })], { ...vctx, days: days5 });
assert.deepStrictEqual(r.invalid.map((x) => x.key), ["mybrand-tiktok-2026-10-09-001"], `a fifth post in one format family is refused (max ${MAX_FORMAT})`);
r = run([goodPost({ visual: "assets/ui/02-Camera.png full screen" }), second({ visual: "the 02-camera.PNG screen again" })]);
assert.ok(r.invalid[0]?.reasons.some((x) => x.includes("already used")), "a file-named visual is compared by file name");
assert.strictEqual(family("Feature_demo: tag filter"), "feature demo");
assert.strictEqual(visualId("assets/images/04-CrewClock.png"), "04-crewclock.png");
assert.deepStrictEqual(experimentProblems(goodPlan({ posts: [goodPost(), second()] })), ["only 1 valid post(s) in the control arm (need 2)", "only 1 valid post(s) in the variant arm (need 2)"]);
assert.ok(experimentProblems(goodPlan({ experiment: { hypothesis: "h" }, posts: [] })).includes("experiment.success_metric missing"));
import { readExperiment } from "../src/brief.js";
const ex = readExperiment({ hypothesis: "h" }, [{ experiment_arm: "control", views: 100 }, { experiment_arm: "control", views: 300 },
  { experiment_arm: "variant", views: 300 }, { experiment_arm: "variant", views: 500 }, { experiment_arm: "variant", views: null }]);
assert.deepStrictEqual([ex.control.avg_views, ex.variant.avg_views, ex.variant.n, ex.verdict], [200, 400, 2, "variant won on views"]);
assert.strictEqual(readExperiment({}, [{ experiment_arm: "control", views: 9 }]).verdict, "not enough measured posts yet");
const hold = readExperiment({ success_metric: "3s hold" }, [{ experiment_arm: "control", views: 900, watch: 2 }, { experiment_arm: "control", views: 900, watch: 2 },
  { experiment_arm: "variant", views: 100, watch: 3 }, { experiment_arm: "variant", views: 100, watch: 3 }]);
assert.strictEqual(hold.verdict, "variant won on watch time", "a hold experiment is judged on watch time, not views");
console.log("validate ok");

// --- llm
import { parseJson } from "../src/llm.js";
assert.deepStrictEqual(parseJson('Here you go:\n```json\n{"a":[1,2,],}\n```'), { a: [1, 2] }, "fence and trailing commas");
assert.deepStrictEqual(parseJson('{"a":"b"}'), { a: "b" });
assert.throws(() => parseJson("no json here"));
assert.deepStrictEqual(parseJson('{"s":{"a":"}{"}}\nNote: {braces} in prose after the JSON'), { s: { a: "}{" } },
  "stops at the balanced end, ignores braces in strings and trailing prose");
assert.deepStrictEqual(parseJson('Plan for {account}: {"plans":[]}'), { plans: [] }, "a brace in prose before the JSON is skipped");
console.log("llm ok");

// --- research
import { competitorCards, discoveryPrompt, parseTrendRows, soundBoard, summaryPrompt } from "../src/research.js";
assert.deepStrictEqual(
  parseTrendRows("Rank\nHashtag\n1\n#zachbryan\nNews & Entertainment\n5.2K\nPosts\n14.9M\nViews\nSee analytics\n2\n#uspolitics\n1.6K\nPosts\n2.3M\nViews", "CA"),
  [{ country: "CA", tag: "#zachbryan", posts: "5.2K", views: "14.9M" }, { country: "CA", tag: "#uspolitics", posts: "1.6K", views: "2.3M" }]);
const now = new Date("2026-10-03T12:00:00Z");
const item = (id, daysAgo, plays) => ({ id, desc: `v${id}`, createTime: Math.floor((now - daysAgo * 86_400_000) / 1000),
  stats: { playCount: plays, diggCount: 1, commentCount: 0, shareCount: 0 } });
const cards = competitorCards("rival", [item("1", 2, 100), item("2", 20, 9999), item("3", 5, 500)], now);
assert.deepStrictEqual(cards.map((c) => c.views), [500, 100], "last 14 days only, most viewed first");
assert.strictEqual(cards[0].url, "https://www.tiktok.com/@rival/video/3");
assert.strictEqual(cards[0].sound, null, "a video without music data has no sound");
const vid = (views, id, original) => ({ url: `u${views}`, views, sound: { id, title: `s${id}`, author: "a", original } });
const board = soundBoard([vid(10, "voice", true), vid(50, "song", false), vid(5, "viral", true), vid(7, "viral", true), vid(900, "hit", false)]);
assert.deepStrictEqual(board.map((s) => s.id), ["viral", "hit", "song"], "recurring sounds first, then views; one-off voiceovers dropped");
assert.deepStrictEqual([board[0].uses, board[0].views, board[0].examples], [2, 12, ["u5", "u7"]]);
assert.ok(board[0].url.endsWith("-viral"));
const sp = summaryPrompt({ project: { id: "mybrand" }, briefs: [], discovery: {}, trends: {}, competitors: [],
  explore: [{ url: "https://x", views: 9, likes: 1 }], sounds: board, today: new Date("2026-10-03T12:00:00Z") });
assert.ok(sp.includes("2026-10-03") && sp.includes("trends_to_leverage") && sp.includes('"viral"') && !sp.includes('"likes"'));
const dp = discoveryPrompt({ project: { id: "acme", name: "Acme", accounts: [{ id: "x" }] },
  briefs: [{ account: "acme-shop-tiktok", followers: 2, audience: { countries: [{ country: "CA", pct: 0.5 }] }, search_terms: ["acme"], also_watched: ["a"] }],
  previous: null });
assert.ok(dp.includes("acme-shop-tiktok") && dp.includes("(first run)") && !dp.includes('"accounts"'));
console.log("research ok");

// --- styles
import { groupAccounts, applyStyles } from "../src/styles.js";
const accts = [{ id: "a", project: "mybrand" }, { id: "b", project: "mybrand" }, { id: "c", project: "acme" }];
const groups = groupAccounts(accts, { a: { group: "pc-tips" } });
assert.deepStrictEqual([...groups.keys()], ["pc-tips", "mybrand", "acme"]);
assert.deepStrictEqual(groups.get("mybrand").map((x) => x.id), ["b"]);
const profile = { id: "mybrand", accounts: [{ id: "a" }, { id: "b", style: { group: "old" } }] };
const n = applyStyles(profile, { a: { group: "g1" }, zz: { group: "nope" } });
assert.strictEqual(n, 1);
assert.deepStrictEqual(profile.accounts[0].style, { group: "g1" });
assert.deepStrictEqual(profile.accounts[1].style, { group: "old" }, "accounts not in the proposal keep their style");
console.log("styles ok");

// --- plan
import { planPrompt, stampPlan, mergeRepairs } from "../src/plan.js";
const acct = { id: "mybrand-tiktok", project: "mybrand", platform: "tiktok", handle: "mybrand.notes" };
const stamped = stampPlan({ account: "wrong", posts: [{ day: "2026-10-05", key: "bad", status: "posted" }] },
  { account: acct, week: "2026-W41", style: { group: "mybrand" }, now: new Date("2026-10-03T19:00:00Z") });
assert.strictEqual(stamped.account, "mybrand-tiktok", "identity comes from the registry, not the model");
assert.strictEqual(stamped.posts[0].key, "mybrand-tiktok-2026-10-05-001");
assert.strictEqual(stamped.posts[0].status, "planned");
assert.strictEqual(stamped.posts[0].experiment_arm, null);
assert.deepStrictEqual(stamped.style, { group: "mybrand" });
const pp = planPrompt({ accounts: [acct], projects: new Map([["mybrand", { id: "mybrand", language_note: "English", content: { preferred_duration_seconds: [8, 20] }, forbidden_claims: [], approved_claims: ["x"] }]]),
  briefs: { "mybrand-tiktok": { followers: 30 } }, research: {}, styles: {}, days: ["2026-10-05", "2026-10-06"],
  recentHooks: ["old"], busy: [{ day: "2026-10-05", post_at: "18:00", key: "other-2026-10-05-001" }] });
for (const s of ["mybrand-tiktok", "2026-10-05", "2026-10-06", "other-2026-10-05-001", "45 minutes",
  "# Content guidelines", "# Account context"]) assert.ok(pp.includes(s), `prompt mentions ${s}`);
const kept = { ...goodPost(), status: "planned" };
const bad = { ...goodPost({ key: "mybrand-tiktok-2026-10-06-001", day: "2026-10-06" }), status: "invalid", problems: ["x"] };
const merged = mergeRepairs([goodPlan({ posts: [kept, bad] })], [
  { account: "mybrand-tiktok", ...goodPost({ day: "2026-10-06", hook: { text: "Fixed", first_frame_motion: "m" } }) },
  { account: "mybrand-tiktok", ...goodPost({ day: "2026-10-05", hook: { text: "Must not replace a valid post", first_frame_motion: "m" } }) },
]);
assert.strictEqual(merged[0].posts.length, 2);
assert.strictEqual(merged[0].posts[1].hook.text, "Fixed");
assert.strictEqual(merged[0].posts[0].hook.text, kept.hook.text);
console.log("plan ok");

// --- calendar
import { renderCalendar } from "../src/calendar.js";
const html = renderCalendar({ week: "2026-W41", days: ["2026-10-05", "2026-10-06"], models: ["claude-opus-5-5"],
  research: { mybrand: { discovery: { markets: [{ code: "CA" }] }, errors: ["trends: down"], summary: { hashtags: ["#pc"],
    sounds: [{ name: "Hit song", url: "javascript:alert(1)", business_safe: false }],
    trends_to_leverage: [{ type: "event", name: "Halloween", how_to_use: "costume PC", evidence: "https://e.com", use_by: "2026-10-31" }] } } },
  plans: [goodPlan({ posts: [goodPost({ caption: "<script>x</script>" }),
    { ...goodPost({ key: "k2", day: "2026-10-06" }), status: "invalid", problems: ["hook repeats a recent hook"] }] })] });
assert.ok(html.includes("mybrand-tiktok") && html.includes("2026-W41"));
assert.ok(html.includes('class="post invalid"') && html.includes("hook repeats a recent hook"));
assert.ok(!html.includes("<script>x"), "captions are escaped");
assert.ok(html.includes("trends: down"));
assert.ok(html.includes('<a href="https://e.com">Halloween (event)</a>') && html.includes("use by 2026-10-31"));
assert.ok(html.includes("Hit song") && !html.includes("javascript:") && html.includes("not for business accounts"));
console.log("calendar ok");
