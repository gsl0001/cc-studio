// TikTok adapter. Lifted from the old src/publish.js body — every selector, timeout
// and carve-out here was mapped from real evidence screenshots; do not "tidy" them.
import { finalAction, typeVerified, verifyByCaption } from "./common.js";
import { handToHuman } from "../browser.js";

export const meta = {
  loginUrl: "https://www.tiktok.com/login",
  contentListName: "TikTok Studio",
};

const UPLOAD_URL = "https://www.tiktok.com/tiktokstudio/upload";
const CONTENT_URL = "https://www.tiktok.com/tiktokstudio/content";

export async function isLoggedOut(page) {
  return page.url().includes("/login") ||
    (await page.getByText(/log in/i).first().isVisible().catch(() => false));
}

export async function isBlocked(page) {
  const shown = await page.locator('[id*="captcha"], [class*="captcha"]').first().isVisible().catch(() => false);
  return shown ? "security challenge / captcha shown" : false;
}

export async function openComposer(page) {
  await page.goto(UPLOAD_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
}

export async function publish(page, job) {
  const { key, video, caption, scheduledFor } = job;

  const fileInput = page.locator('input[type="file"]');
  await fileInput.waitFor({ state: "attached", timeout: 30_000 });
  await fileInput.setInputFiles(video);
  job.log("file_selected");

  // Processing is done when the caption editor appears. Generous — big files are slow.
  const captionBox = page.locator('div[contenteditable="true"]').first();
  await captionBox.waitFor({ state: "visible", timeout: 180_000 });
  await page.waitForTimeout(3_000);
  job.log("processed");
  await job.shot("uploaded");

  // First upload on a fresh profile: the "Turn on automatic content checks?" modal
  // overlays the page and swallows every click until dismissed. Accept it — the
  // flow below depends on those checks running.
  const checksModal = page.getByRole("button", { name: /^turn on$/i }).first();
  if (await checksModal.isVisible().catch(() => false)) {
    await checksModal.click();
    await page.waitForTimeout(1_000);
    job.log("content_checks_modal_accepted");
  }
  // Fresh profiles also get feature-tour popovers ("New editing features added" ->
  // "Got it", 2026-10-03) that intercept clicks on the caption box. Close any that show.
  for (let i = 0; i < 3; i++) {
    const tip = page.getByRole("button", { name: /^(got it|not now|dismiss|skip)$/i }).first();
    if (!(await tip.isVisible().catch(() => false))) break;
    await tip.click().catch(() => {});
    await page.waitForTimeout(800);
    job.log("tour_popover_dismissed");
  }

  // TikTok pre-fills the caption with the filename — clear it first.
  const wrong = await typeVerified(captionBox, caption, { clearFirst: true, page });
  if (wrong !== null) {
    await job.shot("caption-mismatch");
    return handToHuman(job.ctx, key, `caption mismatch: got "${wrong}"`);
  }
  job.log("caption_entered");

  // AI-content disclosure. An unlabeled-but-flagged video starts TikTok's strike
  // ladder, so a job marked is_aigc that cannot be labeled goes to a human rather
  // than publishing unlabeled. Selectors are best-effort until proven on a live
  // upload — the fail path is the safety property, not the selector.
  if (job.isAigc === true) {
    if (!(await setAigcToggle(page, job))) {
      await job.shot("aigc-toggle-failed");
      return handToHuman(job.ctx, key, "is_aigc set but AI-content toggle not confirmed — label manually, then finish the post");
    }
  } else if (job.isAigc === null) {
    job.log("aigc_unlabeled", "no meta.json — queued without a labeling decision");
  }

  if (scheduledFor && !(await configureSchedule(page, job, scheduledFor))) {
    await job.shot("schedule-config-failed");
    // Nothing was posted yet, so this is a retry (FAILED, up to 3 attempts), not a human's job;
    // after the last attempt the pulse hands the video to the user to post by hand.
    throw new Error("could not set or verify the schedule date/time in TikTok's picker");
  }

  // Clicking Schedule while "Checking in progress" is up triggers a "Continue to
  // post?" modal that swallows the click and loses the upload.
  if (!(await waitForChecks(page, job))) {
    job.log("stopped_checks_running", "content check never finished; click Schedule yourself once it does");
    return handToHuman(job.ctx, key, "checks never finished — human completes final action; mark SCHEDULED via npm run status");
  }

  const contModal = page.getByText(/continue to post/i).first();
  await finalAction(job, {
    locator: page.getByRole("button", { name: scheduledFor ? /schedule/i : /post/i }).first(),
    // The modal proves the click did NOT take effect. Cancel is a no-op, so one
    // re-click after the checks finish is safe — the single sanctioned re-click.
    afterClick: async () => {
      if (!(await contModal.isVisible({ timeout: 5_000 }).catch(() => false))) return "settled";
      job.log("checks_modal_appeared", "cancelling, waiting for checks, re-clicking");
      await page.getByRole("button", { name: /^cancel$/i }).first().click();
      if (!(await waitForChecks(page, job))) return "human";
      return "reclick";
    },
    verify: async () => {
      await page.waitForTimeout(6_000);
      await job.shot("after-final-click");
      return verifyByCaption(page, CONTENT_URL, job.caption);
    },
  });
}

export async function scrapeMetrics(page, jobs) {
  await page.goto(CONTENT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  if (page.url().includes("/login")) throw new Error("not logged in");
  await page.waitForTimeout(8_000);

  // The list is virtualized (~8 rows in the DOM at a time), so scroll in steps and
  // keep the longest text seen per row. Same walk as scripts/studio-posts-all.mjs --
  // the old class/data-e2e selectors matched nothing and quietly returned 0 rows.
  const seen = new Map();
  for (let i = 0; i < 60; i++) {
    const { rows, atEnd } = await page.evaluate((step) => {
      const el = [...document.querySelectorAll("*")]
        .find((e) => e.scrollHeight > e.clientHeight + 100 && e.clientHeight > 200);
      const rows = [...document.querySelectorAll("div")]
        .map((e) => (e.innerText || "").replace(/\r/g, "").trim())
        .filter((t) => /^\d{2}:\d{2}\n/.test(t) && t.split("\n").length <= 12);
      let atEnd = true;
      if (el) {
        const before = el.scrollTop;
        el.scrollTop = Math.min(el.scrollTop + step, el.scrollHeight);
        atEnd = el.scrollTop === before;
      }
      return { rows, atEnd };
    }, 250);
    for (const r of rows) {
      const k = r.split("\n").slice(0, 2).join(" | ");
      if (!seen.has(k) || seen.get(k).length < r.length) seen.set(k, r);
    }
    await page.waitForTimeout(700);
    if (atEnd && i > 3) break;
  }
  return parseStudioRows([...seen.values()], jobs);
}

// A row reads: duration / caption / date / audience / views / likes / comments.
// Studio has no shares column, so shares stays 0 rather than guessing.
export function parseStudioRows(texts, jobs) {
  const out = [];
  for (const text of texts) {
    const lines = text.split("\n").map((l) => l.trim());
    const stats = lines.slice(-3);
    if (!stats.every((s) => /^\d[\d,.]*[KM]?$/i.test(s))) continue;
    const job = jobs.find((j) => j.caption && lines[1]?.includes(j.caption.slice(0, 25)));
    if (!job || out.some((r) => r.key === job.key)) continue;
    const [views, likes, comments] = stats.map(parseCount);
    out.push({ key: job.key, views, likes, comments, shares: 0 });
  }
  return out;
}

// Reveal the disclosure section if collapsed, find the AI-generated-content
// switch, turn it on, and read the state back. True only on confirmed ON.
async function setAigcToggle(page, job) {
  const showMore = page.getByText(/^show more$/i).first();
  if (await showMore.isVisible().catch(() => false)) {
    await showMore.click();
    await page.waitForTimeout(800);
  }
  const section = page.locator("div").filter({ hasText: /ai-generated content/i }).last();
  const sw = section.locator('[role="switch"], input[type="checkbox"]').first();
  if (!(await sw.isVisible().catch(() => false))) { job.log("aigc_toggle_not_found"); return false; }
  const state = async () =>
    (await sw.getAttribute("aria-checked").catch(() => null)) === "true" ||
    (await sw.isChecked().catch(() => false));
  if (!(await state())) {
    // The real checkbox sits under TikTok's drawn switch (2026-10-03: a plain click timed
    // out with the pointer intercepted), so click through to it.
    await sw.click({ force: true });
    await page.waitForTimeout(800);
    // Some flows confirm the label with a modal.
    const ok = page.getByRole("button", { name: /^(turn on|confirm|ok)$/i }).first();
    if (await ok.isVisible().catch(() => false)) await ok.click();
  }
  const on = await state();
  job.log(on ? "aigc_toggle_set" : "aigc_toggle_unconfirmed");
  return on;
}

// Retention scrape: map captions -> video ids on the content list, then read
// each post's analytics overview (analytics/<id>/overview). Scheduled posts
// have no analytics and redirect to the Studio home -- those are skipped.
export async function scrapeRetention(page, jobs, { limit = 12 } = {}) {
  await page.goto(CONTENT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  if (page.url().includes("/login")) throw new Error("not logged in");
  await page.waitForTimeout(8_000);

  // Same virtualized walk as scrapeMetrics, but rows keep their /video/<id> anchor.
  const seen = new Map();
  for (let i = 0; i < 60; i++) {
    const { rows, atEnd } = await page.evaluate((step) => {
      const el = [...document.querySelectorAll("*")]
        .find((e) => e.scrollHeight > e.clientHeight + 100 && e.clientHeight > 200);
      const rows = [...document.querySelectorAll("div")]
        .filter((e) => /^\d{2}:\d{2}\n/.test((e.innerText || "").trim()) && (e.innerText || "").split("\n").length <= 12)
        .map((e) => ({
          text: e.innerText.replace(/\r/g, "").trim(),
          id: (e.querySelector('a[href*="/video/"]')?.getAttribute("href")?.match(/\/video\/(\d+)/) ?? [])[1] ?? null,
        }));
      let atEnd = true;
      if (el) {
        const before = el.scrollTop;
        el.scrollTop = Math.min(el.scrollTop + step, el.scrollHeight);
        atEnd = el.scrollTop === before;
      }
      return { rows, atEnd };
    }, 250);
    for (const r of rows) {
      if (!r.id) continue;
      const caption = r.text.split("\n")[1] ?? "";
      if (!seen.has(r.id)) seen.set(r.id, caption);
    }
    await page.waitForTimeout(700);
    if (atEnd && i > 3) break;
  }

  const targets = [];
  for (const [id, caption] of seen) {
    const job = jobs.find((j) => j.caption && caption.includes(j.caption.slice(0, 25)));
    if (job && !targets.some((t) => t.key === job.key)) targets.push({ id, key: job.key });
  }

  const out = [];
  for (const t of targets.slice(0, limit)) {
    await page.goto(`https://www.tiktok.com/tiktokstudio/analytics/${t.id}/overview`,
      { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(6_000);
    if (!page.url().includes(t.id)) continue; // not aired yet -- Studio bounced us home
    const text = await page.evaluate(() => document.body.innerText);
    const r = parseRetention(text);
    if (r) out.push({ key: t.key, ...r });
  }
  return out;
}

// The overview page reads: "Average watch time / 2.3s", "Watched full video / 0%",
// "Most viewers stopped watching at 0:01".
export function parseRetention(text) {
  const grab = (re) => (text.match(re) ?? [])[1] ?? null;
  const avg = grab(/Average watch time\s*\n\s*([^\n]+)/i);
  const full = grab(/Watched full video\s*\n\s*([\d.]+)%/i);
  const stop = text.match(/stopped watching at (\d+):(\d{2})/i);
  if (avg === null && full === null && !stop) return null;
  return {
    avg_watch_s: avg === null ? null : parseDuration(avg),
    full_watch_pct: full === null ? null : parseFloat(full),
    stop_at_s: stop ? Number(stop[1]) * 60 + Number(stop[2]) : null,
  };
}

// "2.3s", "1m 5s", "0h:12m:22s" -> seconds.
function parseDuration(s) {
  let total = 0;
  for (const [, n, unit] of s.matchAll(/([\d.]+)\s*(h|m|s)/gi)) {
    total += parseFloat(n) * (unit === "h" ? 3600 : unit === "m" ? 60 : 1);
  }
  return Math.round(total * 10) / 10;
}
function parseCount(s) {
  s = s.replace(/,/g, "");
  if (/K$/i.test(s)) return Math.round(parseFloat(s) * 1_000);
  if (/M$/i.test(s)) return Math.round(parseFloat(s) * 1_000_000);
  return parseInt(s, 10) || 0;
}

// Studio says the content check "will take about 10 minutes" — cap at 13. Returns
// false if still running; callers must NOT fire the final click then (2026-08-08/10/11:
// three uploads lost to the modal swallowing a too-early click).
async function waitForChecks(page, job) {
  for (let i = 0; i < 156; i++) {
    const checking = await page.getByText(/checking in progress/i).first().isVisible().catch(() => false);
    if (!checking) { if (i > 0) job.log("checks_completed"); return true; }
    if (i === 0) job.log("waiting_for_checks");
    await page.waitForTimeout(5_000);
  }
  job.log("checks_still_running", "gave up after 13min");
  return false;
}

// Select the Schedule radio, clear the one-time consent modal, set date + time via
// the real picker widgets. True only when both inputs read back matching the target.
// (UI mapped from evidence 2026-08-08.)
async function configureSchedule(page, job, scheduledFor) {
  const [datePart, timePart] = scheduledFor.split("T");
  const hhmm = timePart.slice(0, 5);
  const day = Number(datePart.split("-")[2]);

  await page.getByText(/^schedule$/i).first().click();
  job.log("schedule_radio_clicked");

  // One-time consent: "Allow your video to be saved for scheduled posting?"
  const allowBtn = page.getByRole("button", { name: /^allow$/i }).first();
  if (await allowBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await allowBtn.click();
    job.log("consent_modal_allowed", "scheduled-posting consent (one-time)");
    await page.waitForTimeout(1500);
  }

  // Two readonly TUX inputs inside .scheduled-picker: time ("HH:MM") and date
  // ("YYYY-MM-DD"). Identify by value shape — labels/ids are unstable.
  // The pickers render a moment after the radio/consent click (2026-10-03: scanned after
  // 1.6 s, found nothing, while the screenshot taken next showed both) — poll for them.
  const inputs = page.locator(".scheduled-picker input, input");
  let timeInput = null, dateInput = null;
  for (let tries = 0; tries < 15 && !(timeInput && dateInput); tries++) {
    if (tries) await page.waitForTimeout(1000);
    timeInput = dateInput = null;
    const n = await inputs.count();
    for (let i = 0; i < n; i++) {
      const v = await inputs.nth(i).inputValue().catch(() => "");
      if (/^\d{1,2}:\d{2}$/.test(v) && !timeInput) timeInput = inputs.nth(i);
      if (/^\d{4}-\d{2}-\d{2}$/.test(v) && !dateInput) dateInput = inputs.nth(i);
    }
  }
  if (!timeInput || !dateInput) { job.log("schedule_inputs_not_found"); return false; }

  // DATE first (the time list can be restricted for same-day). Calendar header reads
  // "August / 2026"; adjacent-month cells are grayed but clickable, and .last()
  // resolves next-month duplicates correctly.
  const wantHeader = `${new Date(datePart + "T00:00").toLocaleString("en", { month: "long" })} / ${datePart.slice(0, 4)}`;
  await dateInput.click();
  await page.waitForTimeout(900);
  for (let hops = 0; hops < 2; hops++) {
    if (await page.getByText(wantHeader).first().isVisible().catch(() => false)) break;
    await page.locator("svg, span").filter({ has: page.locator('[d*="M5.25"]') }).last().click()
      .catch(() => page.keyboard.press("ArrowRight"));
    await page.waitForTimeout(600);
  }
  if (!(await page.getByText(wantHeader).first().isVisible().catch(() => false))) {
    job.log("calendar_month_not_reached", wantHeader);
    return false;
  }
  // The grid also shows the neighbouring months' days: last month's 23-31 before day 1 and
  // next month's 1-6 after the last day. So an early date is the FIRST match and a late one
  // the LAST (2026-10-03 review: .last() picked next month's cell for days 1-6).
  // Not the time picker's hour spans: they are in the page too (hidden), and from day 10 on
  // "10".."23" matched them first (2026-10-05: every post on the 10th failed 3 times).
  const cellsForDay = page.getByText(String(day), { exact: true }).and(page.locator(":not(.tiktok-timepicker-option-text)")).filter({ visible: true });
  await (day <= 15 ? cellsForDay.first() : cellsForDay.last()).click();
  await page.waitForTimeout(900);

  // TIME: the container drops its -invisible class when open; hours are spans with
  // class tiktok-timepicker-left, minutes tiktok-timepicker-right (5-minute steps).
  const [hh, mm] = hhmm.split(":");
  await timeInput.click();
  const openPicker = page.locator(".tiktok-timepicker-time-picker-container:not(.tiktok-timepicker-invisible)").first();
  await openPicker.waitFor({ state: "visible", timeout: 10_000 });
  await openPicker.locator(".tiktok-timepicker-option-text.tiktok-timepicker-left", { hasText: new RegExp(`^${hh}$`) }).first().click();
  await page.waitForTimeout(400);
  await openPicker.locator(".tiktok-timepicker-option-text.tiktok-timepicker-right", { hasText: new RegExp(`^${mm}$`) }).first().click();
  await page.waitForTimeout(600);
  await page.mouse.click(700, 200); // click empty space to close the popover
  await page.waitForTimeout(600);

  const gotDate = await dateInput.inputValue().catch(() => "");
  const gotTime = await timeInput.inputValue().catch(() => "");
  job.log("schedule_values", `date=${gotDate} time=${gotTime} want=${datePart} ${hhmm}`);
  return gotDate === datePart && gotTime === hhmm;
}

// --- weekly insights (src/insights.js) ------------------------------------------
// Studio's insight API is unsigned, so it is called from the logged-in page with the
// exact query Studio itself sent — only type_requests changes. The post list IS signed,
// so it is read off the content page's own item_list responses while scrolling.
const ACCOUNT_TYPES = [
  ...["vv_history", "pv_history", "like_history", "comment_history", "share_history",
    "follower_num_history", "net_follower_history", "reached_audience_history"]
    .map((t) => ({ insigh_type: t, days: 28, end_days: 1 })),
  { insigh_type: "vv_traffic_source", days: 7, end_days: 1 },
  ...["user_search_terms", "unique_viewer_num", "new_viewer_num", "viewer_gender_percent",
    "viewer_age_distribution", "viewer_country_city_percent", "follower_age_distribution",
    "follower_gender_percent", "follower_location_percent"].map((t) => ({ insigh_type: t, range: 1 })),
  { insigh_type: "follower_num" },
  { insigh_type: "top10_other_creators_recommendation" }, { insigh_type: "top10_other_videos_recommendation" },
  ...["viewer_active_history_hours", "follower_active_history_hours"].map((t) => ({ insigh_type: t, days: 8, end_days: 1 })),
  ...["viewer_active_history_days", "follower_active_history_days"].map((t) => ({ insigh_type: t, days: 7, end_days: 1 })),
];
const POST_TYPES = ["item_search_terms", "video_traffic_source_percent_realtime", "video_retention_rate_realtime",
  "video_view_realtime", "video_total_duration_realtime", "video_per_duration_realtime", "video_finish_rate_realtime",
  "video_new_follower_realtime", "video_new_followers", "video_vv_history_7d", "video_uv",
  "video_viewer_return_viewer_percent", "video_viewer_new_viewer_percent", "video_viewer_follower_percent",
  "video_viewer_non_follower_percent", "video_viewer_age_percent_realtime", "video_viewer_gender_percent_realtime",
  "video_viewer_location_percent_realtime", "video_like_distribution_realtime"];

export async function collectInsights(page, { known = new Set(), recentDays = 35, cap = 150 } = {}) {
  let base = null;
  const items = new Map();
  page.on("request", (r) => { if (!base && r.url().includes("/aweme/v2/data/insight/")) base = r.url(); });
  page.on("response", async (r) => {
    if (!r.url().includes("/creator/manage/item_list/")) return;
    for (const it of (await r.json().catch(() => null))?.item_list ?? []) items.set(it.item_id, it);
  });

  await page.goto(CONTENT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  if (page.url().includes("/login")) throw new Error("not logged in");
  await page.waitForTimeout(8_000);
  for (let i = 0, still = 0; i < 80 && still < 4; i++) {
    const before = items.size;
    await page.evaluate(() => {
      const el = [...document.querySelectorAll("*")].find((e) => e.scrollHeight > e.clientHeight + 100 && e.clientHeight > 200);
      if (el) el.scrollTop = el.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(1_500);
    still = items.size === before ? still + 1 : 0;
  }

  await page.goto("https://www.tiktok.com/tiktokstudio/analytics/overview", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(8_000);
  if (!base) throw new Error("Studio sent no insight request — analytics page changed?");
  const insight = async (types) => {
    const out = {};
    for (let i = 0; i < types.length; i += 16) { // Studio itself never batches more than 16
      const chunk = types.slice(i, i + 16);
      const j = await page.evaluate(async ({ base, chunk }) => {
        const u = new URL(base);
        u.searchParams.set("type_requests", JSON.stringify(chunk));
        return (await fetch(u, { credentials: "include" })).json();
      }, { base, chunk });
      if (j.status_code) throw new Error(`insight API status ${j.status_code} ${j.status_msg ?? ""}`);
      for (const [k, v] of Object.entries(j)) if (JSON.stringify(v).length > 20 && !/^(extra|log_pb|status_)/.test(k)) out[k] = v;
      await page.waitForTimeout(800);
    }
    return out;
  };

  const acct = await insight(ACCOUNT_TYPES);
  // "Viewers also watched" arrives as full user/video objects (~70KB); keep what is readable.
  if (acct.viewer_also_watched_users?.value) acct.viewer_also_watched_users = acct.viewer_also_watched_users.value
    .map((u) => ({ handle: u.unique_id, name: u.nickname, followers: u.follower_count }));
  if (acct.viewer_also_watched_items?.value) acct.viewer_also_watched_items = acct.viewer_also_watched_items.value
    .map((v) => ({ id: v.aweme_id, author: v.author?.unique_id, desc: v.desc, views: v.statistics?.play_count }));
  const cutoff = Date.now() / 1000 - recentDays * 86_400;
  const posts = [];
  // ponytail: cap per run — a big back catalogue backfills over several weekly runs.
  for (const it of [...items.values()].sort((a, b) => b.create_time - a.create_time)) {
    const deep = posts.filter((p) => p.raw.insight).length < cap && (+it.create_time > cutoff || !known.has(it.item_id));
    const p = deep ? await insight(POST_TYPES.map((t) => ({ insigh_type: t, aweme_id: it.item_id }))) : null;
    const { download_info, cover_url, permissions, ...item } = it;
    posts.push({ ref: it.item_id, posted_at: new Date(it.create_time * 1000).toISOString(),
                 summary: summarizeTikTokPost(item, p), raw: { item, insight: p } });
  }
  return { account: { summary: summarizeTikTokAccount(acct), raw: acct }, posts };
}

const num = (x) => typeof x?.value === "number" ? x.value : typeof x?.value?.value === "number" ? x.value.value : null;
const kv = (list) => Array.isArray(list) ? Object.fromEntries(list.map((x) => [x.key, x.value])) : null;
const sum = (hist) => Array.isArray(hist) ? hist.reduce((t, d) => t + (d?.value ?? 0), 0) : null;
const places = (v) => v?.country_percent_list?.map((c) => ({
  country: c.country_name, pct: c.country_vv_percent ?? c.value ?? null, cities: kv(c.city_percent_list) })) ?? null;
// Per-hour average over the days returned: [{value:[24 numbers]}, ...] -> 24 numbers.
const hours = (days) => {
  const rows = Array.isArray(days) ? days.map((d) => d?.value).filter((v) => v?.length === 24) : [];
  return rows.length ? rows[0].map((_, h) => Math.round(rows.reduce((t, r) => t + r[h], 0) / rows.length)) : null;
};

export function summarizeTikTokAccount(r) {
  return {
    followers: num(r.follower_num), viewers_7d: num(r.unique_viewer_num), new_viewers_7d: num(r.new_viewer_num),
    views_28d: sum(r.vv_history), profile_views_28d: sum(r.pv_history), likes_28d: sum(r.like_history),
    comments_28d: sum(r.comment_history), shares_28d: sum(r.share_history), net_followers_28d: sum(r.net_follower_history),
    traffic: kv(r.video_page_percent?.value), age: kv(r.viewer_age_distribution?.value),
    gender: kv(r.viewer_gender_percent?.value), locations: places(r.viewer_country_city_percent),
    follower_age: kv(r.follower_age_distribution?.value), follower_gender: kv(r.follower_gender_percent?.value),
    follower_locations: places(r.follower_location_percent),
    active_hours: hours(r.viewer_active_history_hours), follower_active_hours: hours(r.follower_active_history_hours),
    search_terms: kv(r.user_search_terms?.value),
    also_watched_creators: Array.isArray(r.viewer_also_watched_users) ? r.viewer_also_watched_users : null,
    also_watched_videos: Array.isArray(r.viewer_also_watched_items) ? r.viewer_also_watched_items : null,
  };
}

export function summarizeTikTokPost(item, p) {
  return {
    caption: item.desc, duration_s: item.duration / 1000,
    views: +item.play_count, likes: +item.like_count, comments: +item.comment_count,
    shares: +item.share_count, saves: +item.favorite_count,
    avg_watch_s: num(p?.video_per_duration_realtime), full_watch_pct: num(p?.video_finish_rate_realtime),
    total_play_s: num(p?.video_total_duration_realtime),
    unique_viewers: num(p?.video_uv), new_viewer_pct: num(p?.video_viewer_new_viewer_percent),
    returning_viewer_pct: num(p?.video_viewer_return_viewer_percent), follower_view_pct: num(p?.video_viewer_follower_percent),
    search_terms: kv(p?.item_search_terms?.value),
    new_followers: num(p?.realtime_new_followers) ?? num(p?.video_new_followers),
    traffic: kv(p?.video_traffic_source_percent_realtime?.value?.value),
    age: kv(p?.video_viewer_age_percent_realtime?.value?.value),
    gender: kv(p?.video_viewer_gender_percent_realtime?.value?.value),
    locations: places(p?.video_viewer_location_percent_realtime?.value),
    retention: p?.video_retention_rate_realtime?.value?.list?.map((x) => [x.timestamp / 1000, x.value]) ?? null,
  };
}
