// What both setups share (the chat page, scripts/setup-gui.mjs, and the terminal wizard,
// scripts/setup.mjs): turning answers into a project profile, and writing the files.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, DEFAULTS, ROOT, rootPath, tool } from "../src/config.js";

export const VOICES = [["cc_bright", "cute and bright"], ["cc_chill", "cute and chill"], ["cc_mellow", "mellow"], ["af_heart", "warm (female)"]];
export const COLORS = ["charcoal", "snow", "sky", "mint", "lavender", "pink", "peach", "yellow"];   // cc's body variants (cc-avatar/body_<colour>.png)
export const PLATFORMS = [["tiktok", "TikTok (uploads and schedules through TikTok Studio)"], ["instagram", "Instagram (browser upload, posts right away)"],
  ["instagram-api", "Instagram via the official Graph API (see docs/instagram-api-setup.md)"]];

export const slug = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "project";
export const times = (s) => String(s).split(/[\s,]+/).filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t));
const list = (v) => (Array.isArray(v) ? v : String(v ?? "").split(/\r?\n|,/)).map((s) => s.trim()).filter(Boolean);

export const existingProjects = () => (existsSync(join(ROOT, "apps")) ? readdirSync(join(ROOT, "apps")) : [])
  .filter((d) => d !== "example" && existsSync(join(ROOT, "apps", d, "profile.json")));

// Answers -> apps/<id>/profile.json. `a` holds what the user typed; anything missing takes its default.
export function makeProfile(a) {
  const id = slug(a.id || a.name);
  const p = { id, name: a.name, type: a.type === "channel" ? "channel" : "app", category: "", site_url: a.site_url ?? "", positioning: {}, languages: ["en"] };
  p.positioning.one_liner = a.one_liner ?? "";
  p.positioning.audience = list(a.audience);
  if (p.type === "app") {
    p.approved_claims = list(a.approved_claims);
    p.cta = { primary: a.cta || "Link in bio" };
  }
  p.forbidden_claims = list(a.forbidden_claims);
  p.language_note = a.language_note || "English only.";
  const [lo, hi] = String(a.duration || "8-20").split(/\D+/).map(Number);
  p.content = { preferred_duration_seconds: [lo || 8, hi || 20], preferred_styles: ["problem_solution", "feature_demo", "pov_scenario"] };
  if (a.workspace && a.workspace !== `${DEFAULTS.paths.workspaces}/${id}`) p.video_workspace = a.workspace;
  const say = String(a.pronounce ?? "").split("=").map((s) => s.trim());
  if (say.length === 2 && say[0] && say[1]) p.pronounce = { [say[0]]: say[1] };
  p.accounts = [];
  for (const x of a.accounts ?? []) {
    const platform = PLATFORMS.some(([k]) => k === x.platform) ? x.platform : "tiktok";
    const handle = String(x.handle ?? "").replace(/^@/, "").trim();
    let aid = `${id}-${platform === "instagram-api" ? "instagram" : platform}`;
    if (p.accounts.some((y) => y.id === aid)) aid = `${aid}-${slug(handle)}`;
    const auto = x.auto !== false;
    const acc = { id: aid, name: x.name || (p.accounts.length ? `${a.name} ${handle}` : a.name), platform, handle,
      slots: times(x.slots ?? "18:00"), can_schedule: platform === "tiktok", lead_days: platform === "tiktok" ? 7 : 0,
      mode: auto ? "SCHEDULE" : "UPLOAD_ONLY", allow_final: auto, enabled: true };
    if (!acc.slots.length) acc.slots = ["18:00"];
    if (x.pillar) acc.style = { group: id, pillar: x.pillar, voice: x.voice || "friendly, short spoken lines", formats: [...p.content.preferred_styles], differentiator: "" };
    p.accounts.push(acc);
  }
  return p;
}

// .env text with our keys set (each line kept; a commented-out key is filled in place).
export function mergeEnv(text, values) {
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue;
    const re = new RegExp(`^#?\\s*${k}=.*$`, "m");
    text = re.test(text) ? text.replace(re, () => `${k}=${v}`) : `${text.trimEnd()}\n${k}=${v}\n`;
  }
  return text;
}

// Writes everything: the projects (a taken id gets a suffix), studio.config.json, .env and the
// account sections of CONTEXT.md. Returns the projects written and their accounts.
export function saveSetup({ cfg, env = {}, profiles = [] }) {
  const written = [];
  for (const p of profiles) {
    let id = p.id, n = 2;
    while (existsSync(join(ROOT, "apps", id))) id = `${p.id}-${n++}`;
    if (id !== p.id) { for (const acc of p.accounts) { acc.id = acc.id.replace(p.id, id); if (acc.style) acc.style.group = id; } p.id = id; }
    mkdirSync(join(ROOT, "apps", id), { recursive: true });
    writeFileSync(join(ROOT, "apps", id, "profile.json"), JSON.stringify(p, null, 2) + "\n");
    const ws = rootPath(p.video_workspace ?? `${cfg.paths.workspaces}/${id}`);
    mkdirSync(join(ws, "assets"), { recursive: true });
    if (!existsSync(join(ws, "README.md"))) writeFileSync(join(ws, "README.md"), `# ${p.name}: video workspace\n\nPut real material here for the creator to build videos from: \`assets/\` holds logos, screenshots,\nproduct shots, screen recordings and photos. Add brand rules below (colours, fonts, words to avoid);\nthe creator reads this file before every video.\n\n## Brand rules\n\n- \n`);
    written.push({ id, name: p.name, workspace: ws, accounts: p.accounts });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
  const envFile = join(ROOT, ".env");
  writeFileSync(envFile, mergeEnv(readFileSync(existsSync(envFile) ? envFile : join(ROOT, ".env.example"), "utf8"), env));
  const ctxFile = rootPath(cfg.paths.context);
  let ctx = existsSync(ctxFile) ? readFileSync(ctxFile, "utf8") : "# Account context\n\nFacts per account that the strategist and the creator read every time. Keep it short and current.\n";
  for (const a of written.flatMap((w) => w.accounts).filter((x) => !ctx.includes(`## ${x.id}`))) {
    ctx += `\n## ${a.id} (${a.name})\n\n**Audience:** \n**Search terms people use:** \n**Captions:** \n\n**Now** (update after each insights run):\n- Followers: -, median views: -, median 3-second retention: -\n- What works: (nothing measured yet)\n- What fails: (nothing measured yet)\n`;
  }
  mkdirSync(join(ctxFile, ".."), { recursive: true });
  writeFileSync(ctxFile, ctx);
  return written;
}

// Telegram: the bot's username for a token (null if refused), and the latest chat that messaged it.
export const telegramMe = (token) => fetch(`https://api.telegram.org/bot${token}/getMe`).then((r) => r.json()).then((j) => (j.ok ? j.result.username : null)).catch(() => null);
// Returns { id, name } so the user can check the message was theirs (anyone can message a bot).
export const telegramChat = (token, wait = 5) => fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=${wait}`).then((r) => r.json())
  .then((u) => { const c = u?.result?.map((x) => x.message?.chat).filter(Boolean).at(-1); return c ? { id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(" ") || c.title || (c.username ? `@${c.username}` : String(c.id)) } : null; })
  .catch(() => null);

export const pythonGuess = (cfg) => (cfg.paths.python !== DEFAULTS.paths.python ? cfg.paths.python : spawnSync("python", ["--version"]).status === 0 ? "python" : "py");
export const pythonReady = (py) => spawnSync(tool(py), ["-c", "import cv2, numpy, PIL"]).status === 0;

// The steps after saving: [command, args] run from the repo root. `arg` is the account to log
// in to, or the Python to install the packages into.
export function stepCommand(step, arg, cfg) {
  return {
    login: [process.execPath, ["src/setup.js", arg]],
    avatar: [process.execPath, ["scripts/avatar.mjs"]],
    voice: [process.execPath, ["scripts/voice-install.mjs"]],
    tasks: [process.execPath, ["scripts/tasks.mjs", "install"]],
    doctor: [process.execPath, ["scripts/doctor.mjs"]],
    pydeps: [tool(arg || cfg.paths.python), ["-m", "pip", "install", "opencv-python", "numpy", "pillow"]],
  }[step];
}

if (process.argv[1]?.endsWith("setup-core.mjs")) {   // self-check: node scripts/setup-core.mjs
  const assert = (await import("node:assert/strict")).default;
  const p = makeProfile({ name: "Acme Notes", one_liner: "Notes.", audience: "students, writers", approved_claims: "Works offline.\nFree.",
    duration: "10-25", pronounce: "Acme=Ack-me", accounts: [{ platform: "tiktok", handle: "@acme", slots: "9:00, 18:00 25:00" }, { platform: "tiktok", handle: "acme2", auto: false, pillar: "tips" }] });
  assert.equal(p.id, "acme-notes");
  assert.deepEqual(p.positioning.audience, ["students", "writers"]);
  assert.deepEqual(p.approved_claims, ["Works offline.", "Free."]);
  assert.deepEqual(p.content.preferred_duration_seconds, [10, 25]);
  assert.deepEqual(p.pronounce, { Acme: "Ack-me" });
  assert.deepEqual(p.accounts.map((a) => a.id), ["acme-notes-tiktok", "acme-notes-tiktok-acme2"]);
  assert.deepEqual(p.accounts[0].slots, ["18:00"]);   // 9:00 needs two digits, 25:00 is no time
  assert.equal(p.accounts[0].handle, "acme");
  assert.equal(p.accounts[1].mode, "UPLOAD_ONLY");
  assert.equal(p.accounts[1].style.pillar, "tips");
  assert.equal(makeProfile({ name: "Chan", type: "channel" }).cta, undefined);
  assert.equal(mergeEnv("A=1\n# B=\n", { B: "2", C: "3", D: undefined }), "A=1\nB=2\nC=3\n");
  console.log("setup-core ok");
}
