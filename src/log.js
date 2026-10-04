// One structured log for the whole system: logs/system.jsonl, one JSON object per line.
//   {"t":"2026-10-04T07:29:33.093Z","src":"tick","lvl":"info","msg":"...","key":"mybrand-tiktok-..."}
// Node writes it with note(); cc (PowerShell) and the voice server (Python) append the same
// shape. Levels: info, warn, error. Read it with `npm run logs` (scripts/logs.mjs), the desk
// (GET /api/logs) or by asking cc "any errors?". The per-task logs/*.log files still hold
// each run's raw output; this file is the one timeline across all of it.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const LOG_DIR = process.env.CC_STUDIO_LOG_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "logs");   // env: tests only
export const LOG_FILE = join(LOG_DIR, "system.jsonl");
const OLD_FILE = join(LOG_DIR, "system.1.jsonl");
const MAX_BYTES = 5 * 1024 * 1024;   // ponytail: one 5 MB backup (~10 MB total), keep more if history matters
const SCRIPT = basename(process.argv[1] ?? "node").replace(/\.m?js$/, "");
const SRC = SCRIPT === "server" ? "desk" : SCRIPT;   // the source name each entry carries

export function note(lvl, msg, extra = {}, src = SRC) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > MAX_BYTES) renameSync(LOG_FILE, OLD_FILE);
    appendFileSync(LOG_FILE, JSON.stringify({ t: new Date().toISOString(), src, lvl, msg: String(msg).slice(0, 2000), ...extra }) + "\n");
  } catch {}   // logging must never take the system down
}

// For a script's entry point: logs start, exit (code and duration) and a crash's stack.
// The monitor only watches; Node still crashes and exits as it would without it.
export function lifecycle(what = "") {
  const t0 = Date.now();
  note("info", `started${what ? ` ${what}` : ""}`, { pid: process.pid });
  process.on("uncaughtExceptionMonitor", (e) => note("error", `crashed: ${e?.stack ?? e}`, { pid: process.pid }));
  process.on("exit", (code) => note(code ? "error" : "info", `exited with code ${code} after ${Math.round((Date.now() - t0) / 1000)} s`, { pid: process.pid }));
}

// Entries, oldest first, newest at the end: the last n matching src (one or a comma list),
// level (warn = warn and error), text and age.
const RANK = { info: 0, warn: 1, error: 2 };
export function readLog({ src, lvl, q, n = 50, sinceMs } = {}) {
  const srcs = src ? String(src).toLowerCase().split(",") : null;
  const min = RANK[lvl] ?? 0, after = sinceMs ? Date.now() - sinceMs : 0, needle = q?.toLowerCase();
  const out = [];
  for (const f of [LOG_FILE, OLD_FILE]) {
    if (!existsSync(f)) continue;
    const lines = readFileSync(f, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
      if (!lines[i]) continue;
      let e; try { e = JSON.parse(lines[i]); } catch { continue; }
      if (after && Date.parse(e.t) < after) return out.reverse();
      if (srcs && !srcs.includes(String(e.src).toLowerCase())) continue;
      if ((RANK[e.lvl] ?? 0) < min) continue;
      if (needle && !JSON.stringify(e).toLowerCase().includes(needle)) continue;
      out.push(e);
    }
    if (out.length >= n) break;
  }
  return out.reverse();
}

// The raw per-task logs (tick.log, creator.log, ...) grow forever; past 5 MB the current one
// becomes <name>.1.log. One still open by a running task is left for the next pulse.
export function rotateTaskLogs() {
  for (const f of readdirSync(LOG_DIR)) {
    if (!/^[\w-]+\.log$/.test(f)) continue;   // not system.jsonl, not an already rotated x.1.log
    const p = join(LOG_DIR, f);
    try { if (statSync(p).size > MAX_BYTES) { renameSync(p, p.replace(/\.log$/, ".1.log")); note("info", `rotated ${f}`); } } catch {}
  }
}
