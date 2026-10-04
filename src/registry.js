// The registry: projects and social accounts, declared in apps/<project>/profile.json.
//
//   npm run registry          lint every project + account, exit 1 on any ERROR
//
// Nothing else in this repo may guess which account a job belongs to. A queue key is
// <account-id>-YYYY-MM-DD-NNN and that suffix is exactly 15 characters, so the account
// parses off the END — unambiguous even when the id itself contains hyphens or a
// platform token (instagram-tips-tiktok-2026-09-01-001 -> instagram-tips-tiktok).
import { readFileSync, readdirSync, existsSync } from "node:fs";

const KEY_RE = /^(.+)-(\d{4}-\d{2}-\d{2})-(\d{3})$/;

export function parseKey(key) {
  const m = KEY_RE.exec(key);
  return m ? { account: m[1], date: m[2], seq: Number(m[3]) } : null;
}

export function readJson(file) {
  // ponytail: BOM-tolerant everywhere — one BOM in a schedule.json killed two days of posts.
  return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
}

const DEFAULTS = {
  slots: ["18:00"],
  lead_days: 0,
  can_schedule: true,
  mode: "UPLOAD_ONLY",
  allow_final: false,
  enabled: true,
};

export function loadRegistry() {
  const errors = [], warnings = [], projects = [], accounts = [];
  if (!existsSync("apps")) return { projects, accounts, errors: ["apps/ directory missing"], warnings };

  for (const dir of readdirSync("apps", { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const file = `apps/${dir.name}/profile.json`;
    if (!existsSync(file)) continue;
    let p;
    try { p = readJson(file); } catch (e) { errors.push(`${file}: ${e.message}`); continue; }
    p.id ??= dir.name;
    p.workspace ??= "workspace";
    projects.push(p);

    for (const field of ["forbidden_claims", "language_note"]) {
      if (!p[field]) errors.push(`${file}: missing ${field} — the strategist reads it`);
    }
    // type "app" (default) markets a product: claims and CTA are contractual.
    // type "channel" grows a following with generated content: no claims list,
    // accuracy is enforced by prompt instead.
    if ((p.type ?? "app") !== "channel") {
      if (!p.approved_claims) errors.push(`${file}: missing approved_claims — the strategist reads it`);
      if (!p.cta?.primary) errors.push(`${file}: missing cta.primary`);
    }
    if (!p.content?.preferred_duration_seconds || !p.content?.preferred_styles) {
      errors.push(`${file}: missing content.preferred_duration_seconds / preferred_styles`);
    }
    if (!Array.isArray(p.accounts) || !p.accounts.length) {
      warnings.push(`${file}: no accounts declared — nothing will ever be posted for this project`);
      continue;
    }
    for (const raw of p.accounts) {
      const a = { ...DEFAULTS, ...raw, project: p.id };
      a.browser_profile ??= `${a.platform}-${p.id}`;
      a.workspace ??= `${p.workspace}/${a.id}`;
      a.render = p.render ?? null;
      accounts.push(a);
    }
  }

  const seen = new Map(), profiles = new Map(), handles = new Map();
  for (const a of accounts) {
    if (!a.id || !a.platform) { errors.push(`${a.project}: an account is missing id or platform`); continue; }
    if (seen.has(a.id)) errors.push(`duplicate account id "${a.id}" (${seen.get(a.id)} and ${a.project})`);
    seen.set(a.id, a.project);
    if (KEY_RE.test(a.id)) errors.push(`${a.id}: an account id must not end in -YYYY-MM-DD-NNN — keys would be ambiguous`);
    if (!a.slots?.length) errors.push(`${a.id}: slots must list at least one HH:MM`);

    const adapter = `src/platforms/${a.platform}.js`;
    if (!existsSync(adapter)) {
      (a.enabled ? errors : warnings).push(`${a.id}: platform "${a.platform}" has no adapter (${adapter} missing)`);
    }
    if (!a.enabled) continue;

    // Two brands must never share a login — invariant 7, enforced instead of commented.
    if (profiles.has(a.browser_profile)) {
      errors.push(`${a.id} and ${profiles.get(a.browser_profile)} share browser_profile "${a.browser_profile}"`);
    }
    profiles.set(a.browser_profile, a.id);
    const handleKey = `${a.platform}/${a.handle}`;
    if (a.handle && handles.has(handleKey)) {
      errors.push(`${a.id} and ${handles.get(handleKey)} both claim ${handleKey}`);
    }
    handles.set(handleKey, a.id);
    if (!existsSync(`browser-profile/${a.browser_profile}`)) {
      errors.push(`${a.id}: no login at browser-profile/${a.browser_profile} — run: npm run login -- ${a.id}`);
    }
  }

  return { projects, accounts, errors, warnings };
}

export function accountFor(key, reg = loadRegistry()) {
  const parsed = parseKey(key);
  return parsed ? reg.accounts.find((a) => a.id === parsed.account) ?? null : null;
}

// The next slot strictly after `after` that no other job already holds.
// `taken` is a Set of "YYYY-MM-DDTHH:mm" strings the caller already knows about.
export function nextSlot(account, { after = new Date(), taken = new Set() } = {}) {
  for (let day = 0; day < 14; day++) {
    // Calendar days, not 24 h steps: a clock change must not skip or repeat a date.
    const d = new Date(after.getFullYear(), after.getMonth(), after.getDate() + day, 12);
    const date = d.toLocaleDateString("sv");
    for (const hhmm of [...account.slots].sort()) {
      const at = `${date}T${hhmm}`;
      if (new Date(at) > after && !taken.has(at)) return at;
    }
  }
  return null;
}

if (import.meta.filename === process.argv[1]) {
  const { projects, accounts, errors, warnings } = loadRegistry();
  console.log(`${projects.length} project(s), ${accounts.length} account(s)\n`);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad("ACCOUNT", 26) + pad("PLATFORM", 11) + pad("PROFILE", 24) + pad("SLOTS", 18) + "FLAGS");
  for (const a of accounts) {
    const flags = [a.enabled ? null : "disabled", a.can_schedule ? null : "post-now",
      a.mode === "SCHEDULE" && a.allow_final ? "AUTO" : "manual-only"].filter(Boolean).join(" ");
    console.log(pad(a.id, 26) + pad(a.platform, 11) + pad(a.browser_profile, 24) + pad(a.slots.join(","), 18) + flags);
  }
  for (const w of warnings) console.log(`\nWARNING  ${w}`);
  for (const e of errors) console.log(`\nERROR    ${e}`);
  console.log(`\n${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(errors.length ? 1 : 0);
}
