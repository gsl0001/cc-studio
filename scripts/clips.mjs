// The clip library: real footage for a scene before anything is generated. It looks in the
// library first (clips already downloaded or added by hand), then in free stock libraries
// (Pexels and Pixabay with free keys; Wikimedia Commons' public-domain clips and NASA's video
// library with no key at all; all free for commercial use without credit), downloads what
// fits into the library, and prints each clip with a frame to look at.
//
//   node scripts/clips.mjs find "<what the scene shows>" [--seconds 4] [--count 3] [--project <id>]
//   node scripts/clips.mjs used <file>[@start-end] <post key>   record a use (the hand-off does it)
//   node scripts/clips.mjs add <file> "<what it shows>"    put your own footage in the library
//   node scripts/clips.mjs request "<scene>" --key <post key> [--seconds 4]
//                                     nothing fits: ask the user (Telegram) for a clip, with
//                                     search links; their reply lands in the library
//   node scripts/clips.mjs requests   the requests still waiting
//   node scripts/clips.mjs list
//
// Keys (free): PEXELS_API_KEY (pexels.com/api), PIXABAY_API_KEY (pixabay.com/api/docs), in
// .env or the environment. Without them it still searches the library, Wikimedia Commons
// and NASA.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

const ROOT = resolve(dirname(import.meta.filename), "..");   // the library is the repo's, whatever folder this runs from
export const DIR = join(ROOT, "library", "clips"), INDEX = join(DIR, "index.json"), THUMBS = join(DIR, "thumbs");
const REUSE_DAYS = 30;   // a clip this project used more recently ranks last

// .env -> process.env, without overriding what is already set
if (existsSync(join(ROOT, ".env"))) for (const line of readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
}

const STOP = new Set("a an the and or of in on at to for with by from is are be this that it its as into over under up down out off while very just".split(" "));
export const words = (s) => [...new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/)
  .filter((w) => w.length > 1 && !STOP.has(w)).map(stem))];
// "opening" ~ "open", "walls" ~ "wall", "framed" ~ "frame": close enough to match on.
function stem(w) {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -1).replace(/e$/, "");
  return w.length > 3 ? w.replace(/([^s])s$/, "$1").replace(/e$/, "") : w;
}

// Several processes edit the catalogue at once (the bot's Telegram intake, a scan describing, a
// hand-off recording uses), each one loading it, changing a few entries and saving. So save()
// writes only what its caller changed since that load(), onto the file as it is now: entries
// changed, added or removed. Two callers changing the same entry: the later save wins.
const loadedAs = new WeakMap();   // an array load() returned -> Map(id -> its JSON then)
const readIndex = () => (existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, "utf8")) : []);
const snap = (all) => new Map(all.map((e) => [e.id, JSON.stringify(e)]));
export const load = () => { const all = readIndex(); loadedAs.set(all, snap(all)); return all; };
// Pure: the file now, as this caller found it, as this caller has it -> what to write.
export function merge(current, before, mine) {
  const byId = new Map(mine.map((e) => [e.id, e]));
  const out = current.filter((e) => byId.has(e.id) || !before.has(e.id))
    .map((e) => (byId.has(e.id) && JSON.stringify(byId.get(e.id)) !== before.get(e.id) ? byId.get(e.id) : e));
  const have = new Set(out.map((e) => e.id));
  return [...out, ...mine.filter((e) => !have.has(e.id) && !before.has(e.id))];
}
export function save(all) {
  mkdirSync(DIR, { recursive: true });
  const before = loadedAs.get(all), out = before ? merge(readIndex(), before, all) : all;
  const tmp = `${INDEX}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n");
  // Renamed into place, so a reader never sees half a file. Windows refuses while another
  // process has the file open for a moment, so it tries again briefly.
  for (let i = 0; ; i++) {
    try { renameSync(tmp, INDEX); break; } catch (e) { if (i >= 20) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
  }
  loadedAs.set(all, snap(all));
}

// How well a library clip fits the words: the share of the query's words it carries.
export function score(entry, query) {
  const q = words(query), have = new Set(words(`${entry.tags} ${entry.query ?? ""}`));
  return q.length ? q.filter((w) => have.has(w)).length / q.length : 0;
}
const HIDE_DAYS = 14;    // used by this project this recently: not offered unless asked (--reuse)
const usedBy = (u, project) => !project || (u.project ?? u.key?.split("-")[0]) === project;
const recentUses = (e, project, days) => (e.used ?? []).filter((u) => usedBy(u, project) && Date.now() - Date.parse(u.at) < days * 86_400_000);
const recentlyUsed = (e, project) => recentUses(e, project, REUSE_DAYS).length > 0;
const overlaps = (a, b) => a.from < b.to && b.from < a.to;
// What of an entry is still fresh for this project: null when nothing is (the whole file was
// used, or every stretch overlaps a recent use); else the entry, its stretches cut to the fresh ones.
export function fresh(e, project, days = HIDE_DAYS) {
  const uses = recentUses(e, project, days);
  if (!uses.length) return e;
  if (uses.some((u) => u.from == null) || !e.segments?.length) return null;
  const left = e.segments.filter((g) => !uses.some((u) => overlaps(g, u)));
  return left.length ? { ...e, segments: left, partlyUsed: uses.map((u) => `${u.from}-${u.to}s`) } : null;
}
export const usageLine = (e, project) => {
  const u = (e.used ?? []).filter((x) => usedBy(x, project));
  if (!u.length) return "never used";
  const last = u.map((x) => x.at).sort().at(-1);
  return `used ${u.length}x, last ${new Date(last).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
};
// "file@12-16.5; other.png" -> [{ file, from, to }]: what a finished video used.
export const parseUses = (list) => String(list ?? "").split(";").map((x) => x.trim()).filter(Boolean).map((x) => {
  const m = /^(.*?)(?:@(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?))?$/.exec(x);
  return { file: m[1].trim().replace(/^["']|["']$/g, ""), from: m[2] == null ? null : Number(m[2]), to: m[3] == null ? null : Number(m[3]) };
});
// Records one use; returns the entry, or null when the file isn't in the library or catalogue.
export function recordUse(file, key, { from = null, to = null, project = null } = {}) {
  const all = load(), want = resolve(file).toLowerCase();
  const e = all.find((x) => resolve(x.file).toLowerCase() === want || (x.copies ?? []).some((c) => resolve(c).toLowerCase() === want));
  if (!e) return null;
  e.used = [...(e.used ?? []), { key, project: project ?? e.project ?? key.split("-")[0], at: new Date().toISOString(), ...(from != null ? { from, to } : {}) }];
  save(all);
  return e;
}

// The best rendition of a stock video for a 1080x1920 frame: portrait first, then the
// smallest one at least 1080 px on its short side (else the biggest there is).
export function bestFile(files) {
  const ok = files.filter((f) => f.link && f.width && f.height);
  const rank = (f) => [f.height >= f.width ? 0 : 1, Math.min(f.width, f.height) >= 1080 ? 0 : 1, Math.abs(Math.min(f.width, f.height) - 1080)];
  return ok.sort((a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; })[0] ?? null;
}

async function pexels(query, n) {
  const key = process.env.PEXELS_API_KEY;
  if (!key) return [];
  const r = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&orientation=portrait&per_page=${n}`, { headers: { Authorization: key } });
  if (!r.ok) throw new Error(`Pexels ${r.status}`);
  return (await r.json()).videos.map((v) => {
    const f = bestFile(v.video_files.map((x) => ({ link: x.link, width: x.width, height: x.height })));
    return f && { id: `pexels-${v.id}`, source: "Pexels", page: v.url, author: v.user?.name ?? "", duration: v.duration, width: f.width, height: f.height,
      link: f.link, tags: v.url.replace(/^.*\/video\/|-\d+\/?$/g, "").replace(/-/g, " "), license: "Pexels License: free to use, no credit required" };
  }).filter(Boolean);
}
async function pixabay(query, n) {
  const key = process.env.PIXABAY_API_KEY;
  if (!key) return [];
  const r = await fetch(`https://pixabay.com/api/videos/?key=${key}&q=${encodeURIComponent(query.slice(0, 100))}&per_page=${Math.max(3, n)}&safesearch=true`);
  if (!r.ok) throw new Error(`Pixabay ${r.status}`);
  return (await r.json()).hits.map((v) => {
    const f = bestFile(Object.values(v.videos ?? {}).map((x) => ({ link: x.url, width: x.width, height: x.height })));
    return f && { id: `pixabay-${v.id}`, source: "Pixabay", page: v.pageURL, author: v.user ?? "", duration: v.duration, width: f.width, height: f.height,
      link: f.link, tags: v.tags ?? "", license: "Pixabay Content License: free to use, no credit required" };
  }).filter(Boolean);
}

// Wikimedia Commons: only public-domain and CC0 files (no credit, no share-alike), at most 80 MB.
const UA = { "user-agent": "cc-studio clip library (https://github.com/gsl0001/cc-studio)" };
async function wikimedia(query, n) {
  const u = "https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6"
    + `&gsrlimit=${Math.max(10, n * 3)}&gsrsearch=${encodeURIComponent(`filetype:video ${query}`)}`
    + "&prop=imageinfo&iiprop=url%7Csize%7Cextmetadata&iiextmetadatafilter=LicenseShortName%7CArtist%7CImageDescription";
  const r = await fetch(u, { headers: UA });
  if (!r.ok) throw new Error(`Wikimedia ${r.status}`);
  const strip = (h) => String(h ?? "").replace(/<[^>]+>/g, "").trim();
  return Object.values((await r.json()).query?.pages ?? {}).map((p) => {
    const i = p.imageinfo?.[0], lic = strip(i?.extmetadata?.LicenseShortName?.value);
    if (!i?.url || !/^(public domain|cc0|pd\b|pdm)/i.test(lic) || i.size > 80 * 1024 * 1024) return null;
    return { id: `wikimedia-${p.pageid}`, source: "Wikimedia Commons", page: i.descriptionurl, author: strip(i.extmetadata?.Artist?.value).slice(0, 80),
      duration: i.duration ? Math.round(i.duration * 10) / 10 : null, width: i.width, height: i.height, link: i.url,
      tags: `${p.title.replace(/^File:|\.[a-z0-9]+$/gi, "")} ${strip(i.extmetadata?.ImageDescription?.value).slice(0, 200)}`, license: `${lic}: free to use, no credit required` };
  }).filter(Boolean);
}
// NASA's image and video library: public domain (no NASA logo or endorsement implied).
async function nasa(query, n) {
  const r = await fetch(`https://images-api.nasa.gov/search?media_type=video&q=${encodeURIComponent(query)}`);
  if (!r.ok) throw new Error(`NASA ${r.status}`);
  const out = [];
  for (const it of ((await r.json()).collection?.items ?? []).slice(0, n)) {
    const d = it.data?.[0];
    const files = await fetch(it.href).then((x) => x.json()).catch(() => []);
    const link = ["~medium.mp4", "~large.mp4", "~mobile.mp4"].map((k) => files.find((f) => f.endsWith(k))).find(Boolean);
    if (d && link) out.push({ id: `nasa-${d.nasa_id}`.slice(0, 80), source: "NASA", page: `https://images.nasa.gov/details/${encodeURIComponent(d.nasa_id)}`, author: d.center ?? "NASA",
      duration: null, width: null, height: null, link: link.replace(/^http:/, "https:"), tags: `${d.title} ${(d.keywords ?? []).join(" ")}`,
      license: "NASA media: public domain, no credit required; don't use NASA logos or imply endorsement" });
  }
  return out;
}

// ---------------------------------------------------------------- your own clips and requests
// Your clips: a file you add, or one you send for a request. Non-mp4 files become H.264 mp4.
export function addClip(src, description, extra = {}) {
  mkdirSync(DIR, { recursive: true });
  const id = extra.id ?? `own-${Date.now().toString(36)}`, file = join(DIR, `${id}.mp4`);
  if (extname(src).toLowerCase() === ".mp4") copyFileSync(src, file);
  else execFileSync("ffmpeg", ["-v", "error", "-y", "-i", src, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-an", file]);
  const all = load(), entry = { id, source: "your own", file, tags: description, license: "yours", ...probe(file), added: new Date().toISOString(), used: [], ...extra };
  all.push(entry); save(all);
  return entry;
}

// A request: what the scene needs, for which post, and where to look. The user answers with a
// clip (Telegram, or the inbox folder) or "Make it without".
const REQUESTS = join(DIR, "requests.json"), INBOX = join(DIR, "inbox");
const loadRequests = () => (existsSync(REQUESTS) ? JSON.parse(readFileSync(REQUESTS, "utf8")) : []);
const saveRequests = (all) => { mkdirSync(DIR, { recursive: true }); writeFileSync(REQUESTS, JSON.stringify(all, null, 2) + "\n"); };
export const openRequests = () => loadRequests().filter((r) => r.status === "open");
export const searchLinks = (q) => [["Pexels", `https://www.pexels.com/search/videos/${encodeURIComponent(q)}/?orientation=portrait`],
  ["Pixabay", `https://pixabay.com/videos/search/${encodeURIComponent(q)}/`]];
export function requestMessage(r) {
  return `🎬 Clip needed${r.key ? ` for ${r.key}` : ""}:\n${r.query}\n\nAt least ${r.seconds} s, vertical if you can find one. Search with the buttons, download one you like `
    + `(free to use, no credit needed), and send it here as a reply to this message. Telegram lets bots take files up to 20 MB; for a bigger one, `
    + `put it in ${INBOX}.\nCLIP: ${r.id}`;
}
async function request(query, { key = null, seconds = 3 }) {
  const all = loadRequests(), r = { id: Date.now().toString(36), query, key, seconds, status: "open", at: new Date().toISOString() };
  all.push(r); saveRequests(all);
  mkdirSync(INBOX, { recursive: true });
  try {
    const { tg, channel } = await import("../src/telegram.js");
    await tg("sendMessage", { chat_id: channel().chatId, text: requestMessage(r), reply_markup: { inline_keyboard: [
      searchLinks(query).map(([name, url]) => ({ text: `Search ${name}`, url })),
      [{ text: "Make it without", callback_data: `clipskip:${r.id}` }]] } });
    r.sent = true;
  } catch (e) { r.sent = false; r.error = e.message; }
  saveRequests(loadRequests().map((x) => (x.id === r.id ? r : x)));
  return r;
}
// A clip arrived for a request: into the library under the request's words. Returns the request
// and, when it was the post's last open request, every clip that came for that post.
export function fulfil(id, src) {
  const all = loadRequests(), r = all.find((x) => x.id === id && x.status === "open");
  if (!r) return null;
  const entry = addClip(src, r.query, { id: `asked-${r.id}`, source: "you (requested)", request: r.id });
  Object.assign(r, { status: "done", file: entry.file, done: new Date().toISOString() });
  saveRequests(all);
  const forPost = r.key ? all.filter((x) => x.key === r.key) : [r];
  return { request: r, entry, lastForPost: !forPost.some((x) => x.status === "open"), clips: forPost.filter((x) => x.status === "done") };
}
export function skipRequest(id) {
  const all = loadRequests(), r = all.find((x) => x.id === id && x.status === "open");
  if (!r) return null;
  Object.assign(r, { status: "skipped", done: new Date().toISOString() });
  saveRequests(all);
  return { request: r, lastForPost: !all.some((x) => x.key === r.key && x.status === "open") };
}
// Files dropped in the inbox: for the one open request (if exactly one), else plain library clips
// named after the file. Returns what fulfil() returned for each request answered.
export function sweepInbox() {
  if (!existsSync(INBOX)) return [];
  const answered = [];
  for (const name of readdirSync(INBOX).filter((n) => /\.(mp4|mov|webm|mkv|m4v)$/i.test(n))) {
    const f = join(INBOX, name), open = openRequests();
    try {
      if (open.length === 1) answered.push(fulfil(open[0].id, f));
      else addClip(f, basename(name, extname(name)).replace(/[-_]+/g, " "));
      rmSync(f, { force: true });
    } catch (e) { console.log(`inbox ${name}: ${e.message}`); }
  }
  return answered.filter(Boolean);
}

export function thumb(file, duration) {
  mkdirSync(THUMBS, { recursive: true });
  const out = join(THUMBS, `${basename(file, extname(file))}.jpg`);
  if (!existsSync(out)) {
    try { execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String((duration || 2) / 2), "-i", file, "-frames:v", "1", "-vf", "scale=360:-2", out], { stdio: "ignore" }); } catch { return null; }
  }
  return out;
}
export const probe = (file) => {
  try {
    const [w, h, d] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "csv=p=0:s=,", file])
      .toString().split(/[,\r\n]+/).map(Number);
    return { width: w, height: h, duration: Math.round(d * 10) / 10 };
  } catch { return {}; }
};

async function find(query, { seconds = 3, count = 3, project = null, reuse = null }) {
  let hidden = 0;
  const all = load().map((e) => {
    if (reuse || !existsSync(e.file)) return e;
    const f = fresh(e, project);
    if (!f) hidden++;
    return f;
  }).filter(Boolean);
  const fits = (e) => !e.duration || e.duration >= seconds;
  const own = (e) => (e.kind === "asset" ? 0 : 1);   // the project's own screens, photos and takes before any stock
  let picks = all.filter((e) => existsSync(e.file) && fits(e) && (e.kind !== "asset" || !project || e.project === project))
    // Your own assets are offered on looser matches (the creator looks at the frames anyway);
    // stock needs half the words.
    .map((e) => {   // a long video is as good as its best stretch for these words
      const best = (e.segments ?? []).map((g) => ({ g, s: score({ tags: `${g.text} ${e.description ?? ""}` }, query) })).sort((a, b) => b.s - a.s)[0];
      const whole = score(e, query);
      // the whole video's words span every stretch, so it ranks on the larger score and always
      // names its best stretch: that's the part to cut
      return best?.s > 0 ? { e: { ...e, part: best.g }, s: Math.max(best.s, whole) } : { e, s: whole };
    }).filter((x) => x.s >= (x.e.kind === "asset" ? 0.2 : 0.5))
    // used by this project in the last 30 days costs a little relevance, not its place: a long
    // video's fresh stretches still win when they fit best
    .sort((a, b) => own(a.e) - own(b.e) || (b.s - 0.3 * recentlyUsed(b.e, project)) - (a.s - 0.3 * recentlyUsed(a.e, project))).slice(0, count).map((x) => ({ ...x.e, from: "library" }));
  const errors = [];
  if (picks.length < count) {
    const found = [];
    for (const src of [pexels, pixabay, wikimedia, nasa]) {   // in this order: the best footage first
      if (found.filter((c) => !c.duration || c.duration >= seconds).length >= count * 3) break;
      found.push(...await src(query, src === nasa ? 3 : 10).catch((e) => { errors.push(e.message); return []; }));
    }
    const seen = new Set(load().map((e) => e.id));
    const order = (c) => ["Pexels", "Pixabay", "Wikimedia Commons", "NASA"].indexOf(c.source) * 2 + (c.height >= c.width ? 0 : 1);
    for (const c of found.filter((c) => (!c.duration || c.duration >= seconds) && !seen.has(c.id)).sort((a, b) => order(a) - order(b))) {
      if (picks.length >= count) break;
      const file = join(DIR, `${c.id.replace(/[^\w.-]+/g, "_")}.mp4`);
      try {
        const r = await fetch(c.link, { headers: UA });
        if (!r.ok) throw new Error(`download ${r.status}`);
        if (Number(r.headers.get("content-length")) > 80 * 1024 * 1024) { r.body?.cancel(); continue; }
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 80 * 1024 * 1024) continue;
        mkdirSync(DIR, { recursive: true });
        const ext = (/\.(\w{2,4})(?:\?|$)/.exec(c.link)?.[1] ?? "mp4").toLowerCase();
        if (ext === "mp4") writeFileSync(file, buf);
        else {   // .ogv/.webm from Wikimedia: an H.264 mp4 every composer can use
          const raw = `${file}.${ext}`;
          writeFileSync(raw, buf);
          try { execFileSync("ffmpeg", ["-v", "error", "-y", "-i", raw, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-an", file]); }
          finally { rmSync(raw, { force: true }); }
        }
      } catch (e) { errors.push(`${c.id}: ${e.message}`); continue; }
      Object.assign(c, Object.fromEntries(Object.entries(probe(file)).filter(([, v]) => v)));
      if (c.duration && c.duration < seconds) { rmSync(file, { force: true }); continue; }
      const { link, ...meta } = c;
      const entry = { ...meta, file, query, added: new Date().toISOString(), used: [] };
      const lib = load(); lib.push(entry); save(lib); seen.add(c.id);
      picks.push({ ...entry, from: c.source });
    }
  }
  return { hidden, picks: picks.map((p) => ({ ...p, thumb: p.thumb && existsSync(p.thumb) ? p.thumb : thumb(p.file, p.duration) })), errors,
    keys: [process.env.PEXELS_API_KEY && "Pexels", process.env.PIXABAY_API_KEY && "Pixabay"].filter(Boolean) };
}

if (import.meta.filename === process.argv[1]) {
  const [cmd, ...args] = process.argv.slice(2);
  const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : def; };
  if (cmd === "find") {
    const seconds = Number(opt("seconds", 3)), count = Number(opt("count", 3)), project = opt("project", null), reuse = opt("reuse", null);
    const query = args.join(" ").trim();
    if (!query) { console.error('say what the scene shows: node scripts/clips.mjs find "rain on a window at night"'); process.exit(2); }
    const r = await find(query, { seconds, count, project, reuse });
    if (!r.picks.length) console.log(`No clip for "${query}" in your material, the library or the free sources${r.keys.length ? "" : " (Pexels and Pixabay not searched: no keys)"}. Try other words, look at the contact sheets, or make the scene.`);
    for (const p of r.picks) console.log(`${p.file}\n  ${p.from === "library" ? `library (${p.source})` : `new from ${p.from}`} · ${p.width}x${p.height}${p.duration ? ` · ${p.duration}s` : " · image"} · ${p.description ?? p.tags}${p.part ? `\n  best match: ${p.part.from}-${p.part.to}s: ${p.part.text}` : ""}${p.segments?.length ? `\n  all of it:${p.segments.map((g) => `\n    ${g.from}-${g.to}s ${g.text}`).join("")}` : ""}\n  look at: ${p.thumb ?? "(no frame)"}\n  ${p.license}${p.author ? ` · by ${p.author}` : ""}${p.page ? ` · ${p.page}` : ""}\n  ${usageLine(p, project)}${p.partlyUsed ? ` (recently used stretches left out: ${p.partlyUsed.join(", ")})` : ""}`);
    for (const e of r.errors) console.log(`(skipped: ${e})`);
    if (r.hidden) console.log(`(${r.hidden} match${r.hidden > 1 ? "es" : ""} hidden: used by ${project ?? "a project"} in the last ${HIDE_DAYS} days. Only if nothing fresh works: add --reuse "<why>".)`);
  } else if (cmd === "used") {
    const [spec, key] = args, [u] = parseUses(spec ?? "");
    const e = u && key ? recordUse(u.file, key, u) : null;
    if (!e) { console.error("usage: used <file>[@start-end] <post key>   (a file from the library or catalogue)"); process.exit(2); }
    console.log(`recorded: ${basename(e.file)}${u.from != null ? ` ${u.from}-${u.to}s` : ""} in ${key}`);
  } else if (cmd === "add") {
    const [src, ...desc] = args;
    if (!src || !existsSync(src) || !desc.length) { console.error('usage: add <video file> "<what it shows>"'); process.exit(2); }
    console.log(`added ${addClip(src, desc.join(" ")).file}`);
  } else if (cmd === "request") {
    const key = opt("key", null), seconds = Number(opt("seconds", 3)), query = args.join(" ").trim();
    if (!query) { console.error('usage: request "<what the scene shows>" --key <post key> [--seconds 4]'); process.exit(2); }
    const r = await request(query, { key, seconds });
    console.log(r.sent ? `Asked the user in Telegram (request ${r.id}). Their clip will land in the library under "${query}".`
      : `Saved request ${r.id}, but Telegram failed (${r.error}); the user sees it in cc ("clip requests").`);
  } else if (cmd === "requests") {
    const open = openRequests();
    for (const r of open) console.log(`${r.id}  ${r.key ?? "-"}  ${r.seconds}s  ${r.query}`);
    console.log(`${open.length} open request(s)`);
  } else if (cmd === "list") {
    const all = load();
    for (const e of all) console.log(`${basename(e.file).padEnd(28)} ${String(e.source).padEnd(9)} ${e.width}x${e.height} ${e.duration}s  ${e.tags.slice(0, 60)}  used ${e.used?.length ?? 0}x`);
    console.log(`${all.length} clip(s) in ${DIR}`);
  } else if (cmd === "test") {
    const assert = (await import("node:assert/strict")).default;
    // Two processes saving the catalogue: each keeps the other's changes.
    const base = [{ id: "a", v: 1 }, { id: "b", v: 1 }, { id: "c", v: 1 }], was = snap(base);
    const first = merge(base, was, [{ id: "a", v: 2 }, { id: "b", v: 1 }, { id: "c", v: 1 }, { id: "d", v: 1 }]);   // changed a, added d
    const second = merge(first, was, [{ id: "a", v: 1 }, { id: "b", v: 9 }]);                                       // changed b, removed c
    assert.deepEqual(second, [{ id: "a", v: 2 }, { id: "b", v: 9 }, { id: "d", v: 1 }], "neither save loses the other's change");
    assert.deepEqual(merge([{ id: "a", v: 5 }], snap([{ id: "a", v: 1 }]), [{ id: "a", v: 1 }]), [{ id: "a", v: 5 }], "an untouched entry keeps the newer copy");
    assert.deepEqual(words("Rain falling on the windows at night"), ["rain", "fall", "window", "night"]);
    assert.deepEqual(words("opening framed walls"), ["open", "fram", "wall"]);
    assert.deepEqual(words("frame wall opens"), ["fram", "wall", "open"]);
    assert.equal(score({ tags: "rain, window, night, city" }, "rain on a window"), 1);
    assert.equal(score({ tags: "office desk laptop" }, "rain on a window"), 0);
    assert.equal(bestFile([{ link: "a", width: 3840, height: 2160 }, { link: "b", width: 1080, height: 1920 }, { link: "c", width: 720, height: 1280 }]).link, "b");
    assert.equal(bestFile([{ link: "a", width: 1920, height: 1080 }, { link: "b", width: 1280, height: 720 }]).link, "a");
    const day = 86_400_000, ago = (d) => new Date(Date.now() - d * day).toISOString();
    const vid = { segments: [{ from: 0, to: 6, text: "a" }, { from: 6, to: 12, text: "b" }, { from: 12, to: 18, text: "c" }] };
    assert.equal(fresh({ ...vid, used: [{ key: "acme-tiktok-x", project: "acme", at: ago(3), from: 6, to: 12 }] }, "acme").segments.length, 2, "a used stretch drops out");
    assert.equal(fresh({ ...vid, used: [{ key: "acme-tiktok-x", project: "acme", at: ago(3) }] }, "acme"), null, "a whole-file use hides it");
    assert.ok(fresh({ ...vid, used: [{ key: "acme-tiktok-x", project: "acme", at: ago(20) }] }, "acme"), "older than 14 days is fresh again");
    assert.ok(fresh({ used: [{ key: "notes-tiktok-x", project: "notes", at: ago(1) }] }, "acme"), "another project's use doesn't count");
    assert.equal(fresh({ used: [{ key: "acme-tiktok-x", at: ago(1) }] }, "acme"), null, "an old record without project uses the key");
    assert.deepEqual(parseUses("C:/a b/x.mp4@12-16.5; y.png"), [{ file: "C:/a b/x.mp4", from: 12, to: 16.5 }, { file: "y.png", from: null, to: null }]);
    console.log("clips ok");
  } else {
    console.log(readFileSync(import.meta.filename, "utf8").split("\n").slice(0, 13).join("\n").replace(/^\/\/ ?/gm, ""));
  }
}
