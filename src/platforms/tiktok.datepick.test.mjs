// The schedule date lookup against a page shaped like TikTok Studio's picker: a calendar
// grid with neighbouring months' days, plus the time picker's hour spans ("00".."23", hidden
// until opened). Day 10 used to resolve to the hour "10".
//
//   node src/platforms/tiktok.datepick.test.mjs
import assert from "node:assert/strict";
import { chromium } from "playwright";

const cal = (days) => days.map((d) => `<span class="cell" data-d="${d[0]}">${d[1]}</span>`).join("");
const prev = [27, 28, 29, 30].map((d) => ["prev", d]), cur = Array.from({ length: 31 }, (_, i) => ["cur", i + 1]), next = [1, 2, 3, 4, 5, 6, 7].map((d) => ["next", d]);
const hours = Array.from({ length: 24 }, (_, h) => `<span class="tiktok-timepicker-option-text tiktok-timepicker-left">${String(h).padStart(2, "0")}</span>`).join("");
const html = `<div class="tiktok-timepicker-time-picker-container tiktok-timepicker-invisible" style="display:none">${hours}</div>
  <div class="tiktok-timepicker-time-picker-container">${hours.replaceAll(">0", ">x0")}</div>
  <div class="calendar">${cal([...prev, ...cur, ...next])}</div>`;

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
await page.setContent(html);
const pick = async (day) => {
  // the same expression as configureSchedule
  const cellsForDay = page.getByText(String(day), { exact: true }).and(page.locator(":not(.tiktok-timepicker-option-text)")).filter({ visible: true });
  const el = day <= 15 ? cellsForDay.first() : cellsForDay.last();
  return el.evaluate((n) => `${n.dataset.d ?? n.className}:${n.textContent}`);
};
for (const day of [1, 5, 9, 10, 11, 15, 16, 23, 28, 31]) assert.equal(await pick(day), `cur:${day}`, `day ${day}`);
await browser.close();
console.log("tiktok date pick ok");
