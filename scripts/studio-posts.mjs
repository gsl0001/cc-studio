// List posts in TikTok Studio's content list. Read-only — deletes nothing.
//   node scripts/studio-posts.mjs
import { mkdirSync } from "node:fs";
import { launch } from "../src/browser.js";

const CONTENT_URL = "https://www.tiktok.com/tiktokstudio/content";

const ctx = await launch({ headless: false });
const page = ctx.pages()[0] ?? (await ctx.newPage());
try {
  await page.goto(CONTENT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(8_000);

  if (page.url().includes("/login")) {
    console.log("NOT LOGGED IN — run: npm run setup");
  } else {
    mkdirSync("evidence/_studio", { recursive: true });
    await page.screenshot({ path: "evidence/_studio/content.png" });
    console.log(await page.evaluate(() => document.body.innerText));
  }
} finally {
  await ctx.close();
}
