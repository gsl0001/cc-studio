// The setup wizard in the terminal: the same questions as the chat page (npm run setup), for
// when you'd rather type, or for piped answers.
//
//   npm run setup:cli
//
// Writes studio.config.json (settings), .env (secrets), apps/<project>/profile.json (one per
// brand), content/CONTEXT.md (account facts) and each project's video workspace folder, then
// offers the next steps: logging in to each account, cc's avatar and voice, the scheduled
// tasks, and a health check. Safe to re-run: current values are the defaults, and existing
// projects are kept (add more, or edit their profile.json by hand).
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ROOT, config as current } from "../src/config.js";
import { COLORS, PLATFORMS, VOICES, existingProjects, makeProfile, pythonGuess, pythonReady, saveSetup, slug, stepCommand, telegramChat, telegramMe } from "./setup-core.mjs";

const rl = createInterface({ input: stdin, output: stdout });
rl.on("SIGINT", () => { console.log("\nSetup stopped; nothing was written."); process.exit(130); });
const bold = (s) => `\x1b[1m${s}\x1b[0m`, dim = (s) => `\x1b[2m${s}\x1b[0m`;

// Answers come from a queue of lines, so piped answers work too (npm run setup:cli < answers.txt):
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
async function lines(q) {   // one item per line, a blank line ends
  console.log(`${q} ${dim("(one per line, an empty line to finish)")}`);
  const out = [];
  for (;;) { const a = (await question("  - ")).trim(); if (!a) break; out.push(a); }
  return out;
}
async function choose(q, options, def = 0) {
  options.forEach((o, i) => console.log(`  ${i + 1}. ${o[1]}`));
  const a = await ask(q, def + 1);
  const i = Number(a) - 1;
  return options[i >= 0 && i < options.length ? i : def][0];
}
const run = (cmd, args) => spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT });

// ---------------------------------------------------------------------------------------
console.log(`\n${bold("cc-studio setup")}
Plans your week of short videos, makes each one with Claude, sends it to you for a yes or no,
and schedules it on TikTok and Instagram. Answer what you can; Enter keeps the value shown.
Everything is written to plain files you can edit later (see docs/configuration.md).\n`);

const cfg = structuredClone(current);
const env = {}, profiles = [];

// ---------------------------------------------------------------- cc
console.log(bold("1. Your assistant") + dim("  (cc lives on the Windows desktop and answers in Telegram)"));
cfg.assistant.name = (await ask("What should it be called?", cfg.assistant.name)).slice(0, 24);
cfg.assistant.color = await choose("Its colour", COLORS.map((c) => [c, c]), Math.max(0, COLORS.indexOf(cfg.assistant.color)));
cfg.assistant.voice = await choose("Its voice", VOICES, Math.max(0, VOICES.findIndex(([k]) => k === cfg.assistant.voice)));
cfg.assistant.autoHideMinutes = Number(await ask("Minutes without you before it hides at the screen's edge (0 = never)", cfg.assistant.autoHideMinutes)) || 0;

// ---------------------------------------------------------------- projects
const existing = existingProjects();
console.log(bold("\n2. Your projects") + dim("  (a brand, product or channel; each has its own accounts)"));
if (existing.length) console.log(`You have: ${existing.join(", ")}.`);
let addProject = existing.length ? await yes("Add another project?", false) : true;
while (addProject) {
  const a = { accounts: [] };
  a.name = await ask("Project name (e.g. Acme Notes)");
  a.id = slug(await ask("Short id, used in file names", slug(a.name)));
  a.type = await choose("Is it", [["app", "a product or app you market (claims and a call to action)"], ["channel", "a channel you grow with content (no product)"]]);
  a.one_liner = await ask("In one sentence, what is it?");
  a.audience = await ask("Who is it for? (comma-separated)");
  a.site_url = await ask("Website (optional)", "");
  if (a.type === "app") {
    a.approved_claims = await lines("What may videos claim? Only true, provable statements, e.g. 'Works offline.'");
    a.cta = await ask("Call to action at the end of each video", "Link in bio");
  }
  a.forbidden_claims = await lines("What must videos never claim? e.g. 'the fastest', 'uses AI'");
  a.language_note = await ask("Language", "English only.");
  a.duration = await ask("Video length range in seconds", "8-20");
  a.workspace = await ask("Folder with this project's assets (logos, screenshots, clips)", `${cfg.paths.workspaces}/${a.id}`);
  a.pronounce = await ask("A word the voice should say differently? Write it as Word=Sounds-like (optional)", "");

  console.log(bold(`\n  Accounts for ${a.name}`));
  let addAccount = true;
  while (addAccount) {
    const x = {};
    x.platform = await choose("  Platform", PLATFORMS);
    x.handle = (await ask("  Handle, without @")).replace(/^@/, "");
    x.name = await ask("  What you call this account", a.accounts.length ? `${a.name} ${x.handle}` : a.name);
    x.slots = await ask("  Posting times, 24 h (comma-separated)", "18:00");
    x.auto = await yes("  Post automatically after you approve each video? (No = cc-studio uploads, you press Post)", true);
    x.pillar = await ask("  What is this account's content about, in one line? (Enter = let the strategist propose)", "");
    if (x.pillar) x.voice = await ask("  Its voice, in a few words", "friendly, short spoken lines");
    a.accounts.push(x);
    addAccount = await yes("  Add another account for this project?", false);
  }
  profiles.push(makeProfile(a));
  addProject = await yes("\nAdd another project?", false);
}

// ---------------------------------------------------------------- Telegram
console.log(bold("\n3. Approvals on your phone (Telegram)") + dim("  optional: without it you approve in cc's chat"));
if (await yes("Set up a Telegram bot for approvals?", !process.env.TELEGRAM_BOT_TOKEN)) {
  console.log("  In Telegram, open @BotFather, send /newbot and follow the steps. It gives you a token.");
  for (;;) {
    const token = await ask("  Bot token", process.env.TELEGRAM_BOT_TOKEN ?? "");
    const username = await telegramMe(token);
    if (!username) { if (await yes("  Telegram didn't accept that token. Try again?", true)) continue; break; }
    env.TELEGRAM_BOT_TOKEN = token;
    console.log(`  Now send any message to @${username} in Telegram. Waiting up to 2 minutes...`);
    let chat = null;
    for (let i = 0; i < 24 && !chat; i++) chat = await telegramChat(token);
    if (chat && await yes(`  Got a message from ${chat.name}. Is that you?`, true)) { env.TELEGRAM_CHAT_ID = String(chat.id); console.log(`  Approvals go to chat ${chat.id}.`); }
    else env.TELEGRAM_CHAT_ID = await ask(`  ${chat ? "OK." : "No message seen."} Your chat id (or Enter to skip)`, process.env.TELEGRAM_CHAT_ID ?? "");
    break;
  }
}

// ---------------------------------------------------------------- voice and music
console.log(bold("\n4. Voiceover and music (ElevenLabs)") + dim("  optional: without it videos use on-screen text and your own music"));
const el = await ask("ElevenLabs API key (Enter to skip)", process.env.ELEVENLABS_API_KEY ? "keep current" : "");
if (el && el !== "keep current") env.ELEVENLABS_API_KEY = el;
console.log(dim("  Free stock footage the creator checks before generating a scene: free keys at pexels.com/api and pixabay.com/api/docs"));
for (const [k, name] of [["PEXELS_API_KEY", "Pexels"], ["PIXABAY_API_KEY", "Pixabay"]]) {
  const v = await ask(`${name} API key (Enter to skip)`, process.env[k] ? "keep current" : "");
  if (v && v !== "keep current") env[k] = v;
}

// ---------------------------------------------------------------- tools and creator
console.log(bold("\n5. Tools"));
cfg.paths.python = await ask("Python 3.10+ (a command or a path)", pythonGuess(cfg));
if (!pythonReady(cfg.paths.python) && await yes("  Python is missing opencv-python, numpy or pillow. Install them now?", true)) run(...stepCommand("pydeps", cfg.paths.python, cfg));
cfg.creator.permissionMode = await choose("How the unattended creator gets permission", [["auto", "auto mode: Claude Code checks each step and blocks risky ones (recommended)"], ["bypass", "no checks: fastest, but nothing stops a bad instruction"]], cfg.creator.permissionMode === "bypass" ? 1 : 0);
cfg.creator.paidVideoApis = await yes("May the creator use paid video-generation APIs (Runway, Kling, Veo, ...)? No = such posts wait for you", cfg.creator.paidVideoApis);
cfg.creator.localVideoModels = await ask("Local video models on this machine the creator may run, and how (optional)", cfg.creator.localVideoModels);

// ---------------------------------------------------------------- write
const written = saveSetup({ cfg, env, profiles });
for (const w of written) console.log(dim(`wrote apps/${w.id}/profile.json and ${w.workspace}`));
console.log(`\n${bold("Saved.")} studio.config.json, .env and ${cfg.paths.context}.`);
console.log(dim(`Fill in ${cfg.paths.context} (audience, search terms) and each workspace's assets: the better they are, the better the videos.`));

// ---------------------------------------------------------------- next steps
const steps = [];
for (const a of written.flatMap((w) => w.accounts)) steps.push([`Log in to ${a.platform} as @${a.handle} now (a Chrome window opens; log in, then close it)?`, "login", a.id]);
if (process.platform === "win32") {
  steps.push(["Build cc's avatar now?", "avatar"]);
  steps.push(["Install cc's offline voice now? (a Python venv and a ~340 MB model download)", "voice"]);
}
steps.push(["Register the scheduled tasks now (tick, pulse, weekly insights, bot, desk, cc)?", "tasks"]);
// The child (Chrome login, pip, schtasks) owns the console while it runs; piped input may be closed by now.
for (const [q, step, arg] of steps) { if (await yes(`\n${q}`, true)) { if (!closed) rl.pause(); run(...stepCommand(step, arg, cfg)); if (!closed) rl.resume(); } }
if (!closed) rl.close();
console.log(`\n${bold("Health check:")}`);
run(...stepCommand("doctor", null, cfg));
console.log(`\nWhen it says Ready: the strategist plans next week on Saturday evening (or now: ${bold("npm run strategist")}),
the creator makes one video at a time, and each one comes to you in Telegram or cc for a yes or no.`);
