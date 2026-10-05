// Days off: weekdays and dates with no posts ("no posts on Sundays", "skip Oct 12"), kept in
// data/days-off.json. Slots, the strategist and the queue all skip them.
import { readFileSync, writeFileSync } from "node:fs";

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const ymd = (d) => d.toLocaleDateString("sv");
const niceDay = (date) => new Date(`${date}T12:00`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
const OFF_FILE = "data/days-off.json";
export function daysOff() {
  try { const j = JSON.parse(readFileSync(OFF_FILE, "utf8")); return { weekdays: j.weekdays ?? [], dates: j.dates ?? [] }; }
  catch { return { weekdays: [], dates: [] }; }
}
export function saveDaysOff(off) {
  const today = ymd(new Date());
  writeFileSync(OFF_FILE, JSON.stringify({ weekdays: [...new Set(off.weekdays)].sort(), dates: [...new Set(off.dates)].filter((d) => d >= today).sort() }, null, 2) + "\n");
}
export function isDayOff(date, off = daysOff()) {
  return off.dates.includes(date) || off.weekdays.includes(new Date(`${date}T12:00`).getDay());
}
export const weekdayName = (i) => DAYS[i][0].toUpperCase() + DAYS[i].slice(1) + "s";
export const weekdayIn = (s) => { const m = /^(sun|mon|tue|wed|thu|fri|sat)/.exec(String(s).toLowerCase().trim()); return m ? DAYS.findIndex((d) => d.startsWith(m[1])) : -1; };
export const describeOff = (off = daysOff()) => [...off.weekdays.map(weekdayName), ...off.dates.map(niceDay)];

