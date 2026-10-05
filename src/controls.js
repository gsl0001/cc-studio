// What cc's per-post controls share: finding a post from everyday words ("Friday's Acme post",
// "notes oct 10"), and the days off ("no posts on Sundays", "skip Oct 12").
//
//   node src/controls.js        self-check
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseKey } from "./registry.js";
import { isDayOff, weekdayIn } from "./daysoff.js";

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const ymd = (d) => d.toLocaleDateString("sv");
export const niceDay = (date) => new Date(`${date}T12:00`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });

// A day named in the words, and the words left over: "friday", "today", "tomorrow", "oct 10",
// "10 october", "the 10th", "2026-10-10". A weekday is the next one, today included.
export function dayIn(words, now = new Date()) {
  const w = ` ${String(words).toLowerCase()} `;
  const take = (re, toDate) => {
    const m = re.exec(w), date = m && toDate(m);
    return date ? { date, rest: (w.slice(0, m.index) + " " + w.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim() } : null;
  };
  const on = (y, mo, d) => ymd(new Date(y, mo, d, 12));
  const year = (mo, d) => { const t = new Date(now.getFullYear(), mo, d, 12); return t < new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1) ? on(now.getFullYear() + 1, mo, d) : ymd(t); };
  const month = (s) => MONTHS.findIndex((m) => s.length >= 3 && m.startsWith(s));
  return take(/\s(\d{4})-(\d{2})-(\d{2})\s/, (m) => on(+m[1], m[2] - 1, +m[3]))
    ?? take(/\s(today|tonight)\s/, () => ymd(now))
    ?? take(/\stomorrow\s/, () => on(now.getFullYear(), now.getMonth(), now.getDate() + 1))
    ?? take(/\s([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s/, (m) => (month(m[1]) >= 0 ? year(month(m[1]), +m[2]) : null))
    ?? take(/\s(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\s/, (m) => (month(m[2]) >= 0 ? year(month(m[2]), +m[1]) : null))
    ?? take(/\s(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\s/, (m) => {
      const d = DAYS.findIndex((x) => x.startsWith(m[1]));
      return on(now.getFullYear(), now.getMonth(), now.getDate() + ((d - now.getDay() + 7) % 7));
    })
    ?? take(/\s(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\s/, (m) => year(now.getMonth(), +m[1]))
    ?? { date: null, rest: w.replace(/\s+/g, " ").trim() };
}

// "friday's acme post" -> { date: "2026-10-09", account: "acme-tiktok" }. `names` maps account
// ids to the names people use; the longest name found in the words wins ("acme desk"
// over "acme"). account is null when no name is given, date null when no day is.
export function postRef(words, names, now = new Date()) {
  const cleaned = String(words).toLowerCase().replace(/['’]s\b/g, "").replace(/[,.!?]/g, " ");
  const { date, rest } = dayIn(cleaned, now);
  const text = ` ${rest.replace(/\b(the|post|posts|video|videos|for|on|of|my|one|upload|uploads)\b/g, " ").replace(/\s+/g, " ").trim()} `;
  let account = null, best = 0;
  for (const [id, name] of Object.entries(names)) {
    for (const n of [name.toLowerCase(), id.toLowerCase()]) {
      if (n.length > best && text.includes(` ${n} `)) { account = id; best = n.length; }
    }
  }
  return { date, account, leftover: best ? text.replace(` ${(names[account] ?? account).toLowerCase()} `, " ").trim() : text.trim() };
}

// A post's day: when it goes live, else the day in its key.
export const postDay = (job) => job.scheduled_for?.slice(0, 10) ?? parseKey(job.key)?.date ?? null;
export const matches = (job, ref) => (!ref.account || job.account === ref.account) && (!ref.date || postDay(job) === ref.date);

export { daysOff, saveDaysOff, isDayOff, weekdayName, weekdayIn, describeOff } from "./daysoff.js";

if (import.meta.filename === process.argv[1]) {
  const assert = (await import("node:assert/strict")).default;
  const mon = new Date(2026, 9, 5, 16, 30);   // Monday 5 Oct 2026
  const names = { "acme-tiktok": "Acme", "acmedesk-tiktok": "Acme Desk", "notes-tiktok": "Notes", "notes-job-tiktok": "Notes Job" };
  assert.deepEqual(postRef("Friday's Acme post", names, mon), { date: "2026-10-09", account: "acme-tiktok", leftover: "" });
  assert.equal(postRef("acme desk", names, mon).account, "acmedesk-tiktok");
  assert.equal(postRef("acme desk", names, mon).date, null);
  assert.deepEqual([postRef("notes oct 10", names, mon).date, postRef("notes oct 10", names, mon).account], ["2026-10-10", "notes-tiktok"]);
  assert.equal(postRef("the notes job post on the 11th", names, mon).account, "notes-job-tiktok");
  assert.equal(postRef("the notes job post on the 11th", names, mon).date, "2026-10-11");
  assert.equal(postRef("10 October", names, mon).date, "2026-10-10");
  assert.equal(postRef("today", names, mon).date, "2026-10-05");
  assert.equal(postRef("monday", names, mon).date, "2026-10-05", "a weekday is the next one, today included");
  assert.equal(postRef("tomorrow", names, mon).date, "2026-10-06");
  assert.equal(postRef("jan 3", names, mon).date, "2027-01-03", "a past month is next year");
  assert.equal(postRef("2026-10-12", names, mon).date, "2026-10-12");
  assert.equal(postRef("everything", names, mon).account, null);
  assert.equal(dayIn("saturday at 6pm", mon).rest, "at 6pm");
  assert.equal(weekdayIn("Sundays"), 0);
  assert.equal(isDayOff("2026-10-11", { weekdays: [0], dates: [] }), true);
  assert.equal(isDayOff("2026-10-12", { weekdays: [0], dates: ["2026-10-12"] }), true);
  assert.equal(isDayOff("2026-10-13", { weekdays: [0], dates: ["2026-10-12"] }), false);
  console.log("controls ok");
}
