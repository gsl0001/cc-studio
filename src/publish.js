// Generic publisher — processes ONE job from queue/ per run, on any platform.
//
// Queue contract (what the render step drops in):
//   queue/<key>/final.mp4        required, >=100KB
//   queue/<key>/caption.txt      required, hashtags inline
//   queue/<key>/schedule.json    only for accounts that can schedule
//
// The key is <account-id>-YYYY-MM-DD-NNN. The account is resolved through the
// registry (apps/<project>/profile.json) — never guessed, never defaulted. An
// unknown account or an unimplemented platform stops BEFORE a browser opens.
//
// Modes (per account, env may override for manual runs):
//   DRY_RUN      validate + log, never opens the browser
//   UPLOAD_ONLY  fill everything, STOP before the final button (human clicks it)
//   SCHEDULE     also clicks Schedule/Post — requires ALLOW_FINAL_PUBLISH=true
//
// Safety: STOP_AUTOMATION halts everything. Terminal statuses are never re-run.
// One job per run — the tick gives pacing.

import { existsSync, readFileSync, readdirSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { db, setStatus, log, TERMINAL } from "./db.js";
import { lifecycle, note } from "./log.js";
import { launch } from "./browser.js";
import { loadRegistry, accountFor, parseKey, readJson, nextSlot } from "./registry.js";

const ENV_MODE = process.env.MODE || null;
const ENV_ALLOW = process.env.ALLOW_FINAL_PUBLISH === "true";

lifecycle(process.argv.slice(2).join(" "));
main().catch((e) => { console.error(e); note("error", `publish failed: ${e?.stack ?? e}`); process.exit(1); });

async function main() {
  if (existsSync("STOP_AUTOMATION")) { console.log("STOP_AUTOMATION file present — exiting."); return; }

  const reg = loadRegistry();
  const picked = pickJob(reg);
  if (!picked) { console.log("Queue empty or nothing publishable."); return; }
  const { key, dir, account } = picked;

  // --- inputs ---------------------------------------------------------------
  const video = path.resolve(dir, "final.mp4");
  const captionFile = path.join(dir, "caption.txt");
  if (!existsSync(video) || !existsSync(captionFile)) return setStatus(key, "FAILED", "missing final.mp4 or caption.txt");
  if (statSync(video).size < 100_000) return setStatus(key, "FAILED", "final.mp4 suspiciously small (<100KB)");
  const caption = readFileSync(captionFile, "utf8").trim();
  if (!caption || /\$\{|\bplaceholder\b|TODO/i.test(caption)) {
    return setStatus(key, "FAILED", "caption empty or contains placeholder text");
  }

  const mode = ENV_MODE ?? account.mode;
  const allowFinal = ENV_MODE ? ENV_ALLOW : account.allow_final;
  let scheduledFor = readSchedule(dir);
  const isAigc = readMeta(dir)?.is_aigc ?? null;  // null = unlabeled legacy job
  // An account that cannot schedule must never carry a slot into the composer —
  // that dead-end burned a full upload per attempt on Instagram five times.
  if (scheduledFor && !account.can_schedule) {
    log(key, "schedule_ignored", `${account.id} posts now (can_schedule:false)`);
    scheduledFor = null;
  }
  // TikTok refuses times less than ~15 min out, and checks plus the button wait can take
  // ~16 min after this point: move anything closer than 30 min, same margin as queue.js.
  if (scheduledFor && new Date(scheduledFor) <= new Date(Date.now() + 30 * 60_000)) {
    scheduledFor = reslot(key, dir, account);
    if (!scheduledFor) return setStatus(key, "MANUAL_REVIEW", "slot has passed and no free future slot within 14 days");
  }

  db.prepare("UPDATE jobs SET video_path=?, caption=?, scheduled_for=?, account=? WHERE key=?")
    .run(video, caption, scheduledFor, account.id, key);
  log(key, "validated", `account=${account.id} mode=${mode} scheduled_for=${scheduledFor ?? "now"}`);

  if (mode === "DRY_RUN") { setStatus(key, "PLANNED", null); log(key, "dry_run_ok"); return; }

  // --- adapter, resolved before anything opens ------------------------------
  const adapterPath = `./platforms/${account.platform}.js`;
  if (!existsSync(path.join("src", "platforms", `${account.platform}.js`))) {
    return setStatus(key, "MANUAL_REVIEW", `platform "${account.platform}" is not implemented — no adapter`);
  }
  const adapter = await import(adapterPath);
  if (!adapter.api && !existsSync(`browser-profile/${account.browser_profile}`)) {
    return setStatus(key, "MANUAL_REVIEW",
      `no login at browser-profile/${account.browser_profile} — run: npm run setup -- ${account.id}`);
  }

  // --- claim ----------------------------------------------------------------
  // Atomic compare-and-swap: two runners may race for the same key; exactly one wins.
  const claimed = db.prepare(`UPDATE jobs SET status='UPLOADING', claimed_at=datetime('now'),
                                     attempts=attempts+1, updated_at=datetime('now')
                               WHERE key=? AND status IN ('PLANNED','FAILED') AND attempts < 3`).run(key);
  if (claimed.changes !== 1) { console.log(`${key}: not claimable (another runner has it, or 3 attempts used).`); return; }
  log(key, "claimed", `attempt ${db.prepare("SELECT attempts a FROM jobs WHERE key=?").get(key).a}`);

  const evidenceDir = path.join("evidence", key);
  mkdirSync(evidenceDir, { recursive: true });

  // API adapters publish over HTTP — no browser, no evidence screenshots.
  if (adapter.api) {
    const job = { key, account, video, caption, scheduledFor, log: (ev, d = "") => log(key, ev, d) };
    try {
      const r = await adapter.publishApi(job);
      setStatus(key, "PUBLISHED", null);
      log(key, "verified", r.permalink ?? r.mediaId);
    } catch (e) {
      const current = db.prepare("SELECT status FROM jobs WHERE key=?").get(key)?.status;
      if (current === "UPLOADING") setStatus(key, "FAILED", e.message.slice(0, 300));
    }
    return;
  }

  const ctx = await launch({ headless: false, profile: account.browser_profile });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const job = {
    key, account, ctx, page, video, caption, scheduledFor, mode, allowFinal, isAigc,
    shot: async (name) => {
      const p = path.join(evidenceDir, `${name}.png`);
      await page.screenshot({ path: p, fullPage: false }).catch(() => {});
      return p;
    },
    log: (event, detail = "") => log(key, event, detail),
    fail: async (reason) => { setStatus(key, "MANUAL_REVIEW", reason); },
  };

  try {
    await adapter.openComposer(page);

    if (await adapter.isLoggedOut(page)) {
      await job.shot("auth-failed");
      return void setStatus(key, "MANUAL_REVIEW", `not logged in — run: npm run setup -- ${account.id}`);
    }
    const blocked = await adapter.isBlocked(page);
    if (blocked) {
      await job.shot("security-challenge");
      return void setStatus(key, "MANUAL_REVIEW", `${blocked} — resolve manually, never bypass`);
    }

    await adapter.publish(page, job);
  } catch (e) {
    await job.shot("error").catch(() => {});
    const current = db.prepare("SELECT status FROM jobs WHERE key=?").get(key)?.status;
    // Never downgrade a post-click status: UNKNOWN/SCHEDULED/PUBLISHED stand.
    if (current === "UPLOADING") setStatus(key, "FAILED", e.message.slice(0, 300));
  } finally {
    // The runner owns the context on every path — adapters never close it.
    await ctx.close().catch(() => {});
  }
}

function readMeta(dir) {
  const f = path.join(dir, "meta.json");
  if (!existsSync(f)) return null;
  try { return readJson(f); }
  catch (e) { console.error(`${f}: ${e.message} — ignoring`); return null; }
}

function readSchedule(dir) {
  const f = path.join(dir, "schedule.json");
  if (!existsSync(f)) return null;
  try { return readJson(f).scheduled_for ?? null; }
  catch (e) { console.error(`${f}: ${e.message} — treating as post-now`); return null; }
}

// A slot that has already passed cannot be selected in any platform's picker; move
// the job to the next free future slot and rewrite the file BEFORE a browser opens.
// (13 of 27 MANUAL_REVIEW rows were this exact failure.)
function reslot(key, dir, account) {
  const taken = new Set(db.prepare(
    "SELECT scheduled_for s FROM jobs WHERE account=? AND scheduled_for IS NOT NULL AND status NOT IN ('FAILED')"
  ).all(account.id).map((r) => r.s));
  const at = nextSlot(account, { taken });
  if (!at) return null;
  writeFileSync(path.join(dir, "schedule.json"), JSON.stringify({ scheduled_for: at }) + "\n");
  db.prepare("UPDATE jobs SET scheduled_for=? WHERE key=?").run(at, key);
  log(key, "reslotted", `slot had passed -> ${at}`);
  return at;
}

// Oldest claimable queue directory whose account is declared and enabled.
// JOB_KEY forces one job (future dates included); ACCOUNT scopes the scan.
function pickJob(reg) {
  if (!existsSync("queue")) return null;
  const today = new Date().toLocaleDateString("sv");
  const forced = process.env.JOB_KEY;
  const only = process.env.ACCOUNT;

  const consider = (key) => {
    const dir = path.join("queue", key);
    if (!existsSync(dir)) return null;
    const account = accountFor(key, reg);
    if (!account) {
      register(key, null);
      setStatus(key, "MANUAL_REVIEW", `unregistered account for key ${key} — declare it in apps/*/profile.json`);
      return null;
    }
    if (reg.errors.some((e) => e.startsWith(`${account.id}:`))) {
      console.log(`${key}: ${account.id} has config errors — fix them and re-run (npm run registry).`);
      return null;
    }
    register(key, account.id);
    const row = db.prepare("SELECT status, attempts FROM jobs WHERE key=?").get(key);
    if (TERMINAL.includes(row.status) || row.attempts >= 3) return null;
    return { key, dir, account };
  };

  if (forced) return consider(forced);

  const dirs = readdirSync("queue", { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name).sort();
  const candidates = [];
  for (const key of dirs) {
    const parsed = parseKey(key);
    if (only && parsed?.account !== only) continue;
    const account = accountFor(key, reg);
    // The key carries its intended date; lead_days is how far ahead we may work.
    if (parsed && account) {
      const due = new Date(`${parsed.date}T00:00`);
      due.setDate(due.getDate() - (account.lead_days ?? 0));
      if (due.toLocaleDateString("sv") > today) continue;
      if (!account.enabled) continue;
    }
    const job = consider(key);
    if (job) candidates.push(job);
  }
  // Earliest intended date first, so a backlog drains in order instead of alphabetically.
  candidates.sort((a, b) => (parseKey(a.key)?.date ?? "").localeCompare(parseKey(b.key)?.date ?? ""));
  return candidates[0] ?? null;
}

function register(key, account) {
  db.prepare("INSERT OR IGNORE INTO jobs (key, account, status) VALUES (?,?,'PLANNED')").run(key, account);
}
