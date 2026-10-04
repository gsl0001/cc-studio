// node src/log.test.mjs
// The system log is read back by cc's chat and `npm run logs`; a filter slip there hides
// the very errors someone is looking for. Runs against a temp folder, not logs/.
import assert from "node:assert";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "autobot-log-"));
process.env.CC_STUDIO_LOG_DIR = dir;
const { note, readLog, LOG_FILE } = await import("./log.js");

note("info", "tick ran", {}, "tick");
note("warn", "voice server restarted", {}, "cc");
note("error", "upload failed", { key: "mybrand-tiktok-2026-10-05-001" }, "publish");
appendFileSync(LOG_FILE, "not json\n");   // a torn line is skipped, not fatal
note("info", "chat answered", {}, "desk");

assert.equal(readLog().length, 4);
assert.deepEqual(readLog({ lvl: "warn" }).map((e) => e.msg), ["voice server restarted", "upload failed"]);
assert.deepEqual(readLog({ lvl: "error" }).map((e) => e.src), ["publish"]);
assert.deepEqual(readLog({ src: "cc,desk" }).map((e) => e.src), ["cc", "desk"]);
assert.equal(readLog({ q: "MYBRAND" })[0].key, "mybrand-tiktok-2026-10-05-001");
assert.deepEqual(readLog({ n: 2 }).map((e) => e.msg), ["upload failed", "chat answered"]);   // the newest n, oldest first

// Age cut-off: an old entry is left out.
writeFileSync(LOG_FILE, JSON.stringify({ t: "2020-01-01T00:00:00.000Z", src: "x", lvl: "error", msg: "old" }) + "\n");
note("error", "new", {}, "x");
assert.deepEqual(readLog({ sinceMs: 3_600_000 }).map((e) => e.msg), ["new"]);

rmSync(dir, { recursive: true, force: true });
console.log("log ok");
