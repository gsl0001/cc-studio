// The asset catalogue: every real screen, photo and take in each project's workspace, described
// in a line, so the creator finds them by meaning ("clips.mjs find" searches them first) and the
// planner plans from what actually exists. Files stay where they are; the catalogue lives in the
// clip library's index (kind "asset").
//
//   node scripts/assets.mjs scan [--project <id>] [--no-describe]   catalogue new and changed files
//   node scripts/assets.mjs sheets [--project <id>]                 contact sheets: library/sheets/
//   node scripts/assets.mjs segments [--project <id>]               longer videos, moment by moment
//   node scripts/assets.mjs list [--project <id>]
//   node scripts/assets.mjs stock                                  fresh (unused in 30 days) material per project
//
// Skipped: finished videos (anything posted, by checksum, and 1080x1920 renders with sound
// outside asset folders), extracted frames, build output, tiny images. Same file in two places:
// catalogued once. Descriptions come from Claude looking at a contact sheet of 20 frames at a time.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { DIR, load, save } from "./clips.mjs";
import { config, projectWorkspace, tool } from "../src/config.js";
import { loadRegistry } from "../src/registry.js";
import { db } from "../src/db.js";

const ROOT = resolve(dirname(import.meta.filename), "..");
const PY = tool(config.paths.python);   // with Pillow (npm run doctor checks it)
const MODEL = process.env.ASSET_MODEL || "claude-haiku-4-5-20251001";
const THUMBS = join(DIR, "thumbs"), SHEETS = join(ROOT, "library", "sheets");
const MEDIA = /\.(png|jpe?g|webp|mp4|mov|webm|m4v)$/i, VIDEO = /\.(mp4|mov|webm|m4v)$/i;
const SKIP_DIRS = /^(node_modules|\.git|renders?|out|output|dist|build|logs?|frames?|tmp|temp|thumbs|\.cache|__pycache__|\.next|finals?|exports?|previews?|qa\d*|probe\d*|peek|checks?|covers?|tiles|old|old-cut|.*snapshots.*|fonts?)$/i;
// Raw material lives in folders like these; anything outside them is build or review output.
const RAW_DIR = /^(assets|clips|ui|photos?|images|raw|videos?|footage|takes|capture|screens?|screenshots|broll|b-roll|stock|sources?|wan|recordings?)$/i;
const SKIP_FILES = /^(frame|f)[-_ ]?\d+|^(thumb|contact|sheet|preview|cover|final|export|qa|check|rendered|render)([-_. \d]|$)|[-_](final|render|preview|cover|contact|fit)[-_.]|-at-[\d.]+s\./i;
const ASSET_DIRS = /[\\/](assets|capture|clips|takes|raw|footage|screens?|ui|images|photos)[\\/]/i;

// Where each project's material lives: its workspace.
export function workspaces() {
  const out = {};
  for (const p of loadRegistry().projects) {
    const w = projectWorkspace(p);
    if (w && existsSync(w)) out[p.id] = { root: w, name: p.name ?? p.id, about: p.positioning?.one_liner ?? "" };
  }
  return out;
}

function walk(dir, files = []) {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) { if (!SKIP_DIRS.test(d.name) && !d.name.startsWith(".")) walk(p, files); }
    else if (MEDIA.test(d.name) && !SKIP_FILES.test(d.name) && p.split(/[\\/]/).slice(0, -1).some((seg) => RAW_DIR.test(seg))) files.push(p);
  }
  return files;
}
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
function probe(f) {
  try {
    const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", f]).toString());
    const v = j.streams?.find((s) => s.codec_type === "video") ?? {};
    return { width: v.width ?? null, height: v.height ?? null, duration: VIDEO.test(f) ? Math.round(Number(j.format?.duration) * 10) / 10 || null : null,
      audio: j.streams?.some((s) => s.codec_type === "audio") ?? false };
  } catch { return {}; }
}
function frame(f, id, duration) {
  mkdirSync(THUMBS, { recursive: true });
  const out = join(THUMBS, `${id}.jpg`);
  if (!existsSync(out)) {
    try { execFileSync("ffmpeg", ["-v", "error", "-y", ...(duration ? ["-ss", String(duration / 2)] : []), "-i", f, "-frames:v", "1", "-vf", "scale=480:-2", out]); }
    catch { return null; }
  }
  return out;
}
const pathWords = (rel) => rel.replace(/\.[a-z0-9]+$/i, "").replace(/[\\/_.-]+/g, " ").replace(/\d+/g, " ").replace(/\s+/g, " ").trim();

// New and changed files into the catalogue; files gone from disk drop out.
export function scan(only = null) {
  const all = load(), posted = new Set(db.prepare("SELECT sha FROM content").all().map((r) => r.sha));
  const byFile = new Map(all.filter((e) => e.kind === "asset").map((e) => [e.file, e]));
  const bySha = new Map(all.filter((e) => e.kind === "asset").map((e) => [e.sha, e]));
  const counts = {};
  for (const [project, ws] of Object.entries(workspaces())) {
    if (only && project !== only) continue;
    const c = (counts[project] = { files: 0, added: 0, renders: 0, copies: 0 });
    for (const f of walk(ws.root)) {
      c.files++;
      const st = statSync(f), known = byFile.get(f);
      if (known && known.size === st.size && known.mtime === st.mtimeMs) continue;
      if (st.size < 8_000 || st.size > 400 * 1024 * 1024) continue;
      const h = sha(f);
      if (posted.has(h)) { c.renders++; continue; }
      const dup = bySha.get(h);
      if (dup && dup.file !== f) { if (!dup.copies?.includes(f)) (dup.copies ??= []).push(f); c.copies++; continue; }
      const m = probe(f);
      if (!m.width || Math.min(m.width, m.height) < 200) continue;
      // A finished video: portrait 1080x1920 with sound, outside the folders raw material lives in.
      if (VIDEO.test(f) && m.width === 1080 && m.height === 1920 && m.audio && m.duration >= 5 && !ASSET_DIRS.test(f)) { c.renders++; continue; }
      const id = `asset-${h.slice(0, 12)}`, rel = relative(ws.root, f);
      const entry = { ...(known ?? {}), id, kind: "asset", project, source: `${ws.name} workspace`, file: f, rel, sha: h, size: st.size, mtime: st.mtimeMs,
        width: m.width, height: m.height, duration: m.duration, license: "yours", tags: known?.description ? `${known.description} ${pathWords(rel)}` : pathWords(rel),
        description: known?.description ?? null, thumb: frame(f, id, m.duration), added: known?.added ?? new Date().toISOString(), used: known?.used ?? [] };
      if (known) Object.assign(known, entry); else { all.push(entry); byFile.set(f, entry); bySha.set(h, entry); c.added++; }
    }
  }
  // Files gone from disk drop out (in place: save() writes this caller's changes, removals included).
  for (let i = all.length - 1; i >= 0; i--) if (all[i].kind === "asset" && !existsSync(all[i].file)) all.splice(i, 1);
  save(all);
  return counts;
}

// A file sent in (from Telegram): copied into the project's workspace (assets/telegram/) and
// catalogued at once. A description given replaces Claude's; tags are extra search words. The
// same file sent again isn't kept twice: the catalogued one gets the new description instead.
export function ingest(project, src, name, { description = null, tags = null } = {}) {
  const ws = workspaces()[project];
  if (!ws) throw new Error(`${project} has no workspace`);
  const file = join(ws.root, "assets", "telegram", name);
  mkdirSync(dirname(file), { recursive: true });
  copyFileSync(src, file);
  scan(project);
  const all = load(), e = all.find((x) => x.kind === "asset" && (x.file === file || x.copies?.includes(file)));
  const dup = !!e && e.file !== file;
  if (dup) { rmSync(file, { force: true }); e.copies = e.copies.filter((c) => c !== file); }
  else if (!e) { rmSync(file, { force: true }); return null; }   // too small, or a finished video
  if (description) e.description = description;
  e.tags = [e.description, tags, pathWords(e.rel ?? "")].filter(Boolean).join(" ");
  save(all);
  return { entry: e, dup };
}

function sheetImage(tiles, out, cols = 5) {
  mkdirSync(dirname(out), { recursive: true });
  const spec = join(DIR, `.tiles-${process.pid}.json`);
  writeFileSync(spec, JSON.stringify(tiles));
  const r = spawnSync(PY, [join(ROOT, "scripts", "sheet.py"), spec, out, String(cols)], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`sheet.py: ${r.stderr || r.error?.message}`);
  return out;
}

// One Claude call per 20 undescribed assets: it sees them as a numbered contact sheet.
export function describe(only = null, { limit = Infinity, log = console.log } = {}) {
  const ws = workspaces();
  let done = 0;
  for (;;) {
    const all = load();
    const todo = all.filter((e) => e.kind === "asset" && !e.description && e.thumb && existsSync(e.thumb) && (!only || e.project === only) && ws[e.project]);
    if (!todo.length || done >= limit) return done;
    const project = todo[0].project, batch = todo.filter((e) => e.project === project).slice(0, 20);
    const sheet = sheetImage(batch.map((e) => ({ image: e.thumb, label: basename(e.file).slice(0, 22) })), join(DIR, `.describe-${process.pid}.jpg`));
    const prompt = `This contact sheet shows ${batch.length} numbered assets from the workspace of ${ws[project].name}${ws[project].about ? ` (${ws[project].about})` : ""}. `
      + "For each number, write one line `N: <what it shows>` in 6 to 16 words: say whether it's an app screen (and which screen), a screen recording, a photo or footage, and what is in it, so someone can find it by searching. Nothing else.";
    const msg = { type: "user", message: { role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: readFileSync(sheet).toString("base64") } },
      { type: "text", text: prompt }] } };
    // One command string: claude is a .cmd shim on Windows, so it runs through the shell.
    const r = spawnSync(`claude -p --model ${MODEL} --input-format stream-json --output-format stream-json --verbose --strict-mcp-config --no-session-persistence`, { input: JSON.stringify(msg) + "\n", encoding: "utf8", shell: true, timeout: 180_000, maxBuffer: 1 << 24 });
    const result = (r.stdout ?? "").split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j?.type === "result")?.result ?? "";
    const lines = new Map([...result.matchAll(/^\s*(\d+)\s*[:.)-]\s*(.+)$/gm)].map((m) => [Number(m[1]), m[2].trim()]));
    if (!lines.size) { log(`describe: no answer for ${project} (${(r.stderr || "").slice(0, 200)})`); return done; }
    const fresh = load();
    batch.forEach((e, i) => {
      const d = lines.get(i + 1), x = fresh.find((y) => y.id === e.id);
      if (d && x) { x.description = d; x.tags = `${d} ${pathWords(x.rel ?? "")}`; }
    });
    save(fresh);
    done += batch.length;
    log(`described ${batch.length} ${project} assets (${todo.length - batch.length} to go)`);
  }
}

// Longer videos, moment by moment: up to 12 frames across the video, labelled with their time,
// go to Claude as one sheet; it splits the video into stretches ("8-20: photos sort into jobs").
// Each stretch is searchable on its own, so a search returns the file and the seconds to use.
const ask = (sheet, prompt) => {
  const msg = { type: "user", message: { role: "user", content: [
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: readFileSync(sheet).toString("base64") } },
    { type: "text", text: prompt }] } };
  // One command string: claude is a .cmd shim on Windows, so it runs through the shell.
  const r = spawnSync(`claude -p --model ${MODEL} --input-format stream-json --output-format stream-json --verbose --strict-mcp-config --no-session-persistence`,
    { input: JSON.stringify(msg) + "\n", encoding: "utf8", shell: true, timeout: 180_000, maxBuffer: 1 << 24 });
  return { text: (r.stdout ?? "").split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j?.type === "result")?.result ?? "", err: r.stderr ?? "" };
};
export const parseSegments = (text, duration) => [...text.matchAll(/^\s*(\d+(?:\.\d+)?)\s*s?\s*[-–to]+\s*(\d+(?:\.\d+)?)\s*s?\s*[:.)-]\s*(.+)$/gm)]
  .map((m) => ({ from: Number(m[1]), to: Math.min(Number(m[2]), duration), text: m[3].trim() }))
  .filter((g) => g.to > g.from && g.from < duration);

export function segmentVideos(only = null, { minSeconds = 5, log = console.log } = {}) {
  const ws = workspaces();
  let done = 0;
  for (const e of load().filter((x) => x.kind === "asset" && x.duration > minSeconds && !x.segments && existsSync(x.file) && (!only || x.project === only) && ws[x.project])) {
    const step = Math.max(2, e.duration / 12), dir = join(DIR, `.frames-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    try {
      execFileSync("ffmpeg", ["-v", "error", "-y", "-i", e.file, "-vf", `fps=1/${step.toFixed(2)},scale=480:-2`, "-frames:v", "12", join(dir, "f%02d.jpg")], { stdio: "ignore" });
      const frames = readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort();
      if (!frames.length) continue;
      const sheet = sheetImage(frames.map((f, i) => ({ image: join(dir, f), label: `${Math.round(i * step)}s` })), join(DIR, `.segments-${process.pid}.jpg`), 4);
      const prompt = `These are frames from one ${e.duration}-second video (${e.description ?? "an asset"}) of ${ws[e.project].name}, in order; each tile shows the second it was taken. `
        + "Split the video into the stretches where something different happens on screen. One line per stretch, `START-END: what happens` in seconds, 6 to 16 words, "
        + `covering 0 to ${e.duration}. Name app screens and actions so someone can find the moment by searching. Nothing else.`;
      const { text, err } = ask(sheet, prompt);
      const segments = parseSegments(text, e.duration);
      if (!segments.length) { log(`segments: no answer for ${e.rel} (${err.slice(0, 120)})`); continue; }
      const fresh = load(), x = fresh.find((y) => y.id === e.id);
      if (!x) continue;
      x.segments = segments;
      x.tags = `${x.description ?? ""} ${segments.map((g) => g.text).join(" ")} ${pathWords(x.rel ?? "")}`;
      save(fresh);
      done++;
      log(`${e.rel}: ${segments.length} stretches`);
    } finally {
      for (const f of existsSync(dir) ? readdirSync(dir) : []) rmSync(join(dir, f), { force: true });
    }
  }
  return done;
}

// Contact sheets for the creator: library/sheets/<project>-<n>.jpg (30 per sheet, least used
// first) and <project>-<n>.txt saying which file each number is.
export function sheets(only = null) {
  const made = [];
  for (const project of Object.keys(workspaces())) {
    if (only && project !== only) continue;
    const items = load().filter((e) => e.kind === "asset" && e.project === project && e.thumb && existsSync(e.thumb))
      .sort((a, b) => (a.used?.length ?? 0) - (b.used?.length ?? 0) || a.rel.localeCompare(b.rel));
    for (let i = 0; i * 30 < items.length; i++) {
      const page = items.slice(i * 30, i * 30 + 30), base = join(SHEETS, `${project}-${i + 1}`);
      sheetImage(page.map((e) => ({ image: e.thumb, label: basename(e.file).slice(0, 22) })), `${base}.jpg`, 6);
      writeFileSync(`${base}.txt`, page.map((e, n) => `${n + 1}. ${e.file}\n   ${e.description ?? "(not described yet)"}${e.duration ? ` · ${e.duration}s` : ""} · ${e.width}x${e.height}`).join("\n") + "\n");
      made.push(`${base}.jpg`);
    }
  }
  return made;
}

// How much fresh material a project has: assets unused for 30 days, by kind. Low when under a
// third overall, or fewer than 5 of a kind that has at least 10.
export function stock(project) {
  const since = Date.now() - 30 * 86_400_000;
  const items = load().filter((e) => e.kind === "asset" && e.project === project && existsSync(e.file));
  const unused = (e) => !(e.used ?? []).some((u) => (u.project ?? e.project) === project && Date.parse(u.at) > since);
  const kind = (e) => (e.duration ? "footage" : /[\\/](ui|screens?|screenshots)[\\/]/i.test(e.file) || /^(app )?screen/i.test(e.description ?? "") ? "app screens" : "photos and images");
  const kinds = {};
  for (const e of items) { const k = (kinds[kind(e)] ??= { total: 0, unused: 0 }); k.total++; if (unused(e)) k.unused++; }
  const fresh = items.filter(unused).length, share = items.length ? fresh / items.length : 1;
  const thin = Object.entries(kinds).filter(([, k]) => k.total >= 10 && k.unused < 5).map(([n]) => n);
  return { project, total: items.length, fresh, share, kinds, thin, low: items.length > 0 && (share < 1 / 3 || thin.length > 0) };
}
export const stockLine = (s) => `${s.project}: ${s.fresh} of ${s.total} assets unused in 30 days (${Math.round(s.share * 100)}%). `
  + Object.entries(s.kinds).map(([n, k]) => `${n}: ${k.unused}/${k.total} unused`).join(", ") + "."
  + (s.thin.length ? ` Running thin: ${s.thin.join(", ")}.` : "");

// The planner's view: each project's assets by path and description, least used first.
export function inventory(project, max = 150) {
  return load().filter((e) => e.kind === "asset" && e.project === project && existsSync(e.file))
    .sort((a, b) => (a.used?.length ?? 0) - (b.used?.length ?? 0))
    .slice(0, max).map((e) => `${e.rel.replace(/\\/g, "/")}${e.description ? ` (${e.description})` : ""}`);
}

if (import.meta.filename === process.argv[1]) {
  const [cmd, ...args] = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : null; };
  const project = opt("project");
  if (cmd === "scan") {
    const counts = scan(project);
    for (const [p, c] of Object.entries(counts)) console.log(`${p}: ${c.files} files, ${c.added} new, ${c.renders} finished videos skipped, ${c.copies} copies`);
    if (!args.includes("--no-describe")) {
      console.log(`${describe(project)} described`);
      console.log(`${segmentVideos(project)} longer videos described moment by moment`);
    }
    console.log(`sheets: ${sheets(project).length}`);
    writeFileSync(join(DIR, ".last-scan"), new Date().toISOString());
  } else if (cmd === "segments") {
    console.log(`${segmentVideos(project)} videos described moment by moment`);
  } else if (cmd === "stock") {
    for (const p of Object.keys(workspaces())) console.log(stockLine(stock(p)));
  } else if (cmd === "sheets") {
    for (const s of sheets(project)) console.log(s);
  } else if (cmd === "list") {
    const items = load().filter((e) => e.kind === "asset" && (!project || e.project === project));
    for (const e of items) console.log(`${e.project.padEnd(9)} ${e.rel.slice(0, 60).padEnd(60)} ${e.description ?? "-"}`);
    console.log(`${items.length} assets, ${items.filter((e) => e.description).length} described`);
  } else {
    console.log(readFileSync(import.meta.filename, "utf8").split("\n").slice(0, 12).join("\n").replace(/^\/\/ ?/gm, ""));
  }
}
