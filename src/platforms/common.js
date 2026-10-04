// Shared publisher behaviour. Adapters import these as plain functions.
//
// finalAction is the ONLY place in the codebase that clicks an irreversible button.
// Adapters hand it a locator and a verifier; they never click Post/Schedule/Share
// themselves. That is what keeps invariants 2-4 in one reviewable place instead of
// re-implemented per platform (they had already drifted apart by 2026-08).
import { existsSync } from "node:fs";
import { db, setStatus } from "../db.js";
import { handToHuman } from "../browser.js";

export const CAPTION_MAX = 2200;
export const PLATFORM_GAP_MINUTES = 45;   // machine-wide floor between two posts on one platform

// Poll, never snapshot: the final button stays disabled until the upload finishes,
// and a big file on a slow uplink takes minutes.
export async function waitEnabled(locator, ms = 180_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await locator.isVisible().catch(() => false)) && (await locator.isEnabled().catch(() => false))) return true;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return false;
}

const normalize = (s) => s.replace(/\s+/g, " ").trim();

// Type into a contenteditable and read it back — contenteditable is flaky and a
// silently empty caption has shipped before.
export async function typeVerified(locator, text, { clearFirst = false, page = null } = {}) {
  await locator.click();
  if (clearFirst && page) {
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
  }
  await locator.pressSequentially(text, { delay: 25 });
  const typed = normalize(await locator.innerText());
  return typed.startsWith(normalize(text).slice(0, 40)) ? null : typed.slice(0, 60);
}

// Ground truth: the post exists on the platform's own content surface.
// A success toast is not proof — the 2026-08-08 false positive taught us that.
export async function verifyByCaption(page, url, caption, { open = null } = {}) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(6_000);
    if (open) await open(page);
    const body = await page.evaluate(() => document.body.innerText);
    return normalize(body).includes(normalize(caption).slice(0, 25));
  } catch {
    return false;
  }
}

// The one irreversible click. afterClick() -> "settled" | "reclick" | "human"
// buys an adapter exactly one re-click, for the case where the UI proves the first
// click did not take effect (TikTok's "Continue to post?" modal).
export async function finalAction(job, { locator, verify, afterClick = null }) {
  const { key } = job;
  if (existsSync("STOP_AUTOMATION")) return job.fail("STOP_AUTOMATION appeared mid-run");

  await job.shot("pre-publish");
  setStatus(key, "AWAITING_FINAL_ACTION");

  if (job.mode !== "SCHEDULE" || !job.allowFinal) {
    job.log("stopped_before_final", "UPLOAD_ONLY: review the window and click it yourself");
    return handToHuman(job.ctx, key, "human completes final action; mark SCHEDULED via npm run status");
  }
  if (!(await waitEnabled(locator))) {
    await job.shot("final-button-missing");
    return job.fail("final button not visible/enabled — UI ambiguous, aborting");
  }

  // Written BEFORE the click: a crash in this window must look clicked, so the
  // sweep forces UNKNOWN. A false UNKNOWN costs a human 30 seconds; a false
  // re-claim costs a double post.
  db.prepare("UPDATE jobs SET clicked_at=datetime('now') WHERE key=?").run(key);
  try {
    await locator.click();
    job.log("final_action_clicked");

    if (afterClick) {
      let v = await afterClick();
      if (v === "reclick") {
        await locator.click();
        job.log("final_action_reclicked");
        v = await afterClick();
      }
      if (v !== "settled") {
        await job.shot("post-click-ambiguous");
        return handToHuman(job.ctx, key, "post-click UI ambiguous — inspect the platform before ANY retry", "UNKNOWN");
      }
    }

    const ok = await verify().catch(() => false);
    if (ok) {
      await job.shot("success");
      setStatus(key, job.scheduledFor ? "SCHEDULED" : "PUBLISHED");
      job.log("verified", "found on the platform's own content list");
    } else {
      await job.shot("unverified");
      setStatus(key, "UNKNOWN", "final action fired but outcome NOT verified — inspect before ANY retry");
    }
  } catch (e) {
    await job.shot("post-click-error").catch(() => {});
    setStatus(key, "UNKNOWN", `error after the final click: ${e.message.slice(0, 200)} — inspect before ANY retry`);
  }
}
