// The content library: every finished render that enters the queue is hashed,
// probed, thumbnailed and catalogued here, so the system can answer "have we
// already posted this?" before it posts it again.
//
//   npm run library                     list catalogued content, newest first
//   npm run library -- --check <file> <account>   dry-run the duplicate check
//   npm run library -- --import        catalogue the videos already in queue/
//
// Exact file duplicate to the same account is a BLOCK; anything else the
// operator might have meant on purpose is a WARN. The judgement itself is a
// pure function so it can be tested without ffmpeg or a database.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdirSync, existsSync, statSync } from "node:fs";
import { db } from "./db.js";

export const COOLDOWN = {
  same_account_days: 14,   // same concept back on the same channel
  cross_account_days: 3,   // same concept across two of our channels
  // Tuned by replaying every job in queue-archive: 10% flagged 45% of posts
  // (one brand's clips all look alike), 4% flags 7 — real reuse, not house style.
  near_distance_pct: 4,    // perceptual hamming distance counted as "near duplicate"
};

const THUMBS = "data/thumbs";

// --- media inspection ---------------------------------------------------

const ff = (bin, args, opts = {}) =>
  execFileSync(bin, args, { maxBuffer: 1 << 24, stdio: ["ignore", "pipe", "pipe"], ...opts });

export function probe(file) {
  const out = ff("ffprobe", ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-show_entries", "format=duration",
    "-of", "json", file]).toString();
  const j = JSON.parse(out);
  const s = j.streams?.[0] ?? {};
  return { width: s.width ?? null, height: s.height ?? null, duration: Number(j.format?.duration) || null };
}

// aHash of three frames (25/50/75%) — 192 bits. One midpoint frame matches any
// two clips that share a title card; three sample the actual body of the video.
// ponytail: aHash, not DCT pHash — swap in a DCT if re-encodes start slipping past.
export function phash(file, duration) {
  const d = duration && duration > 0 ? duration : 1;
  let bits = "";
  for (const at of [0.25, 0.5, 0.75]) {
    let raw;
    try {
      raw = ff("ffmpeg", ["-v", "error", "-ss", String(d * at), "-i", file, "-frames:v", "1",
        "-vf", "scale=8:8,format=gray", "-f", "rawvideo", "-"]);
    } catch { return null; }
    if (raw.length < 64) return null;
    const px = [...raw.subarray(0, 64)];
    const mean = px.reduce((a, b) => a + b, 0) / 64;
    for (let i = 0; i < 64; i += 4) {
      bits += ((px[i] > mean) * 8 + (px[i + 1] > mean) * 4 + (px[i + 2] > mean) * 2 + (px[i + 3] > mean)).toString(16);
    }
  }
  return bits;
}

export function thumbnail(file, duration, sha) {
  mkdirSync(THUMBS, { recursive: true });
  const out = `${THUMBS}/${sha.slice(0, 12)}.jpg`;
  if (existsSync(out)) return out;
  try {
    ff("ffmpeg", ["-v", "error", "-ss", String((duration || 1) / 2), "-i", file,
      "-frames:v", "1", "-vf", "scale=-2:320", "-y", out]);
  } catch { return null; }
  return existsSync(out) ? out : null;
}

// Hash, probe, thumbnail and catalogue one file. Returns the content row.
export function inspect(file) {
  const sha = createHash("sha256").update(readFileSync(file)).digest("hex");
  const known = db.prepare("SELECT * FROM content WHERE sha=?").get(sha);
  if (known) return known;

  const { width, height, duration } = probe(file);
  const item = {
    sha, phash: phash(file, duration), path: file, bytes: statSync(file).size,
    duration, width, height, thumb: thumbnail(file, duration, sha),
  };
  db.prepare(`INSERT INTO content (sha, phash, path, bytes, duration, width, height, thumb)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(item.sha, item.phash, item.path, item.bytes, item.duration, item.width, item.height, item.thumb);
  return item;
}

// --- duplicate judgement (pure) -----------------------------------------

const POP = [...Array(16)].map((_, n) => (n.toString(2).match(/1/g) ?? []).length);

// null when the two hashes are not comparable — never a distance of 0.
export function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += POP[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  return d;
}

// usages: [{ key, sha, phash, account, at }] — every prior job that carried content.
export function judge(item, account, usages, now = new Date(), cd = COOLDOWN) {
  const findings = [];
  for (const u of usages) {
    const age = (now - new Date(u.at)) / 86_400_000;
    const same = u.account === account;
    const when = `${u.key} (${Math.round(age)}d ago)`;

    if (u.sha === item.sha) {
      if (same) findings.push({ level: "BLOCK", message: `exact same file already queued to ${account} as ${when}` });
      else if (age <= cd.cross_account_days) findings.push({ level: "WARN", message: `exact same file went to ${u.account} as ${when} — inside the ${cd.cross_account_days}d cross-account cooldown` });
      continue;
    }
    const d = hamming(item.phash, u.phash);
    if (d === null) continue;
    const pct = (100 * d) / (item.phash.length * 4);
    if (pct > cd.near_distance_pct) continue;
    if (same && age <= cd.same_account_days) findings.push({ level: "WARN", message: `looks like ${when} on this account (${pct.toFixed(0)}% different) — inside the ${cd.same_account_days}d cooldown` });
    else if (!same && age <= cd.cross_account_days) findings.push({ level: "WARN", message: `looks like ${when} on ${u.account} (${pct.toFixed(0)}% different)` });
  }
  return findings;
}

// Everything already published or waiting, with the content it carries.
export function usages() {
  return db.prepare(`SELECT j.key, j.account, c.sha, c.phash, j.created_at at
                     FROM jobs j JOIN content c ON c.sha = j.content_sha
                     WHERE j.status != 'FAILED'`).all();
}

export function check(item, account, cd = COOLDOWN) {
  return judge(item, account, usages().filter((u) => u.key !== item.key), new Date(), cd);
}

// --- cli ----------------------------------------------------------------

if (import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args[0] === "--check") {
    const [, file, account] = args;
    if (!file || !account) { console.error("usage: npm run library -- --check <file> <account>"); process.exit(1); }
    const findings = check(inspect(file), account);
    for (const f of findings) console.log(`${f.level}  ${f.message}`);
    console.log(findings.length ? "" : "no duplicate risk");
    process.exit(findings.some((f) => f.level === "BLOCK") ? 1 : 0);
  }
  if (args[0] === "--import") {
    // Existing jobs predate the library; without this the first real duplicate
    // is invisible because nothing it could collide with is catalogued.
    let n = 0;
    for (const dir of ["queue", "queue-archive"]) {
      if (!existsSync(dir)) continue;
      for (const d of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
        const file = `${dir}/${d.name}/final.mp4`;
        const row = db.prepare("SELECT content_sha s FROM jobs WHERE key=?").get(d.name);
        if (!existsSync(file) || !row || row.s) continue;
        const it = inspect(file);
        db.prepare("UPDATE jobs SET content_sha=? WHERE key=?").run(it.sha, d.name);
        console.log(`${d.name}  ${it.sha.slice(0, 12)}`);
        n++;
      }
    }
    console.log(`
${n} job(s) linked to library content`);
    process.exit(0);
  }
  const rows = db.prepare(`SELECT c.*, COUNT(j.key) used, GROUP_CONCAT(DISTINCT j.account) accounts
                           FROM content c LEFT JOIN jobs j ON j.content_sha = c.sha
                           GROUP BY c.sha ORDER BY c.first_seen DESC`).all();
  const pad = (s, n) => String(s ?? "").padEnd(n);
  console.log(pad("SHA", 14) + pad("SIZE", 9) + pad("DUR", 7) + pad("DIM", 11) + pad("USED", 6) + "ACCOUNTS");
  for (const r of rows) {
    console.log(pad(r.sha.slice(0, 12), 14) + pad(`${(r.bytes / 1e6).toFixed(1)}MB`, 9) +
      pad(r.duration ? `${r.duration.toFixed(1)}s` : "?", 7) +
      pad(r.width ? `${r.width}x${r.height}` : "?", 11) + pad(r.used, 6) + (r.accounts ?? "unused"));
  }
  console.log(`\n${rows.length} item(s), ${rows.filter((r) => !r.used).length} unused`);
}
