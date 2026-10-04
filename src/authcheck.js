// Read-only login check, per account. Writes account_health.ok and a screenshot.
//
//   npm run check -- all               every enabled account
//   npm run check -- mybrand              every account of one project
//   npm run check -- mybrand-instagram    one account
//
// A dead login here means the tick skips that ONE account tomorrow instead of
// burning a browser session and an attempt on it. A handle mismatch is recorded
// as a note, never as ok=0: the discovery selector is fragile, and a fragile
// selector must not be able to stop a healthy account.
import { mkdirSync } from "node:fs";
import { db, log } from "./db.js";
import { launch } from "./browser.js";
import { loadRegistry } from "./registry.js";
import { notify } from "./telegram.js";

const target = process.argv[2] || "all";
const reg = loadRegistry();
const accounts = reg.accounts.filter((a) =>
  a.enabled && (target === "all" || a.id === target || a.project === target));
if (!accounts.length) { console.error(`no enabled account matches "${target}"`); process.exit(1); }

mkdirSync("evidence/authcheck", { recursive: true });
const upsert = db.prepare(`INSERT INTO account_health (account, ok, note, checked_at)
                           VALUES (?,?,?,datetime('now'))
                           ON CONFLICT(account) DO UPDATE SET
                             ok=excluded.ok, note=excluded.note, checked_at=excluded.checked_at`);

let bad = 0;
const dead = [];
for (const a of accounts) {
  let ok = 1, note = null, ctx = null;
  try {
    const adapter = await import(`./platforms/${a.platform}.js`);
    if (adapter.checkApi) {
      const r = await adapter.checkApi(a);
      ok = r.ok; note = r.note;
      upsert.run(a.id, ok, note);
      log(null, "authcheck", `${a.id} ok=${ok}${note ? ` (${note})` : ""}`);
      console.log(`${a.id.padEnd(24)} ${ok ? "ok" : "LOGIN DEAD"}${note ? `  ${note}` : ""}`);
      if (!ok) { bad++; dead.push(`• ${a.id} (@${a.handle ?? "?"}): ${note}`); }
      continue;
    }
    ctx = await launch({ headless: false, profile: a.browser_profile });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await adapter.openComposer(page);
    await page.waitForTimeout(4_000);

    if (await adapter.isLoggedOut(page)) { ok = 0; note = `logged out — run: npm run login -- ${a.id}`; }
    else {
      const blocked = await adapter.isBlocked(page);
      if (blocked) { ok = 0; note = `${blocked} — resolve manually`; }
      else {
        const seen = await liveHandle(page);
        if (a.handle && seen && !seen.toLowerCase().includes(a.handle.toLowerCase())) {
          note = `declared ${a.handle}, session shows ${seen} — check the login before the next run`;
        }
      }
    }
    await page.screenshot({ path: `evidence/authcheck/${a.id}.png` }).catch(() => {});
  } catch (e) {
    ok = 0;
    note = `authcheck failed: ${e.message.slice(0, 160)}`;
  } finally {
    await ctx?.close().catch(() => {});
  }
  upsert.run(a.id, ok, note);
  log(null, "authcheck", `${a.id} ok=${ok}${note ? ` — ${note}` : ""}`);
  console.log(`${a.id.padEnd(24)} ${ok ? "ok" : "DEAD"}${note ? `  ${note}` : ""}`);
  if (!ok) { bad++; dead.push(`• ${a.id} (@${a.handle ?? "?"}): ${note}`); }
}
// The tick and the agents skip a dead account silently, so say it out loud.
if (dead.length) await notify(`🔒 cc-studio: ${dead.length} login(s) need you\n\n${dead.join("\n")}\n\nFix: npm run login -- <account>`);
process.exit(bad ? 1 : 0);

// Best-effort: the handle the session is actually logged in as.
async function liveHandle(page) {
  const alt = await page.locator('img[alt*="profile picture"]').first().getAttribute("alt").catch(() => null);
  if (alt) return alt.replace(/'s profile picture.*/i, "").trim();
  const href = await page.locator('a[href^="/@"]').first().getAttribute("href").catch(() => null);
  return href ? href.replace(/^\/@/, "").split("/")[0] : null;
}
