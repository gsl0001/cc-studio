// The daily TikTok canary. Runs the real upload path (scripts' own publish(): file, caption,
// AI label, schedule pickers, content checks) on a test video in one account's Studio and stops
// before the Schedule button, then checks the button is there. A moved selector is found here,
// the day it moves, instead of on a week of real posts (2026-10-05: the date picker failed every
// post for days 10-23). Nothing is posted; the draft is left unsaved.
//
//   node scripts/canary.mjs [account-id]     default: the scheduling TikTok accounts, one a day in turn
//
// Started by the pulse once a day. Holds METRICS_RUNNING while it runs (the tick stands down).
// Result: data/canary.json. Telegram hears about a failure (with a screenshot) and the recovery.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch } from "../src/browser.js";
import { waitEnabled } from "../src/platforms/common.js";
import { log } from "../src/db.js";
import { lifecycle, note } from "../src/log.js";
import { loadRegistry } from "../src/registry.js";
import { channel, notify } from "../src/telegram.js";

const RESULT = "data/canary.json", VIDEO = "data/canary.mp4", SHOTS = "evidence/canary";
const DAY = 86_400_000;
const pad = (n) => String(n).padStart(2, "0");
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// The account and target for today. The date moves through 2..9 days out, so over a week
// the pickers see one- and two-digit days, this month and the next.
export function plan(accounts, now = new Date(), only = null) {
  const n = Math.floor((now.getTime() - now.getTimezoneOffset() * 60_000) / DAY);
  const account = only ? accounts.find((a) => a.id === only) : accounts[n % accounts.length];
  const day = new Date(now.getTime() + (2 + (n % 8)) * DAY);
  return { account, scheduledFor: `${localDate(day)}T17:05` };
}

async function sendShot(file) {
  const c = channel();
  if (!c || !file || !existsSync(file)) return;
  const form = new FormData();
  form.append("chat_id", c.chatId);
  form.append("photo", new Blob([readFileSync(file)], { type: "image/png" }), "canary.png");
  await fetch(`https://api.telegram.org/bot${c.token}/sendPhoto`, { method: "POST", body: form }).catch(() => {});
}

if (import.meta.filename === process.argv[1]) {
  if (process.argv[2] === "test") {
    const { default: assert } = await import("node:assert/strict");
    const accts = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const days = new Set(), ids = new Set();
    for (let i = 0; i < 8; i++) {
      const p = plan(accts, new Date(2026, 9, 5 + i, 9));
      ids.add(p.account.id); days.add(p.scheduledFor.slice(0, 10));
      assert.match(p.scheduledFor, /^\d{4}-\d{2}-\d{2}T17:05$/);
      const ahead = (Date.parse(p.scheduledFor) - new Date(2026, 9, 5 + i, 9).getTime()) / DAY;
      assert.ok(ahead > 1 && ahead < 10, "inside TikTok's 10-day window");
    }
    assert.equal(ids.size, 3, "every account gets a turn");
    assert.ok(days.size >= 4, "the target date moves");
    assert.equal(plan(accts, new Date(), "b").account.id, "b");
    console.log("canary ok");
    process.exit(0);
  }

  lifecycle(process.argv.slice(2).join(" "));
  const accounts = loadRegistry().accounts.filter((a) => a.enabled && a.platform === "tiktok" && a.can_schedule && a.mode === "SCHEDULE");
  const { account, scheduledFor } = plan(accounts, new Date(), process.argv[2] ?? null);
  if (!account) { console.error("no scheduling TikTok account to check"); process.exit(1); }

  mkdirSync(SHOTS, { recursive: true });
  // A plain 4-second portrait clip with sound, made once.
  if (!existsSync(VIDEO)) execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x1d6b59:s=1080x1920:d=4:r=30",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", VIDEO]);

  const before = existsSync(RESULT) ? JSON.parse(readFileSync(RESULT, "utf8")) : null;
  const key = `canary-${account.id}`, events = [], names = [];
  const result = { at: new Date().toISOString(), account: account.id, scheduledFor, ok: false, step: null, reason: null, shot: null };
  process.env.AUTO = "1";   // a hand-over to a human returns at once
  writeFileSync("METRICS_RUNNING", String(process.pid));
  const ctx = await launch({ headless: false, profile: account.browser_profile });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const shot = async (name) => { const p = join(SHOTS, `${account.id}-${name}.png`); await page.screenshot({ path: p }).catch(() => {}); return p; };
  try {
    const adapter = await import("../src/platforms/tiktok.js");
    await adapter.openComposer(page);
    if (await adapter.isLoggedOut(page)) throw Object.assign(new Error("logged out (the login check reports it too)"), { step: "login" });
    const blocked = await adapter.isBlocked(page);
    if (blocked) throw Object.assign(new Error(blocked), { step: "login" });
    const job = {
      key, account, page, video: VIDEO, caption: "auto_bot daily check, not a real post #test", scheduledFor,
      mode: "UPLOAD_ONLY", allowFinal: false, isAigc: true,
      // handToHuman() closes the context it's given; this one stays open for the last check.
      ctx: { close: async () => {}, on: () => {} },
      shot, log: (event, detail = "") => { names.push(event); events.push(detail ? `${event}: ${detail}` : event); log(key, event, detail); },
      fail: async (reason) => { events.push(`fail: ${reason}`); },
    };
    await adapter.publish(page, job);
    if (!names.includes("stopped_before_final")) {
      const why = events.findLast((e) => /^handed_to_human|^fail|not_found|unconfirmed|mismatch|not_reached/.test(e)) ?? events.at(-1);
      throw Object.assign(new Error(why ?? "the upload stopped early"), { step: names.at(-1) });
    }
    // The same button and wait the real final click uses (finalAction in SCHEDULE mode).
    const button = page.getByRole("button", { name: /schedule/i }).first();
    if (!(await waitEnabled(button, 30_000))) throw Object.assign(new Error("the Schedule button isn't there or isn't enabled"), { step: "final button" });
    Object.assign(result, { ok: true, step: "final button", reason: null });
  } catch (e) {
    result.step = e.step ?? names.at(-1) ?? "start";
    result.reason = String(e.message).replace(/\x1b\[[0-9;]*m/g, "").split("\n")[0].slice(0, 300);
    result.shot = await shot("failed");
  } finally {
    await ctx.close().catch(() => {});
    rmSync("METRICS_RUNNING", { force: true });
  }
  result.events = events.slice(-30);
  writeFileSync(RESULT, JSON.stringify(result, null, 2) + "\n");
  log(null, "canary", `${account.id} ${result.ok ? "ok" : `FAILED at ${result.step}: ${result.reason}`}`);
  note(result.ok ? "info" : "error", `canary ${account.id}: ${result.ok ? "the upload path works" : `failed at ${result.step}: ${result.reason}`}`);
  if (!result.ok) {
    await notify(`🐤 TikTok check failed on ${account.id}, at "${result.step}":\n${result.reason}\n\nReal uploads would fail the same way. Nothing was posted. The steps are in data/canary.json.`);
    await sendShot(result.shot);
  } else if (before && !before.ok) await notify(`🐤 TikTok check works again (${account.id}): file, caption, AI label, schedule pickers and the Schedule button all fine.`);
  console.log(result.ok ? `canary ok: ${account.id}, scheduled-for ${scheduledFor} set, Schedule button ready (not clicked)` : `canary FAILED at ${result.step}: ${result.reason}`);
  process.exit(result.ok ? 0 : 1);
}
