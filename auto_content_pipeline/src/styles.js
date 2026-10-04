// Account styles: a distinct posting style per account, so siblings of one brand never
// post near-duplicates. Accounts plan together by style group (default: their brand).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { askClaude } from "./llm.js";

export function groupAccounts(accounts, styles) {
  const groups = new Map();
  for (const a of accounts) {
    const g = styles[a.id]?.group ?? a.project;
    groups.set(g, [...(groups.get(g) ?? []), a]);
  }
  return groups;
}

export function stylePrompt({ project, accounts, siblings, briefs }) {
  return `You are designing distinct TikTok posting styles for one brand's accounts.

BRAND: ${JSON.stringify({ ...project, accounts: undefined }, null, 2)}

ACCOUNTS NEEDING A STYLE (with their TikTok Studio facts):
${JSON.stringify(accounts.map((a) => ({ id: a.id, handle: a.handle, brief: briefs[a.id] })), null, 2)}

SIBLING ACCOUNTS THAT ALREADY HAVE A STYLE (stay different from these):
${JSON.stringify(siblings.map((a) => ({ id: a.id, style: a.style })))}

Give each account a style that fits what already works for it and differs clearly from
every sibling: its own pillar (main content theme), voice, 2-4 formats, and one sentence on
what makes it different. "group" is the brand id unless two accounts share an audience so
closely that they must be planned together.

Respond with ONLY JSON:
{"styles":{"<account id>":{"group":"...","pillar":"...","voice":"...","formats":["..."],"differentiator":"..."}}}`;
}

export function proposeStyles(ctx) {
  const { data, model } = askClaude(stylePrompt(ctx));
  return { styles: data.styles ?? {}, model };
}

// Writes styles into one profile object in place; returns how many accounts changed.
export function applyStyles(profile, styles) {
  let n = 0;
  for (const a of profile.accounts ?? []) {
    if (styles[a.id]) { a.style = styles[a.id]; n++; }
  }
  return n;
}

// --accept-styles: copy a week's proposals into apps/<project>/profile.json.
export function acceptStyles(file) {
  if (!existsSync(file)) throw new Error(`no style proposals at ${file}`);
  const proposals = JSON.parse(readFileSync(file, "utf8"));
  let total = 0;
  for (const pid of new Set(Object.values(proposals).map((p) => p.project))) {
    const path = `apps/${pid}/profile.json`;
    const profile = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
    const styles = Object.fromEntries(Object.entries(proposals).filter(([, p]) => p.project === pid).map(([id, p]) => [id, p.style]));
    total += applyStyles(profile, styles);
    writeFileSync(path, `${JSON.stringify(profile, null, 2)}\n`);
  }
  return total;
}
