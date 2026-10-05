// Setup as a chat with cc: a page on this machine where cc asks the questions, starting with
// its own name, colour and voice, then your projects, accounts, Telegram and keys.
//
//   npm run setup            opens http://localhost:4829 in your browser
//   npm run setup:cli        the same questions in the terminal (scripts/setup.mjs)
//
// Writes the same files as the terminal wizard (scripts/setup-core.mjs), then runs the next
// steps (logins, cc's avatar and voice, the scheduled tasks, the health check) from the page.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { ROOT, loadConfig } from "../src/config.js";
import { COLORS, PLATFORMS, VOICES, existingProjects, makeProfile, pythonGuess, pythonReady, saveSetup, stepCommand, telegramChat, telegramMe } from "./setup-core.mjs";

const PORT = Number(process.env.SETUP_PORT) || 4829;
const STEPS = ["login", "avatar", "voice", "tasks", "doctor", "pydeps"];

const readBody = (req) => new Promise((ok, fail) => {
  let s = "";
  req.on("data", (c) => { s += c; if (s.length > 1e6) { fail(new Error("too big")); req.destroy(); } });
  req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { fail(e); } });
});
const voiceUp = () => fetch("http://127.0.0.1:4821/health", { signal: AbortSignal.timeout(800) }).then((r) => r.ok).catch(() => false);
const accountIds = () => existingProjects().flatMap((d) => JSON.parse(readFileSync(join(ROOT, "apps", d, "profile.json"), "utf8")).accounts?.map((a) => a.id) ?? []);

async function state() {
  const cfg = loadConfig();
  return {
    assistant: cfg.assistant, colors: COLORS, voices: VOICES, platforms: PLATFORMS, workspaces: cfg.paths.workspaces,
    projects: existingProjects(), windows: process.platform === "win32",
    avatar: existsSync(join(ROOT, "cc-avatar", "body_charcoal.png")), voiceServer: await voiceUp(),
    claude: spawnSync("claude --version", { shell: true }).status === 0,
    python: pythonGuess(cfg), paidVideoApis: cfg.creator.paidVideoApis, localVideoModels: cfg.creator.localVideoModels,
    telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN), eleven: Boolean(process.env.ELEVENLABS_API_KEY),   // only whether they're set, never the values
  };
}

function save(b) {
  const cfg = loadConfig();
  const a = b.assistant ?? {};
  cfg.assistant.name = String(a.name || cfg.assistant.name).slice(0, 24);
  if (COLORS.includes(a.color)) cfg.assistant.color = a.color;
  if (a.voice) cfg.assistant.voice = String(a.voice);
  if (a.autoHideMinutes != null) cfg.assistant.autoHideMinutes = Math.max(0, Number(a.autoHideMinutes) || 0);
  if (b.python) cfg.paths.python = String(b.python);
  if (b.paidVideoApis != null) cfg.creator.paidVideoApis = Boolean(b.paidVideoApis);
  if (b.localVideoModels != null) cfg.creator.localVideoModels = String(b.localVideoModels);
  const env = {};
  if (b.telegramToken) env.TELEGRAM_BOT_TOKEN = String(b.telegramToken).trim();
  if (b.telegramChat) env.TELEGRAM_CHAT_ID = String(b.telegramChat).trim();
  if (b.eleven) env.ELEVENLABS_API_KEY = String(b.eleven).trim();
  for (const [k, v] of Object.entries(env)) { if (/[\r\n]/.test(v)) throw new Error(`bad ${k}`); process.env[k] = v; }
  const written = saveSetup({ cfg, env, profiles: (b.projects ?? []).filter((p) => p?.name).map(makeProfile) });
  return { projects: written.map((w) => ({ id: w.id, name: w.name, workspace: w.workspace, accounts: w.accounts.map((x) => ({ id: x.id, platform: x.platform, handle: x.handle })) })) };
}

// A step's output, streamed to the page as it comes (colour codes stripped), then its exit code.
function runStep(res, step, arg) {
  const [cmd, args] = stepCommand(step, arg, loadConfig());
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, FORCE_COLOR: "0" } });
  const out = (c) => res.write(String(c).replace(/\x1b\[[0-9;]*m/g, ""));
  child.stdout.on("data", out); child.stderr.on("data", out);
  child.on("error", (e) => { res.end(`\n${e.message}\n[exit 1]`); });
  child.on("close", (code) => res.end(`\n[exit ${code}]`));
}

const server = createServer(async (req, res) => {
  const send = (code, body, type = "application/json") => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(type === "application/json" ? JSON.stringify(body) : body);
  };
  try {
    // Only this machine's own pages: a Host check stops DNS rebinding, an Origin check stops other sites posting here.
    const self = new RegExp(`^(localhost|127\\.0\\.0\\.1):${server.address().port}$`);
    if (!self.test(req.headers.host ?? "")) return send(403, { error: "bad host" });
    if (req.method === "POST" && !self.test(String(req.headers.origin).replace(/^http:\/\//, ""))) return send(403, { error: "bad origin" });
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET") {
      if (url.pathname === "/") return send(200, readFileSync(join(ROOT, "dashboard", "setup.html"), "utf8"), "text/html; charset=utf-8");
      const m = /^\/avatar\/([a-z0-9_]+\.png)$/.exec(url.pathname);
      if (m && existsSync(join(ROOT, "cc-avatar", m[1]))) return send(200, readFileSync(join(ROOT, "cc-avatar", m[1])), "image/png");
      if (url.pathname === "/api/state") return send(200, await state());
      return send(404, { error: "not found" });
    }
    if (req.method !== "POST") return send(405, { error: "method" });
    const b = await readBody(req);
    switch (url.pathname) {
      case "/api/telegram/check": return send(200, { username: await telegramMe(b.token || process.env.TELEGRAM_BOT_TOKEN) });
      case "/api/telegram/chat": return send(200, { chat: await telegramChat(b.token || process.env.TELEGRAM_BOT_TOKEN) });
      case "/api/python": return send(200, { ready: pythonReady(String(b.python || "python")) });
      case "/api/voice": {   // a sample of a voice, from cc's voice server when it's running
        const r = await fetch("http://127.0.0.1:4821/speak", { method: "POST", body: JSON.stringify({ text: String(b.text ?? "").slice(0, 200), voice: String(b.voice ?? "") }) })
          .then((x) => x.json()).catch(() => null);
        return r?.path && existsSync(r.path) ? send(200, readFileSync(r.path), "audio/wav") : send(503, { error: "voice server not running" });
      }
      case "/api/save": return send(200, save(b));
      case "/api/run":
        if (!STEPS.includes(b.step)) return send(400, { error: "unknown step" });
        if (b.step === "login" && !accountIds().includes(b.account)) return send(400, { error: "unknown account" });
        return runStep(res, b.step, b.step === "pydeps" ? b.python : b.account);
      case "/api/quit": send(200, { ok: true }); console.log("Setup closed."); return setTimeout(() => process.exit(0), 100);
    }
    send(404, { error: "not found" });
  } catch (e) {
    send(500, { error: e.message });
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") { console.log(`Port ${PORT} is busy; using another.`); server.listen(0, "127.0.0.1"); }
  else throw e;
});
server.listen(PORT, "127.0.0.1", () => {
  const url = `http://localhost:${server.address().port}/`;
  console.log(`cc-studio setup is open at ${url}\nKeep this window open until you finish (Ctrl+C stops it).`);
  if (process.argv.includes("--no-open")) return;
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : [process.platform === "darwin" ? "open" : "xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
});
