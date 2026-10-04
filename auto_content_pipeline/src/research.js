// Brand research. The agent chooses target markets and competitors, the browser
// collects exact public numbers (Creative Center trends, competitors' recent posts),
// and the agent summarises what is working. Each stage is optional: a failure is
// recorded in `errors` and planning goes on; only a quota hit is rethrown.
import { askClaude } from "./llm.js";

const brandOnly = (project) => ({ ...project, accounts: undefined });
const briefDigest = (briefs) => briefs.map((b) => ({ account: b.account, followers: b.followers,
  countries: b.audience?.countries, search_terms: b.search_terms, also_watched: b.also_watched,
  top_posts: b.top_posts, bottom_posts: b.bottom_posts }));

export function discoveryPrompt({ project, briefs, previous }) {
  return `You are researching the TikTok market for one brand. Use web search to verify.

BRAND PROFILE:
${JSON.stringify(brandOnly(project), null, 2)}

OUR TIKTOK ACCOUNTS (facts from TikTok Studio):
${JSON.stringify(briefDigest(briefs), null, 2)}

LAST WEEK'S CHOICES:
${previous?.discovery ? JSON.stringify(previous.discovery) : "(first run)"}

Decide:
1. markets: 1-3 ISO country codes where this product's real customers are. This is NOT
   simply where today's audience is — ours may be off-market. Keep last week's choice
   unless there is a clear reason to change it.
2. competitors: 5-10 TikTok handles (no @) posting for the same customers — direct
   competitors and adjacent creators this audience watches. Only handles you verified exist.

Respond with ONLY JSON:
{"markets":[{"code":"CA","reason":"..."}],"competitors":[{"handle":"...","reason":"..."}]}`;
}

export function summaryPrompt({ project, briefs, discovery, trends, competitors, explore, sounds, today = new Date() }) {
  return `You are the research lead for a brand's TikTok accounts. Today is ${today.toISOString().slice(0, 10)}.
Summarise what is working right now and pick the trends this brand can ride in next week's
posts. Use web search to fill gaps: memes and formats going around this week, and dated
moments in the next 14 days (holidays, events, seasonal hooks) the target customers care about.

BRAND PROFILE:
${JSON.stringify(brandOnly(project), null, 2)}

OUR ACCOUNTS:
${JSON.stringify(briefDigest(briefs), null, 2)}

TARGET MARKETS AND COMPETITORS: ${JSON.stringify(discovery)}
TRENDING HASHTAGS IN TARGET MARKETS (TikTok Creative Center, last 7 days): ${JSON.stringify(trends)}
COMPETITORS' LAST 14 DAYS, MOST VIEWED FIRST (exact numbers): ${JSON.stringify(competitors)}
VIRAL ON TIKTOK EXPLORE RIGHT NOW (all niches, exact numbers): ${JSON.stringify((explore ?? []).map(({ likes, comments, shares, ...c }) => c))}
SOUNDS IN THOSE VIDEOS (uses = videos above using it): ${JSON.stringify(sounds)}

Rules:
- Trend gate. Classify each trend's stage: emerging (climbing, first 1-3 days: ride now),
  peaking (ride only with a strong twist), saturated or dead (skip). Recommend it only if
  all four hold: a viewer could tell why THIS brand did it, it is still climbing, its
  native structure can be honoured, and there is room for a twist. Fewer, better picks.
- sounds: only sounds from SOUNDS above or ones you verified are trending this week, with a
  real URL. Business accounts may only use TikTok's Commercial Music Library, so set
  business_safe to false for a licensed song, true for an original/voice sound or a
  Commercial Music Library track, "unknown" if you can't tell.
- evidence: a URL from the data above or from your search; never invent one.

Respond with ONLY JSON:
{"formats_working":["..."],
 "competitor_hooks":[{"handle":"...","hook":"...","views":0,"url":"..."}],
 "sounds":[{"name":"...","url":"...","why":"...","how_to_use":"...","business_safe":true}],
 "trends_to_leverage":[{"type":"meme|format|challenge|event|topic","stage":"emerging|peaking","name":"...","why_now":"...",
   "how_to_use":"one concrete post idea for this brand","evidence":"https://...","use_by":"YYYY-MM-DD or null"}],
 "hashtags":["#..."],
 "topics_to_avoid":["..."],
 "notes":"two sentences at most"}`;
}

// One public video as a planner-ready card, with the sound it uses.
const cardOf = (it, handle = it.author?.uniqueId ?? "") => ({ handle, url: `https://www.tiktok.com/@${handle}/video/${it.id}`,
  desc: it.desc, views: it.stats.playCount, likes: it.stats.diggCount, comments: it.stats.commentCount,
  shares: it.stats.shareCount, posted: new Date(it.createTime * 1000).toISOString().slice(0, 10),
  sound: it.music ? { id: it.music.id, title: it.music.title, author: it.music.authorName, original: !!it.music.original } : null });

// A competitor's recent posts: last 14 days, top 5 by views.
export function competitorCards(handle, items, now = new Date()) {
  return items
    .filter((it) => now / 1000 - it.createTime <= 14 * 86_400)
    .sort((a, b) => b.stats.playCount - a.stats.playCount).slice(0, 5)
    .map((it) => cardOf(it, handle));
}

// Sounds seen in the collected videos, ranked by how often they recur, then by views. A
// creator's own "original sound" used once is just their voiceover, so it is left out.
export function soundBoard(cards, limit = 15) {
  const by = new Map();
  for (const c of cards) {
    if (!c.sound?.id) continue;
    const s = by.get(c.sound.id) ?? { ...c.sound, uses: 0, views: 0, examples: [] };
    s.uses++; s.views += c.views ?? 0;
    if (s.examples.length < 2) s.examples.push(c.url);
    by.set(c.sound.id, s);
  }
  return [...by.values()].filter((s) => s.uses > 1 || !s.original)
    .sort((a, b) => b.uses - a.uses || b.views - a.views).slice(0, limit)
    .map((s) => ({ ...s, url: `https://www.tiktok.com/music/sound-${s.id}` }));
}

// Creative Center's public trends table, read from the rendered page (repeat visits are
// served from cache without an API call, so the text is the reliable source). Logged
// out it lists the top 3 hashtags per country and has no sounds page (verified
// 2026-09-30 and 2026-10-03); sounds come from Explore and competitors' videos instead.
export function parseTrendRows(text, country) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const rows = [];
  lines.forEach((line, i) => {
    if (!/^#\S+$/.test(line)) return;
    const rest = lines.slice(i + 1, i + 8);
    const before = (label) => rest[rest.indexOf(label) - 1] ?? null;
    rows.push({ country, tag: line, posts: rest.includes("Posts") ? before("Posts") : null, views: rest.includes("Views") ? before("Views") : null });
  });
  return rows;
}

export async function collectTrends(page, markets) {
  const hashtags = [];
  for (const code of markets) {
    // "commit": the page never settles enough for domcontentloaded within a minute.
    await page.goto(`https://ads.tiktok.com/creative/creativeCenter/trends/hashtag?period=7&region=${code}`,
      { waitUntil: "commit", timeout: 90_000 });
    await page.waitForTimeout(20_000);
    hashtags.push(...parseTrendRows(await page.evaluate(() => document.body.innerText), code));
  }
  return { hashtags, sounds: [] };
}

// The video list a public page fetches for itself (profile or Explore), read off the wire.
async function captureItems(page, url, api) {
  const items = [];
  const onResponse = async (r) => {
    if (api.test(r.url())) items.push(...((await r.json().catch(() => null))?.itemList ?? []));
  };
  page.on("response", onResponse);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(6_000);
    await page.mouse.wheel(0, 3000);
    await page.waitForTimeout(3_000);
  } finally {
    page.off("response", onResponse);
  }
  return items;
}

export async function collectCompetitors(page, handles, now = new Date()) {
  const out = [], missing = [];
  for (const handle of handles) {
    const items = await captureItems(page, `https://www.tiktok.com/@${handle}`, /\/api\/post\/item_list\//);
    if (items.length) out.push(...competitorCards(handle, items, now));
    else missing.push(handle);
  }
  return { posts: out, missing };
}

// What is going viral on TikTok right now, logged out. Not niche-specific, and the
// region follows this machine's IP.
export async function collectExplore(page) {
  const items = await captureItems(page, "https://www.tiktok.com/explore", /\/api\/(prefetch\/)?explore\/item_list\//);
  const seen = new Set();
  return items.filter((it) => !seen.has(it.id) && seen.add(it.id))
    .sort((a, b) => b.stats.playCount - a.stats.playCount).slice(0, 30).map((it) => cardOf(it));
}

export async function researchBrand({ project, briefs, previous, page }) {
  const r = { discovery: null, trends: null, competitors: null, explore: null, sounds: [], summary: null, errors: [], models: [] };
  const step = async (name, fn) => {
    try { return await fn(); } catch (e) {
      if (e.quota) throw e;
      r.errors.push(`${name}: ${e.message.slice(0, 200)}`);
      return null;
    }
  };
  r.discovery = await step("discovery", () => {
    const { data, model } = askClaude(discoveryPrompt({ project, briefs, previous }), { web: true });
    r.models.push(model);
    return data;
  }) ?? previous?.discovery ?? null;
  const markets = (r.discovery?.markets ?? []).map((m) => m.code).filter(Boolean);
  const handles = (r.discovery?.competitors ?? []).map((c) => String(c.handle).replace(/^@/, "")).filter(Boolean);
  r.trends = await step("trends", () => collectTrends(page, markets));
  if (r.trends && !r.trends.hashtags.length) r.errors.push("trends: Creative Center returned nothing");
  r.competitors = await step("competitors", () => collectCompetitors(page, handles));
  r.explore = await step("explore", () => collectExplore(page));
  if (r.explore && !r.explore.length) r.errors.push("explore: TikTok returned no videos");
  r.sounds = soundBoard([...(r.explore ?? []), ...(r.competitors?.posts ?? [])]);
  r.summary = await step("summary", () => {
    const { data, model } = askClaude(summaryPrompt({ project, briefs, discovery: r.discovery, trends: r.trends,
      competitors: r.competitors?.posts, explore: r.explore, sounds: r.sounds }), { web: true });
    r.models.push(model);
    return data;
  });
  return r;
}
