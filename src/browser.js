import { chromium } from "playwright";
import { setStatus, log } from "./db.js";

// ponytail: channel:"chrome" uses installed Chrome — no 130MB Chromium download,
// and TikTok sees a real-Chrome fingerprint. Switch to bundled Chromium if Chrome breaks.
// One persistent profile per ACCOUNT (browser-profile/<profile>) — the profile
// directory is the credential, and two brands must never share one.
export async function launch({ headless = false, profile = "tiktok" } = {}) {
  return chromium.launchPersistentContext(`browser-profile/${profile}`, {
    channel: "chrome",
    headless,
    viewport: { width: 1440, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

// Hand the open window to a human, then stop waiting. Status is written FIRST —
// under Task Scheduler (AUTO=1) nobody ever closes the window, and five of the
// seven old call sites recorded nothing at all when the process was killed.
// ponytail: AUTO=1 => don't wait at all; a scheduled run has no human at the desk.
export async function handToHuman(ctx, key, reason, status = "MANUAL_REVIEW") {
  setStatus(key, status, reason);
  const minutes = process.env.AUTO === "1" ? 0 : 30;
  log(key, "handed_to_human", `${reason} (window open ${minutes}min)`);
  if (minutes) {
    // ponytail: clearTimeout matters — a live 30-min timer keeps node alive long
    // after the human closed the window, which is the hang we are removing.
    let timer;
    await Promise.race([
      new Promise((r) => ctx.on("close", r)),
      new Promise((r) => { timer = setTimeout(r, minutes * 60_000); }),
    ]);
    clearTimeout(timer);
  }
  await ctx.close().catch(() => {});
}
