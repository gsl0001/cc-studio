// Read the system log (logs/system.jsonl): every part of cc-studio and cc on one timeline.
//
//   npm run logs                         the last 40 entries
//   npm run logs -- cc desk              only these sources (cc, desk, tick, pulse, creator,
//                                        telegram-bot, publish, voice, posts, ...)
//   npm run logs -- --errors             warnings and errors only (--errors-only: errors only)
//   npm run logs -- --hours 6 -n 200     the last 6 hours, up to 200 entries
//   npm run logs -- --grep mybrand          entries mentioning "mybrand"
//   npm run logs -- --follow             keep printing new entries (Ctrl+C to stop)
import { closeSync, existsSync, openSync, readSync, statSync, watchFile } from "node:fs";
import { LOG_FILE, readLog } from "../src/log.js";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const flag = (name) => { const i = args.indexOf(name); return i >= 0 && !!args.splice(i, 1); };
const n = Number(opt("-n") ?? 40), hours = opt("--hours"), grep = opt("--grep");
const lvl = flag("--errors-only") ? "error" : flag("--errors") ? "warn" : undefined;
const follow = flag("--follow");
const src = args.length ? args.join(",") : undefined;

const color = { error: "\x1b[31m", warn: "\x1b[33m", info: "\x1b[2m" };
const show = (e) => {
  const t = new Date(e.t).toLocaleString("sv").slice(5, 19);
  const extra = Object.entries(e).filter(([k]) => !["t", "src", "lvl", "msg", "key"].includes(k)).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
  console.log(`${t} ${color[e.lvl] ?? ""}${e.lvl.padEnd(5)}\x1b[0m ${String(e.src).padEnd(12)} ${e.key ? `${e.key} ` : ""}${e.msg}${extra ? `  \x1b[2m${extra}\x1b[0m` : ""}`);
};

const entries = readLog({ src, lvl, q: grep, n, sinceMs: hours ? Number(hours) * 3_600_000 : undefined });
if (!entries.length && !follow) console.log("Nothing logged that matches.");
entries.forEach(show);

if (follow) {
  // Print what is appended from now on, with the same filters.
  let pos = existsSync(LOG_FILE) ? statSync(LOG_FILE).size : 0;
  const rank = { info: 0, warn: 1, error: 2 }, srcs = src?.split(",");
  watchFile(LOG_FILE, { interval: 1000 }, (cur) => {
    if (cur.size < pos) pos = 0;   // rotated
    if (cur.size === pos) return;
    const buf = Buffer.alloc(cur.size - pos), fd = openSync(LOG_FILE, "r");
    readSync(fd, buf, 0, buf.length, pos); closeSync(fd);
    const end = buf.lastIndexOf(10) + 1;   // a half-written last line waits for the next round
    pos += end;
    for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (srcs && !srcs.includes(e.src)) continue;
      if ((rank[e.lvl] ?? 0) < (rank[lvl] ?? 0)) continue;
      if (grep && !line.toLowerCase().includes(grep.toLowerCase())) continue;
      show(e);
    }
  });
}
