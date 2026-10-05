// The kill switch (STOP_AUTOMATION), optionally with an end: "pause for 3 days" writes an
// until= line, and the pulse lifts the pause once that time has passed.
//
//   node src/pause.js        self-check
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

export const STOP_FILE = "STOP_AUTOMATION";
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };

// "for 3 days", "2 hours", "a week", "until thursday", "till tomorrow", "until 2026-10-12"
// -> the Date the pause ends (a named day ends at 8am), or null if it isn't a duration.
export function pauseEnd(text, now = new Date()) {
  const t = String(text).toLowerCase().trim().replace(/[.!?]+$/, "");
  let m = /^(?:for\s+)?(\d+|an?|one|two|three|four|five|six|seven)\s+(hour|day|week)s?$/.exec(t);
  if (m) return new Date(now.getTime() + (Number(m[1]) || WORDS[m[1]]) * { hour: 3_600_000, day: 86_400_000, week: 604_800_000 }[m[2]]);
  m = /^(?:until|till|til)\s+(?:next\s+|this\s+)?(.+)$/.exec(t);
  if (!m) return null;
  const at8 = (y, mo, d) => new Date(y, mo, d, 8, 0);
  if (m[1] === "tomorrow") return at8(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const day = m[1].length >= 3 ? DAYS.findIndex((d) => d.startsWith(m[1])) : -1;
  if (day >= 0) return at8(now.getFullYear(), now.getMonth(), now.getDate() + ((day - now.getDay() + 7) % 7 || 7));
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(m[1]);
  return iso ? at8(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])) : null;
}

export function pause(by, until = null) {
  writeFileSync(STOP_FILE, `paused from ${by} ${new Date().toISOString()}\n${until ? `until=${until.toISOString()}\n` : ""}`);
}
export function pausedUntil() {
  if (!existsSync(STOP_FILE)) return null;
  const m = /^until=(.+)$/m.exec(readFileSync(STOP_FILE, "utf8"));
  return m ? new Date(m[1]) : null;
}
// Lifts a timed pause whose end has passed; true when it did.
export function liftExpired(now = new Date()) {
  const until = pausedUntil();
  if (!until || until > now) return false;
  rmSync(STOP_FILE, { force: true });
  return true;
}
export const niceWhen = (d) => d.toLocaleString("en-US", { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

if (import.meta.filename === process.argv[1]) {
  const assert = (await import("node:assert/strict")).default;
  const mon = new Date(2026, 9, 5, 16, 30);   // Monday 5 Oct 2026, 4:30pm
  assert.equal(pauseEnd("for 3 days", mon).getTime(), mon.getTime() + 3 * 86_400_000);
  assert.equal(pauseEnd("two hours", mon).getTime(), mon.getTime() + 7_200_000);
  assert.equal(pauseEnd("a week", mon).getDate(), 12);
  assert.deepEqual(pauseEnd("until thursday", mon), new Date(2026, 9, 8, 8, 0));
  assert.deepEqual(pauseEnd("till thu", mon), new Date(2026, 9, 8, 8, 0));
  assert.deepEqual(pauseEnd("until monday", mon), new Date(2026, 9, 12, 8, 0), "a named day is the next one, never today");
  assert.deepEqual(pauseEnd("until tomorrow", mon), new Date(2026, 9, 6, 8, 0));
  assert.deepEqual(pauseEnd("until 2026-10-20", mon), new Date(2026, 9, 20, 8, 0));
  assert.equal(pauseEnd("acme desk", mon), null);
  assert.equal(pauseEnd("until mo", mon), null);
  console.log("pause ok");
}
