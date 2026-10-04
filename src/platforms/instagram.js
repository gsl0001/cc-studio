// Instagram Reels adapter. Moved from src/instagram.js with the crop machinery and
// its hard-won comments intact; the final click now goes through finalAction, and
// isBlocked + the final-button poll are new (both were missing here, not absent by
// platform difference).
import { finalAction, typeVerified, waitEnabled } from "./common.js";
import { handToHuman } from "../browser.js";
import { db } from "../db.js";

export const meta = {
  loginUrl: "https://www.instagram.com/accounts/login/",
  contentListName: "your Instagram profile",
};

export async function isLoggedOut(page) {
  return (await page.locator('input[name="username"]').first().isVisible().catch(() => false)) ||
    page.url().includes("/accounts/login");
}

export async function isBlocked(page) {
  const shown = await page.getByText(/suspicious|confirm it's you|challenge_required/i).first()
    .isVisible().catch(() => false);
  return shown ? "security challenge shown" : false;
}

export async function openComposer(page) {
  await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3_000);
}

export async function publish(page, job) {
  const { key, video, caption, scheduledFor } = job;

  // Open the create dialog: "New post" in the left nav, sometimes with a Post/AI submenu.
  await page.locator('svg[aria-label="New post"], a[href="#"]:has(svg[aria-label="New post"])').first().click();
  const postItem = page.locator('svg[aria-label="Post"]').first();
  if (await postItem.isVisible({ timeout: 2_500 }).catch(() => false)) await postItem.click();
  job.log("create_dialog_opened");

  const fileInput = page.locator('input[type="file"]').last();
  await fileInput.waitFor({ state: "attached", timeout: 30_000 });
  await fileInput.setInputFiles(video);
  job.log("file_selected");

  // NOTE: locator.isVisible() is an IMMEDIATE check — Playwright ignores the timeout
  // option. Every guard below must waitFor() first. Getting this wrong skipped the
  // crop step entirely and shipped three square reels (2026-08-12).

  const okBtn = page.getByRole("button", { name: /^ok$/i }).first();   // "shared as reels" nag
  await okBtn.waitFor({ state: "visible", timeout: 8_000 }).catch(() => {});
  if (await okBtn.isVisible().catch(() => false)) await okBtn.click();

  // Instagram defaults to a 1:1 centre crop, so a 9:16 source loses its top and
  // bottom unless the ratio is picked explicitly.
  const dlg = page.locator('div[role="dialog"]').last();
  const cropToggle = dlg.locator('svg[aria-label="Select crop"]').first();
  await cropToggle.waitFor({ state: "visible", timeout: 90_000 }).catch(() => {});
  if (!(await cropToggle.isVisible().catch(() => false))) {
    await job.shot("crop-toggle-missing");
    return job.fail("crop control never appeared — would post a default crop, aborting");
  }
  await page.waitForTimeout(2_500);   // the ratio list mounts after the media does
  let opt = null;
  for (let attempt = 1; attempt <= 3 && !opt; attempt++) {
    await cropToggle.click();         // toggles the menu — an even attempt may shut it, the next reopens
    const cand = dlg.getByText("9:16", { exact: true }).first();
    const shown = await cand.waitFor({ state: "visible", timeout: 8_000 }).then(() => true).catch(() => false);
    if (shown) opt = cand; else await page.waitForTimeout(1_500);
  }
  if (!opt) {
    await job.shot("crop-options-missing");
    return job.fail("crop menu never offered 9:16 — aborting rather than posting a default crop");
  }
  await opt.click();
  await page.waitForTimeout(1_500);
  job.log("crop_9_16");

  // Ground truth: measure the preview. A square preview means the crop did not take,
  // and a square reel is exactly the defect this guards against.
  const aspect = await previewAspect(dlg);
  job.log("preview_aspect", aspect ? aspect.toFixed(4) : "unmeasured");
  if (aspect !== null && Math.abs(aspect - 9 / 16) > 0.03) {
    await job.shot("wrong-aspect");
    return job.fail(`preview aspect ${aspect.toFixed(3)} is not 9:16 (0.5625) — crop did not apply`);
  }

  for (let i = 0; i < 2; i++) {       // crop -> edit -> caption
    const next = page.getByRole("button", { name: /^next$/i }).first();
    await next.waitFor({ state: "visible", timeout: 60_000 });
    await next.click();
    await page.waitForTimeout(1_500);
  }
  job.log("reached_caption_step");

  const captionBox = page.locator('div[contenteditable="true"][aria-label*="caption" i], div[role="dialog"] div[contenteditable="true"]').first();
  await captionBox.waitFor({ state: "visible", timeout: 30_000 });
  const wrong = await typeVerified(captionBox, caption);
  if (wrong !== null) {
    await job.shot("caption-mismatch");
    return handToHuman(job.ctx, key, `caption mismatch: got "${wrong}"`);
  }
  job.log("caption_entered");

  if (scheduledFor && !(await configureSchedule(page, job, scheduledFor))) {
    await job.shot("schedule-config-failed");
    // Discovery corrects the declaration: this account cannot schedule, so say so
    // once, loudly, with the exact edit — instead of failing here every single day.
    db.prepare(`INSERT INTO account_health (account, note, checked_at) VALUES (?,?,datetime('now'))
                ON CONFLICT(account) DO UPDATE SET note=excluded.note, checked_at=excluded.checked_at`)
      .run(job.account.id, `scheduling unavailable — set "can_schedule": false for ${job.account.id} in apps/${job.account.project}/profile.json`);
    return job.fail(`could not verify schedule date/time — needs a professional account; set "can_schedule": false for ${job.account.id}`);
  }

  const done = page.getByText(/has been shared|has been scheduled|post shared|scheduled/i).first();
  await finalAction(job, {
    locator: page.getByRole("button", { name: scheduledFor ? /^schedule$/i : /^share$/i }).first(),
    verify: async () => {
      // Instagram uploads the file on Share, so the confirmation can take minutes.
      await done.waitFor({ state: "visible", timeout: 240_000 }).catch(() => {});
      await page.waitForTimeout(3_000);
      await job.shot("after-final-click");
      // Scheduled reels genuinely do not appear on the profile — the confirmation
      // dialog is the strongest signal the web app gives us.
      return scheduledFor ? await done.isVisible().catch(() => false)
                          : await verifyOnProfile(page, job.caption);
    },
  });
}

export async function scrapeMetrics(page, jobs) {
  await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4_000);
  const href = await page.locator('a:has(img[alt*="profile picture"])').first().getAttribute("href").catch(() => null);
  if (!href) throw new Error("not logged in or profile link not found");
  await page.goto(`https://www.instagram.com${href.replace(/\/$/, "")}/reels/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(5_000);

  const urls = [];
  for (const l of (await page.locator('a[href*="/reel/"]').all()).slice(0, 12)) {
    const h = await l.getAttribute("href").catch(() => null);
    if (h) urls.push(`https://www.instagram.com${h}`);
  }

  const out = [];
  for (const url of urls) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3_500);
    const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
    const job = jobs.find((j) => j.caption && text.includes(j.caption.replace(/\s+/g, " ").slice(0, 25)));
    if (!job) continue;
    const likes = parseCount(text.match(/([\d,.]+[KM]?)\s+likes?/i)?.[1] ?? "0");
    const views = parseCount(text.match(/([\d,.]+[KM]?)\s+(?:plays|views)/i)?.[1] ?? "0") || likes;
    out.push({ key: job.key, views, likes, comments: 0, shares: 0 });
  }
  return out;
}

function parseCount(s) {
  s = s.replace(/,/g, "");
  if (/K$/i.test(s)) return Math.round(parseFloat(s) * 1_000);
  if (/M$/i.test(s)) return Math.round(parseFloat(s) * 1_000_000);
  return parseInt(s, 10) || 0;
}

// Width/height of the largest media element in the create dialog — the crop preview.
// null when nothing measurable is mounted yet.
async function previewAspect(dlg) {
  return await dlg.evaluate((root) => {
    let best = null;
    for (const el of root.querySelectorAll("video, img")) {
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 200) continue;
      if (!best || r.width * r.height > best.w * best.h) best = { w: r.width, h: r.height };
    }
    return best ? best.w / best.h : null;
  }).catch(() => null);
}

// Ground truth: the reel exists on the own profile with our caption.
async function verifyOnProfile(page, caption) {
  try {
    const href = await page.locator('a:has(img[alt*="profile picture"])').first().getAttribute("href");
    if (!href) return false;
    await page.goto(`https://www.instagram.com${href.replace(/\/$/, "")}/reels/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(5_000);
    const firstReel = page.locator('a[href*="/reel/"]').first();
    if (!(await firstReel.isVisible().catch(() => false))) return false;
    await firstReel.click();
    await page.waitForTimeout(4_000);
    const body = await page.evaluate(() => document.body.innerText);
    return body.replace(/\s+/g, " ").includes(caption.replace(/\s+/g, " ").slice(0, 25));
  } catch {
    return false;
  }
}

// Advanced settings → Schedule (professional accounts only). True only when the date
// and time inputs read back matching the target.
async function configureSchedule(page, job, scheduledFor) {
  const [datePart, timePart] = scheduledFor.split("T");
  const hhmm = timePart.slice(0, 5);

  const adv = page.getByText(/advanced settings/i).first();
  if (!(await adv.isVisible({ timeout: 5_000 }).catch(() => false))) {
    job.log("advanced_settings_not_found");
    return false;
  }
  await adv.click();
  await page.waitForTimeout(800);

  const toggle = page.locator('input[type="checkbox"][aria-label*="schedule" i], div[role="dialog"] input[type="checkbox"]').last();
  const scheduleLabel = page.getByText(/schedule this post/i).first();
  if (await scheduleLabel.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await scheduleLabel.click();
  } else if (await toggle.isVisible().catch(() => false)) {
    await toggle.click();
  } else {
    job.log("schedule_toggle_not_found", "account may not be professional");
    return false;
  }
  await page.waitForTimeout(1_000);

  const dateInput = page.locator('input[type="date"], input[placeholder*="date" i]').first();
  const timeInput = page.locator('input[type="time"], input[placeholder*="time" i]').first();
  if (!(await dateInput.isVisible({ timeout: 3_000 }).catch(() => false)) ||
      !(await timeInput.isVisible().catch(() => false))) {
    job.log("schedule_inputs_not_found");
    return false;
  }
  await dateInput.fill(datePart);
  await timeInput.fill(hhmm);
  await page.waitForTimeout(600);

  const gotDate = await dateInput.inputValue().catch(() => "");
  const gotTime = await timeInput.inputValue().catch(() => "");
  job.log("schedule_values", `date=${gotDate} time=${gotTime} want=${datePart} ${hhmm}`);
  return gotDate === datePart && gotTime === hhmm;
}
