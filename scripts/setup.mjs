// The setup wizard: answers a few questions and writes your configuration.
//
//   npm run setup
//
// Writes studio.config.json (settings), .env (secrets), apps/<project>/profile.json (one per
// brand), content/CONTEXT.md (account facts) and each project's video workspace folder, then
// offers the next steps: logging in to each account, cc's avatar and voice, the scheduled
// tasks, and a health check. Safe to re-run: current values are the defaults, and existing
// projects are kept (add more, or edit their profile.json by hand).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { CONFIG_FILE, DEFAULTS, ROOT, config as current, rootPath, tool } from "../src/config.js";

const rl = createInterface({ input: stdin, output: stdout });
rl.on("SIGINT", () => { console.log("\nSetup stopped; nothing more was written."); process.exit(130); });
const bold = (s) => `\x1b[1m${s}\x1b[0m`, dim = (s) => `\x1b[2m${s}\x1b[0m`;

// Answers come from a queue of lines, so piped answers work too (npm run setup < answers.txt):
// readline drops lines that arrive while no question is waiting. At the end of piped input
// every remaining question takes its default.
const queue = [], waiting = [];
let closed = false;
rl.on("line", (l) => (waiting.length ? waiting.shift()(l) : queue.push(l)));
rl.on("close", () => { closed = true; while (waiting.length) waiting.shift()(""); });
function question(prompt) {
  stdout.write(prompt);
  if (queue.length) { const l = queue.shift(); if (!stdin.isTTY) stdout.write(`${l}\n`); return Promise.resolve(l); }
  if (closed) { stdout.write("\n"); return Promise.resolve(""); }
  return new Promise((r) => waiting.push(r));
}
async function ask(q, def = "") {
  const a = (await question(`${q}${def !== "" ? dim(` [${def}]`) : ""}: `)).trim();
  return a === "" ? String(def) : a;
}
async function yes(q, def = true) {
  const a = (await question(`${q} ${dim(def ? "[Y/n]" : "[y/N]")}: `)).trim().toLowerCase();
  return a === "" ? def : a.startsWith("y");
}
async function lines(q, def = []) {   // one item per line, a blank line ends
  console.log(`${q} ${dim("(one per line, an empty line to finish" + (def.length ? ", or just Enter to keep the current list" : "") + ")")}`);
  const out = [];
  for (;;) { const a = (await question("  - ")).trim(); if (!a) break; out.push(a); }
  return out.length ? out : def;
}
async function choose(q, options, def = 0) {
  options.forEach((o, i) => console.log(`  ${i + 1}. ${o[1]}`));
  const a = await ask(q, def + 1);
  const i = Number(a) - 1;
  return options[i >= 0 && i < options.length ? i : def][0];
}
const slug = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "project";
const times = (s) => s.split(/[\s,]+/).filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t));
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });

// .env: keep every line, set or add our keys.
function writeEnv(values) {
  const file = join(ROOT, ".env");
  let text = existsSync(file) ? readFileSync(file, "utf8") : readFileSync(join(ROOT, ".env.example"), "utf8");
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue;
    const re = new RegExp(`^#?\\s*${k}=.*$`, "m");
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : `${text.trimEnd()}\n${k}=${v}\n`;
  }
  writeFileSync(file, text);
}

// ---------------------------------------------------------------------------------------
console.log(`\n${bold("cc-studio setup")}
Plans your week of short videos, makes each one with Claude, sends it to you for a yes or no,
and schedules it on TikTok and Instagram. Answer what you can; Enter keeps the value shown.
Everything is written to plain files you can edit later (see docs/configuration.md).\n`);

const cfg = structuredClone(current);
const env = {};
const newAccounts = [], newProjects = [];

// ---------------------------------------------------------------- projects
const existing = existsSync(join(ROOT, "apps")) ? readdirSync(join(ROOT, "apps")).filter((d) => d !== "example" && existsSync(join(ROOT, "apps", d, "profile.json"))) : [];
console.log(bold("1. Your projects") + dim("  (a brand, product or channel; each has its own accounts)"));
if (existing.length) console.log(`You have: ${existing.join(", ")}.`);
let addProject = existing.length ? await yes("Add another project?", false) : true;
while (addProject) {
  const name = await ask("Project name (e.g. Acme Notes)");
  let id = slug(await ask("Short id, used in file names", slug(name)));
  while (existsSync(join(ROOT, "apps", id))) id = slug(await ask(`"${id}" exists; another id`, `${id}-2`));
  const type = await choose("Is it", [["app", "a product or app you market (claims and a call to action)"], ["channel", "a channel you grow with content (no product)"]]);
  const p = { id, name, type, category: "", site_url: "", positioning: {}, languages: ["en"] };
  p.positioning.one_liner = await ask("In one sentence, what is it?");
  p.positioning.audience = (await ask("Who is it for? (comma-separated)")).split(",").map((s) => s.trim()).filter(Boolean);
  p.site_url = await ask("Website (optional)", "");
  if (type === "app") {
    p.approved_claims = await lines("What may videos claim? Only true, provable statements, e.g. 'Works offline.'");
    p.cta = { primary: await ask("Call to action at the end of each video", "Link in bio") };
  }
  p.forbidden_claims = await lines("What must videos never claim? e.g. 'the fastest', 'uses AI'");
  p.language_note = await ask("Language", "English only.");
  const [lo, hi] = (await ask("Video length range in seconds", "8-20")).split(/\D+/).map(Number);
  p.content = { preferred_duration_seconds: [lo || 8, hi || 20], preferred_styles: ["problem_solution", "feature_demo", "pov_scenario"] };
  const ws = await ask("Folder with this project's assets (logos, screenshots, clips)", `${cfg.paths.workspaces}/${id}`);
  if (ws !== `${cfg.paths.workspaces}/${id}`) p.video_workspace = ws;
  const say = await ask("A word the voice should say differently? Write it as Word=Sounds-like (optional)", "");
  if (/=/.test(say)) p.pronounce = Object.fromEntries([say.split("=").map((s) => s.trim())]);

  p.accounts = [];
  console.log(bold(`\n  Accounts for ${name}`));
  let addAccount = true;
  while (addAccount) {
    const platform = await choose("  Platform", [["tiktok", "TikTok (uploads and schedules through TikTok Studio)"], ["instagram", "Instagram (browser upload, posts right away)"], ["instagram-api", "Instagram via the official Graph API (see docs/instagram-api-setup.md)"]]);
    const handle = (await ask("  Handle, without @")).replace(/^@/, "");
    let aid = `${id}-${platform === "instagram-api" ? "instagram" : platform}`;
    if (p.accounts.some((a) => a.id === aid)) aid = `${aid}-${slug(handle)}`;
    const a = { id: aid, name: await ask("  What you call this account", p.accounts.length ? `${name} ${handle}` : name), platform, handle };
    a.slots = times(await ask("  Posting times, 24 h (comma-separated)", "18:00"));
    if (!a.slots.length) a.slots = ["18:00"];
    a.can_schedule = platform === "tiktok";
    a.lead_days = platform === "tiktok" ? 7 : 0;
    const auto = await yes("  Post automatically after you approve each video? (No = cc-studio uploads, you press Post)", true);
    a.mode = auto ? "SCHEDULE" : "UPLOAD_ONLY";
    a.allow_final = auto;
    a.enabled = true;
    const pillar = await ask("  What is this account's content about, in one line? (Enter = let the strategist propose)", "");
    if (pillar) a.style = { group: id, pillar, voice: await ask("  Its voice, in a few words", "friendly, short spoken lines"), formats: [...p.content.preferred_styles], differentiator: "" };
    p.accounts.push(a);
    newAccounts.push(a);
    addAccount = await yes("  Add another account for this project?", false);
  }
  mkdirSync(join(ROOT, "apps", id), { recursive: true });
  writeFileSync(join(ROOT, "apps", id, "profile.json"), JSON.stringify(p, null, 2) + "\n");
  newProjects.push(id);
  const wsDir = rootPath(p.video_workspace ?? `${cfg.paths.workspaces}/${id}`);
  mkdirSync(join(wsDir, "assets"), { recursive: true });
  if (!existsSync(join(wsDir, "README.md"))) writeFileSync(join(wsDir, "README.md"), `# ${name}: video workspace\n\nPut real material here for the creator to build videos from: \`assets/\` holds logos, screenshots,\nproduct shots, screen recordings and photos. Add brand rules below (colours, fonts, words to avoid);\nthe creator reads this file before every video.\n\n## Brand rules\n\n- \n`);
  console.log(`  ${dim(`wrote apps/${id}/profile.json and ${wsDir}`)}\n`);
  addProject = await yes("Add another project?", false);
}

// ---------------------------------------------------------------- Telegram
console.log(bold("\n2. Approvals on your phone (Telegram)") + dim("  optional: without it you approve in cc's chat"));
if (await yes("Set up a Telegram bot for approvals?", !process.env.TELEGRAM_BOT_TOKEN)) {
  console.log("  In Telegram, open @BotFather, send /newbot and follow the steps. It gives you a token.");
  for (;;) {
    const token = await ask("  Bot token", process.env.TELEGRAM_BOT_TOKEN ?? "");
    const me = await fetch(`https://api.telegram.org/bot${token}/getMe`).then((r) => r.json()).catch(() => null);
    if (!me?.ok) { if (await yes("  Telegram didn't accept that token. Try again?", true)) continue; break; }
    env.TELEGRAM_BOT_TOKEN = token;
    console.log(`  Now send any message to @${me.result.username} in Telegram. Waiting up to 2 minutes...`);
    let chat = null;
    for (let i = 0; i < 24 && !chat; i++) {
      const u = await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=5`).then((r) => r.json()).catch(() => null);
      chat = u?.result?.map((x) => x.message?.chat?.id).filter(Boolean).at(-1) ?? null;
    }
    if (chat) { env.TELEGRAM_CHAT_ID = String(chat); console.log(`  Got it: chat ${chat}.`); }
    else env.TELEGRAM_CHAT_ID = await ask("  No message seen. Your chat id (or Enter to skip)", process.env.TELEGRAM_CHAT_ID ?? "");
    break;
  }
}

// ---------------------------------------------------------------- voice and music
console.log(bold("\n3. Voiceover and music (ElevenLabs)") + dim("  optional: without it videos use on-screen text and your own music"));
const el = await ask("ElevenLabs API key (Enter to skip)", process.env.ELEVENLABS_API_KEY ? "keep current" : "");
if (el && el !== "keep current") env.ELEVENLABS_API_KEY = el;

// ---------------------------------------------------------------- tools and creator
console.log(bold("\n4. Tools"));
const pyGuess = cfg.paths.python !== DEFAULTS.paths.python ? cfg.paths.python : (spawnSync("python", ["--version"]).status === 0 ? "python" : "py");
cfg.paths.python = await ask("Python 3.10+ (a command or a path)", pyGuess);
const pyCheck = spawnSync(tool(cfg.paths.python), ["-c", "import cv2, numpy, PIL"]);
if (pyCheck.status !== 0 && await yes("  Python is missing opencv-python, numpy or pillow. Install them now?", true)) {
  run(tool(cfg.paths.python), ["-m", "pip", "install", "opencv-python", "numpy", "pillow"]);
}
cfg.creator.paidVideoApis = await yes("May the creator use paid video-generation APIs (Runway, Kling, Veo, ...)? No = such posts wait for you", cfg.creator.paidVideoApis);
cfg.creator.localVideoModels = await ask("Local video models on this machine the creator may run, and how (optional)", cfg.creator.localVideoModels);

// ---------------------------------------------------------------- cc
console.log(bold("\n5. cc, your desktop companion") + dim("  (Windows)"));
cfg.assistant.voice = await choose("cc's voice", [["cc_bright", "cute and bright"], ["cc_chill", "cute and chill"], ["cc_mellow", "mellow"], ["af_heart", "warm (female)"]],
  ["cc_bright", "cc_chill", "cc_mellow", "af_heart"].indexOf(cfg.assistant.voice) >= 0 ? ["cc_bright", "cc_chill", "cc_mellow", "af_heart"].indexOf(cfg.assistant.voice) : 0);
cfg.assistant.autoHideMinutes = Number(await ask("Minutes without you before cc hides at the screen's edge (0 = never)", cfg.assistant.autoHideMinutes)) || 0;

// ---------------------------------------------------------------- write
writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
writeEnv(env);
const ctxFile = rootPath(cfg.paths.context);
if (!existsSync(ctxFile)) writeFileSync(ctxFile, "# Account context\n\nFacts per account that the strategist and the creator read every time. Keep it short and current.\n");
let ctx = readFileSync(ctxFile, "utf8");
for (const a of newAccounts.filter((x) => !ctx.includes(`## ${x.id}`))) {
  ctx += `\n## ${a.id} (${a.name})\n\n**Audience:** \n**Search terms people use:** \n**Captions:** \n\n**Now** (update after each insights run):\n- Followers: -, median views: -, median 3-second retention: -\n- What works: (nothing measured yet)\n- What fails: (nothing measured yet)\n`;
}
writeFileSync(ctxFile, ctx);
console.log(`\n${bold("Saved.")} studio.config.json, .env, ${cfg.paths.context}${newProjects.length ? ` and apps/${newProjects.join(", apps/")}` : ""}.`);
console.log(dim(`Fill in ${cfg.paths.context} (audience, search terms) and each workspace's assets: the better they are, the better the videos.`));

// ---------------------------------------------------------------- next steps
const steps = [];
for (const a of newAccounts) steps.push([`Log in to ${a.platform} as @${a.handle} now (a Chrome window opens; log in, then close it)?`, () => run(process.execPath, ["src/setup.js", a.id])]);
if (process.platform === "win32") {
  steps.push(["Build cc's avatar now?", () => run(process.execPath, ["scripts/avatar.mjs"])]);
  steps.push(["Install cc's offline voice now? (a Python venv and a ~340 MB model download)", () => run(process.execPath, ["scripts/voice-install.mjs"])]);
}
steps.push(["Register the scheduled tasks now (tick, pulse, weekly insights, bot, desk, cc)?", () => run(process.execPath, ["scripts/tasks.mjs", "install"])]);
// The child (Chrome login, pip, schtasks) owns the console while it runs; piped input may be closed by now.
for (const [q, act] of steps) { if (await yes(`\n${q}`, true)) { if (!closed) rl.pause(); act(); if (!closed) rl.resume(); } }
if (!closed) rl.close();
console.log(`\n${bold("Health check:")}`);
run(process.execPath, ["scripts/doctor.mjs"]);
console.log(`\nWhen it says Ready: the strategist plans next week on Saturday evening (or now: ${bold("npm run strategist")}),
the creator makes one video at a time, and each one comes to you in Telegram or cc for a yes or no.`);
