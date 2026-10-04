// Dump every row in TikTok Studio's content list, with its stats. Read-only.
// The list is virtualized (~8 rows in the DOM at a time), so scroll in steps
// and accumulate, keeping the longest text seen for each row.
//   node scripts/studio-posts-all.mjs
import { launch } from "../src/browser.js";

const ctx = await launch({ headless: false });
const page = ctx.pages()[0] ?? (await ctx.newPage());
try {
  await page.goto("https://www.tiktok.com/tiktokstudio/content", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(8_000);
  if (page.url().includes("/login")) { console.log("NOT LOGGED IN — run: npm run setup"); await ctx.close(); process.exit(1); }

  const seen = new Map();
  for (let i = 0; i < 60; i++) { // ponytail: fixed cap; plenty for a few hundred posts
    const { rows, atEnd } = await page.evaluate((step) => {
      const el = [...document.querySelectorAll("*")]
        .find(e => e.scrollHeight > e.clientHeight + 100 && e.clientHeight > 200);
      const rows = [...document.querySelectorAll("div")]
        .map(e => (e.innerText || "").replace(/\r/g, "").trim())
        .filter(t => /^\d{2}:\d{2}\n/.test(t) && t.split("\n").length <= 12);
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
  console.log([...seen.values()].join("\n---\n"));
  console.error(`rows captured: ${seen.size}`);
} finally { await ctx.close(); }
