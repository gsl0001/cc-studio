// The clip library: real footage for a scene before anything is generated. It looks in the
// library first (clips already downloaded or added by hand), then in free stock libraries
// (Pexels and Pixabay with free keys; Wikimedia Commons' public-domain clips and NASA's video
// library with no key at all; all free for commercial use without credit), downloads what
// fits into the library, and prints each clip with a frame to look at.
//
//   node scripts/clips.mjs find "<what the scene shows>" [--seconds 4] [--count 3] [--project gola]
//   node scripts/clips.mjs used <clip file> <post key>     record a use (keeps reuse down)
//   node scripts/clips.mjs add <file> "<what it shows>"    put your own footage in the library
//   node scripts/clips.mjs list
//
// Keys (free): PEXELS_API_KEY (pexels.com/api), PIXABAY_API_KEY (pixabay.com/api/docs), in
// .env or the environment. Without them it still searches the library, Wikimedia Commons
// and NASA.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

const ROOT = resolve(dirname(import.meta.filename), "..");   // the library is the repo's, whatever folder this runs from
const DIR = join(ROOT, "library", "clips"), INDEX = join(DIR, "index.json"), THUMBS = join(DIR, "thumbs");
const REUSE_DAYS = 30;   // a clip this project used more recently ranks last

// .env -> process.env, without overriding what is already set
if (existsSync(join(ROOT, ".env"))) for (const line of readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
}

const STOP = new Set("a an the and or of in on at to for with by from is are be this that it its as into over under up down out off while very just".split(" "));
export const words = (s) => [...new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/)
  .filter((w) => w.length > 1 && !STOP.has(w)).map((w) => w.replace(/(ies)$/, "y").replace(/([^s])s$/, "$1")))];

const load = () => (existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, "utf8")) : []);
const save = (all) => { mkdirSync(DIR, { recursive: true }); writeFileSync(INDEX, JSON.stringify(all, null, 2) + "\n"); };

// How well a library clip fits the words: the share of the query's words it carries.
export function score(entry, query) {
  const q = words(query), have = new Set(words(`${entry.tags} ${entry.query ?? ""}`));
  return q.length ? q.filter((w) => have.has(w)).length / q.length : 0;
}
const recentlyUsed = (e, project) => (e.used ?? []).some((u) => (!project || u.key.startsWith(project))
  && Date.now() - Date.parse(u.at) < REUSE_DAYS * 86_400_000);

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

function thumb(file, duration) {
  mkdirSync(THUMBS, { recursive: true });
  const out = join(THUMBS, `${basename(file, extname(file))}.jpg`);
  if (!existsSync(out)) {
    try { execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String((duration || 2) / 2), "-i", file, "-frames:v", "1", "-vf", "scale=360:-2", out]); } catch { return null; }
  }
  return out;
}
const probe = (file) => {
  try {
    const [w, h, d] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "csv=p=0:s=,", file])
      .toString().split(/[,\r\n]+/).map(Number);
    return { width: w, height: h, duration: Math.round(d * 10) / 10 };
  } catch { return {}; }
};

async function find(query, { seconds = 3, count = 3, project = null }) {
  const all = load();
  const fits = (e) => !e.duration || e.duration >= seconds;
  let picks = all.filter((e) => existsSync(e.file) && fits(e)).map((e) => ({ e, s: score(e, query) })).filter((x) => x.s >= 0.5)
    .sort((a, b) => recentlyUsed(a.e, project) - recentlyUsed(b.e, project) || b.s - a.s).slice(0, count).map((x) => ({ ...x.e, from: "library" }));
  const errors = [];
  if (picks.length < count) {
    const found = [];
    for (const src of [pexels, pixabay, wikimedia, nasa]) {   // in this order: the best footage first
      if (found.filter((c) => !c.duration || c.duration >= seconds).length >= count * 3) break;
      found.push(...await src(query, src === nasa ? 3 : 10).catch((e) => { errors.push(e.message); return []; }));
    }
    const seen = new Set(all.map((e) => e.id));
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
      all.push(entry); seen.add(c.id);
      picks.push({ ...entry, from: c.source });
    }
    save(all);
  }
  return { picks: picks.map((p) => ({ ...p, thumb: thumb(p.file, p.duration) })), errors,
    keys: [process.env.PEXELS_API_KEY && "Pexels", process.env.PIXABAY_API_KEY && "Pixabay"].filter(Boolean) };
}

if (import.meta.filename === process.argv[1]) {
  const [cmd, ...args] = process.argv.slice(2);
  const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : def; };
  if (cmd === "find") {
    const seconds = Number(opt("seconds", 3)), count = Number(opt("count", 3)), project = opt("project", null);
    const query = args.join(" ").trim();
    if (!query) { console.error('say what the scene shows: node scripts/clips.mjs find "rain on a window at night"'); process.exit(2); }
    const r = await find(query, { seconds, count, project });
    if (!r.picks.length) console.log(`No clip for "${query}"${r.keys.length ? "" : " (library only: no PEXELS_API_KEY or PIXABAY_API_KEY set)"}. Try other words, or make the scene.`);
    for (const p of r.picks) console.log(`${p.file}\n  ${p.from === "library" ? `library (${p.source})` : `new from ${p.from}`} · ${p.width}x${p.height} · ${p.duration}s · ${p.tags}\n  look at: ${p.thumb ?? "(no frame)"}\n  ${p.license}${p.author ? ` · by ${p.author}` : ""}${p.page ? ` · ${p.page}` : ""}${recentlyUsed(p, project) ? "\n  NOTE: this project used it in the last 30 days" : ""}`);
    for (const e of r.errors) console.log(`(skipped: ${e})`);
  } else if (cmd === "used") {
    const [file, key] = args, all = load(), e = all.find((x) => resolve(x.file) === resolve(file ?? ""));
    if (!e || !key) { console.error("usage: used <clip file from the library> <post key>"); process.exit(2); }
    e.used = [...(e.used ?? []), { key, at: new Date().toISOString() }];
    save(all); console.log(`recorded: ${basename(e.file)} in ${key}`);
  } else if (cmd === "add") {
    const [src, ...desc] = args;
    if (!src || !existsSync(src) || !desc.length) { console.error('usage: add <video file> "<what it shows>"'); process.exit(2); }
    mkdirSync(DIR, { recursive: true });
    const id = `own-${Date.now().toString(36)}`, file = join(DIR, `${id}${extname(src) || ".mp4"}`);
    copyFileSync(src, file);
    const all = load();
    all.push({ id, source: "your own", file, tags: desc.join(" "), license: "yours", ...probe(file), added: new Date().toISOString(), used: [] });
    save(all); console.log(`added ${file}`);
  } else if (cmd === "list") {
    const all = load();
    for (const e of all) console.log(`${basename(e.file).padEnd(28)} ${String(e.source).padEnd(9)} ${e.width}x${e.height} ${e.duration}s  ${e.tags.slice(0, 60)}  used ${e.used?.length ?? 0}x`);
    console.log(`${all.length} clip(s) in ${DIR}`);
  } else if (cmd === "test") {
    const assert = (await import("node:assert/strict")).default;
    assert.deepEqual(words("Rain falling on the windows at night"), ["rain", "falling", "window", "night"]);
    assert.equal(score({ tags: "rain, window, night, city" }, "rain on a window"), 1);
    assert.equal(score({ tags: "office desk laptop" }, "rain on a window"), 0);
    assert.equal(bestFile([{ link: "a", width: 3840, height: 2160 }, { link: "b", width: 1080, height: 1920 }, { link: "c", width: 720, height: 1280 }]).link, "b");
    assert.equal(bestFile([{ link: "a", width: 1920, height: 1080 }, { link: "b", width: 1280, height: 720 }]).link, "a");
    console.log("clips ok");
  } else {
    console.log(readFileSync(import.meta.filename, "utf8").split("\n").slice(0, 13).join("\n").replace(/^\/\/ ?/gm, ""));
  }
}
