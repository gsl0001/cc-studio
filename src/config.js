// cc-studio's settings, in one place.
//
//   studio.config.json   your settings (written by `npm run setup`; every field is
//                        documented in studio.config.example.json). Missing fields fall
//                        back to the defaults below.
//   .env                 secrets only (Telegram, ElevenLabs, Instagram API tokens). Loaded
//                        into process.env here; a variable already set in the environment wins.
//   apps/<id>/profile.json   one per brand or project: claims, accounts, slots, style.
//
// Paths in the config are relative to the repo root unless absolute.
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG_FILE = join(ROOT, "studio.config.json");

export const DEFAULTS = {
  assistant: {
    name: "cc",                     // what the desktop assistant calls itself
    voice: "cc_bright",             // a scripts/voice.py preset or any Kokoro voice
    color: "charcoal",              // cc's body: charcoal, snow, sky, mint, lavender, pink, peach or yellow
    autoHideMinutes: 3,             // cc hides on the screen's side after this long without you; 0 = never
  },
  models: {
    creator: "claude-opus-5-5",     // makes the videos (agents/creator.md)
    strategist: "claude-opus-5-5",  // plans the week
    desk: "claude-haiku-4-5-20251001",   // cc's chat
    plan: "sonnet",                 // the one-post planner (npm run plan)
  },
  paths: {
    finals: "finals",               // finished videos, per project: finals/<project>/
    workspaces: "workspaces",       // where the creator builds each video: workspaces/<project>/<slug>/
    guidelines: "content/GUIDELINES.md",   // how to make content (every account)
    context: "content/CONTEXT.md",  // facts per account (written by setup, yours to grow)
    python: "python",               // a Python 3.10+ with opencv-python, numpy and pillow (similarity check, avatar)
    handPost: null,                 // optional: a folder you post from by hand; pipeline videos are kept out of it
  },
  creator: {
    maxRunMinutes: 90,
    similarityLimit: 0.35,          // a render reusing this share of a recent video's shots goes back for a remake
    composition: "HyperFrames (npx hyperframes) or Remotion; plain ffmpeg for simple cuts",
    localVideoModels: "",           // optional: how to run local video models on this machine, told to the creator
    paidVideoApis: false,           // true lets the creator use paid video-generation APIs; false marks such posts blocked
  },
  telegram: { enabled: true },      // needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env
};

// .env -> process.env (KEY=value lines; # comments; existing variables win).
const ENV_FILE = join(ROOT, ".env");
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" ? merge(base[k], v) : v;
  }
  return out;
}

export function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return structuredClone(DEFAULTS);
  return merge(DEFAULTS, JSON.parse(readFileSync(CONFIG_FILE, "utf8").replace(/^﻿/, "")));
}

export const config = loadConfig();

// A config path, absolute: relative ones are under the repo root.
export const rootPath = (p) => (p == null ? null : isAbsolute(p) ? p : join(ROOT, p));
// A program: a bare name ("python") is looked up on PATH, anything with a slash is a path.
export const tool = (p) => (/[\\/]/.test(p) ? rootPath(p) : p);
// Where the creator builds a project's videos: the profile's video_workspace, else workspaces/<id>.
export const projectWorkspace = (profile) => rootPath(profile.video_workspace ?? `${config.paths.workspaces}/${profile.id}`);

// The model for a job: the environment (CLAUDE_MODEL, STRATEGIST_MODEL, DESK_MODEL) wins, then the config.
export const model = (job) => process.env[{ creator: "CLAUDE_MODEL", strategist: "STRATEGIST_MODEL", desk: "DESK_MODEL", plan: "PLAN_MODEL" }[job]] || config.models[job];
