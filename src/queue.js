// Put a finished render into the queue, atomically.
//
//   node src/queue.js <key> <path-to-final.mp4> [caption-file]
//
// Everything the publisher reads is machine-written here (JSON.stringify, no BOM —
// one hand-written BOM killed two days of posts) and staged in queue/.tmp-<key>/,
// then renamed into place, so a publish run can never see a half-written job.
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { db, log } from "./db.js";
import { loadRegistry, accountFor, parseKey, nextSlot } from "./registry.js";
import { inspect, check, COOLDOWN } from "./library.js";

const argv = process.argv.slice(2);
const force = argv.includes("--force");       // post a known duplicate on purpose
const [key, videoPath, captionPath] = argv.filter((a) => a !== "--force");
if (!key || !videoPath) {
  console.error("usage: node src/queue.js <key> <final.mp4> [caption.txt] [--force]");
  process.exit(1);
}

const reg = loadRegistry();
const account = accountFor(key, reg);
if (!account) { console.error(`${key}: no declared account — check apps/*/profile.json and npm run registry`); process.exit(1); }
if (!existsSync(videoPath)) { console.error(`${videoPath}: not found`); process.exit(1); }
if (statSync(videoPath).size < 100_000) { console.error(`${videoPath}: under 100KB — that is not a finished render`); process.exit(1); }

// The caption: an explicit file, or plans/<key>.json written by the strategist.
let caption = captionPath && existsSync(captionPath) ? readFileSync(captionPath, "utf8").trim() : null;
if (!caption) {
  const capPlanFile = `plans/${key}.json`;
  if (!existsSync(capPlanFile)) { console.error(`no caption file and no ${capPlanFile}`); process.exit(1); }
  const capPlan = JSON.parse(readFileSync(capPlanFile, "utf8").replace(/^\ufeff/, ""));
  caption = [capPlan.caption, (capPlan.hashtags ?? []).join(" ")].filter(Boolean).join(" ").trim();
}
if (!caption || /\$\{|\bplaceholder\b|TODO/i.test(caption)) {
  console.error("caption is empty or still contains placeholder text");
  process.exit(1);
}

const dest = path.join("queue", key);
if (existsSync(dest)) { console.error(`${dest} already exists — the key is the idempotency key, pick the next NNN`); process.exit(1); }

// Catalogue the render and ask the library whether we have posted it before.
// This is the one chokepoint every finished video passes through, so it is the
// only place the duplicate check has to exist. It runs after the cheap checks:
// hashing and three ffmpeg seeks are not worth spending on a mistyped key.
const project = reg.projects.find((p) => p.id === account.project);
const item = inspect(videoPath);
const findings = check(item, account.id, { ...COOLDOWN, ...(project?.content?.cooldowns ?? {}) });
for (const f of findings) console.error(`${f.level}  ${f.message}`);
if (findings.some((f) => f.level === "BLOCK") && !force) {
  console.error("refusing to queue a duplicate — pass --force if you mean it");
  process.exit(1);
}

const tmp = path.join("queue", `.tmp-${key}`);
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
copyFileSync(videoPath, path.join(tmp, "final.mp4"));
writeFileSync(path.join(tmp, "caption.txt"), caption + "\n", "utf8");

// The AI-disclosure decision travels with the job: the strategist decides per
// video, the platform adapter ticks the toggle. A job queued from a bare
// caption file with no plan carries no flag — the publisher logs that.
const planFile = `plans/${key}.json`;
if (existsSync(planFile)) {
  const plan = JSON.parse(readFileSync(planFile, "utf8").replace(/^\ufeff/, ""));
  if (typeof plan.is_aigc === "boolean") {
    writeFileSync(path.join(tmp, "meta.json"), JSON.stringify({ is_aigc: plan.is_aigc }) + "\n", "utf8");
  }
}

// Only accounts that can actually schedule get a slot; for the others the tick
// releases the job at its slot time and the platform posts it immediately.
let slot = null;
if (account.can_schedule) {
  const taken = new Set(db.prepare(
    "SELECT scheduled_for s FROM jobs WHERE account=? AND scheduled_for IS NOT NULL AND status NOT IN ('FAILED')"
  ).all(account.id).map((r) => r.s));
  // The key carries the intended day; never hand back a slot before it, or the
  // job would sit unreleased until its date and then be reslotted for being stale.
  const intended = new Date(`${parseKey(key).date}T00:00`);
  const after = intended > new Date() ? intended : new Date();
  // The weekly plan picks a time per post; keep it when it is still ahead and free.
  const plan = existsSync(`plans/${key}.json`) ? JSON.parse(readFileSync(`plans/${key}.json`, "utf8").replace(/^﻿/, "")) : {};
  // TikTok's picker has 5-minute steps and refuses times less than ~15 minutes out.
  // Local wall-clock arithmetic (Date's setters), so the two clock-change days keep 20:00 at 20:00.
  const [h, m] = (plan.post_at ?? "").split(":").map(Number);
  let planned = null;
  if (plan.day && Number.isInteger(h) && Number.isInteger(m)) {
    const [Y, M, D] = plan.day.split("-").map(Number);
    const t = new Date(Y, M - 1, D, h, Math.ceil(m / 5) * 5);
    const pad = (n) => String(n).padStart(2, "0");
    planned = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`;
  }
  slot = planned && new Date(planned) > new Date(Date.now() + 30 * 60_000) && !taken.has(planned) ? planned : nextSlot(account, { after, taken });
  if (slot) writeFileSync(path.join(tmp, "schedule.json"), JSON.stringify({ scheduled_for: slot }) + "\n", "utf8");
}

// Same volume, so this is atomic on NTFS. Antivirus can hold a handle on a
// freshly written mp4 for a moment — retry rather than fail the whole render.
for (let i = 1; ; i++) {
  try { renameSync(tmp, dest); break; }
  catch (e) {
    if (i >= 5) throw e;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
}

// scheduled_for goes on the row too, or the next queue call cannot see this slot
// as taken and hands the same time to two jobs.
// Upsert: the tick's sweep may have registered the new directory a moment earlier with
// no slot or sha, which would leave the slot looking free and the duplicate check blind.
db.prepare(`INSERT INTO jobs (key, account, status, scheduled_for, content_sha) VALUES (?,?,'PLANNED',?,?)
            ON CONFLICT(key) DO UPDATE SET scheduled_for=excluded.scheduled_for, content_sha=excluded.content_sha, account=excluded.account`)
  .run(key, account.id, slot, item.sha);
log(key, "queued", `account=${account.id} slot=${slot ?? "post-now"}`);
console.log(`${dest} ready — ${slot ? `scheduled for ${slot}` : "posts at its next release time"}`);
