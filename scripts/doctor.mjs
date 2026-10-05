// Is cc-studio ready? Checks every prerequisite and setting, and says how to fix what isn't.
//
//   npm run doctor
//
// Exit code 1 when something required is missing; optional pieces only warn.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, ROOT, config, rootPath, tool } from "../src/config.js";
import { loadRegistry } from "../src/registry.js";

const rows = [];
const ok = (what, detail = "") => rows.push(["ok", what, detail]);
const warn = (what, fix) => rows.push(["warn", what, fix]);
const bad = (what, fix) => rows.push(["FAIL", what, fix]);
const run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 60_000 });
const first = (r) => `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split(/\r?\n/)[0] ?? "";

// Programs
const [maj, min] = process.versions.node.split(".").map(Number);
(maj > 22 || (maj === 22 && min >= 5)) ? ok("Node.js", process.versions.node) : bad(`Node.js ${process.versions.node}`, "install Node.js 22.5 or newer (built-in SQLite)");
existsSync(join(ROOT, "node_modules", "playwright")) ? ok("npm packages") : bad("npm packages", "run: npm install");
const claude = spawnSync("claude --version", { encoding: "utf8", shell: true, windowsHide: true, timeout: 60_000 });   // a .cmd shim on Windows: needs the shell
claude.status === 0 ? ok("Claude Code CLI", first(claude)) : bad("Claude Code CLI", "install Claude Code and log in (claude), the strategist, creator and chat run on it");
for (const p of ["ffmpeg", "ffprobe"]) { const r = run(p, ["-version"]); r.status === 0 ? ok(p) : bad(p, "install FFmpeg and put it on PATH"); }
const py = tool(config.paths.python);
const pyr = run(py, ["-c", "import cv2, numpy, PIL; print(cv2.__version__)"]);
pyr.status === 0 ? ok(`Python (${py})`, `opencv ${first(pyr)}`) : bad(`Python with opencv-python, numpy, pillow (${py})`, `${py} -m pip install opencv-python numpy pillow  (or set paths.python in studio.config.json)`);
if (process.platform === "win32") {
  const chrome = ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"].map((v) => process.env[v] && join(process.env[v], "Google", "Chrome", "Application", "chrome.exe")).find((p) => p && existsSync(p));
  chrome ? ok("Google Chrome") : bad("Google Chrome", "install Chrome: the publisher drives your real Chrome (a real browser fingerprint)");
}

// Settings
existsSync(CONFIG_FILE) ? ok("studio.config.json") : warn("studio.config.json", "run: npm run setup (defaults are used until then)");
existsSync(rootPath(config.paths.context)) ? ok("account context", config.paths.context) : warn(`${config.paths.context} missing`, "run: npm run setup (or copy content/CONTEXT.example.md)");
const reg = loadRegistry();
const mine = reg.projects.filter((p) => p.id !== "example");
mine.length ? ok("projects", mine.map((p) => p.id).join(", ")) : warn("no projects of your own", "run: npm run setup to add your brand");
for (const e of reg.errors) bad("registry", e);
for (const w of reg.warnings) warn("registry", w);
const live = reg.accounts.filter((a) => a.enabled);
live.length ? ok("enabled accounts", live.map((a) => a.id).join(", ")) : warn("no enabled accounts", "enable an account in apps/<project>/profile.json (setup does it)");

// Services
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
  const me = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json()).catch(() => null);
  me?.ok ? ok("Telegram bot", `@${me.result.username}`) : bad("Telegram bot", "TELEGRAM_BOT_TOKEN in .env was refused by Telegram; make a new token with @BotFather");
} else warn("Telegram", "not configured: approvals only in cc's chat. run: npm run setup to add a bot");
[process.env.PEXELS_API_KEY && "Pexels", process.env.PIXABAY_API_KEY && "Pixabay"].filter(Boolean).length
  ? ok("Stock footage", [process.env.PEXELS_API_KEY && "Pexels", process.env.PIXABAY_API_KEY && "Pixabay"].filter(Boolean).join(", "))
  : warn("Stock footage", "no PEXELS_API_KEY or PIXABAY_API_KEY: the creator only searches your own clip library before generating scenes (free keys: pexels.com/api, pixabay.com/api/docs)");
process.env.ELEVENLABS_API_KEY ? ok("ElevenLabs key") : warn("ElevenLabs", "no ELEVENLABS_API_KEY: videos get no voiceover or generated music");

// cc (Windows)
if (process.platform === "win32") {
  const avatar = join(ROOT, "cc-avatar");
  existsSync(avatar) && readdirSync(avatar).length > 20 ? ok("cc avatar") : warn("cc avatar", "run: npm run avatar");
  existsSync(join(ROOT, "voice", "kokoro-v1.0.onnx")) ? ok("cc offline voice") : warn("cc offline voice", "run: npm run voice:install (cc uses the Windows voice until then)");
  const tasks = run("schtasks", ["/query", "/fo", "csv", "/nh"]);
  const have = ["tick", "pulse", "insights", "bot", "desk", "cc"].filter((j) => tasks.stdout?.includes(`"\\cc-studio ${j}"`));
  have.length === 6 ? ok("scheduled tasks") : warn(`scheduled tasks (${have.length}/6)`, "run: npm run tasks:install");
  const desk = await fetch("http://127.0.0.1:4820/api/widget", { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false);
  desk ? ok("desk server") : warn("desk server not running", "it starts with the tasks (npm run tasks:install) or: npm run desk");
}

const icon = { ok: "  ok  ", warn: " warn ", FAIL: " FAIL " };
for (const [lvl, what, detail] of rows) console.log(`${icon[lvl]} ${what}${detail ? `  ${lvl === "ok" ? "" : "-> "}${detail}` : ""}`);
const fails = rows.filter((r) => r[0] === "FAIL").length, warns = rows.filter((r) => r[0] === "warn").length;
console.log(`\n${fails ? `${fails} problem(s) to fix` : "Ready"}${warns ? `, ${warns} optional item(s)` : ""}.`);
process.exit(fails ? 1 : 0);
