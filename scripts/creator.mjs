// One content creator run (agents/creator.md) on the next planned week post; the video
// then goes to Telegram for Approve / Redo / Skip. Started detached by the pulse and by
// the Telegram bot — never two at once (CREATOR_RUNNING holds the live run's pid), and
// never while a finished video still waits for your answer.
//
//   node scripts/creator.mjs [account-id]
//
// A run killed halfway (reboot, sleep, crash) leaves the post planned; the next pulse
// starts it again and the agent resumes from its folder. Three runs without a video
// mark the post blocked. A Claude usage-limit hit is reported, not retried in a loop.
//
// Variety: the agent is shown the brand's recent videos, and every render is compared
// with them frame by frame (scripts/similar.py). A near-duplicate goes straight back for
// a remake with a note naming what it copied; after three tries it reaches the user with
// a warning instead. (In the original deployment, five videos in a row reused one screenshot.)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { db, log } from "../src/db.js";
import { lifecycle } from "../src/log.js";
import { loadRegistry } from "../src/registry.js";
import { notify } from "../src/telegram.js";
import { duePosts, nextVideo, relocateFinal, sendForReview, setPost } from "./posts.mjs";
import { ROOT, config, model, projectWorkspace, rootPath, tool } from "../src/config.js";

export const LOCK = "CREATOR_RUNNING";
export const QUOTA = "CLAUDE_QUOTA";        // the pulse waits 2h after a usage-limit hit
const MAX_RUNS = 3;

// The lock holds "<pid> <post key>" and counts only while that pid is alive and the lock is
// younger than a run can last (a run is killed at 90 min): after a reboot Windows can hand
// the old pid to another long-lived process. Returns the key being made, or null.
export function creatorRunning() {
  if (!existsSync(LOCK) || Date.now() - statSync(LOCK).mtimeMs > 2 * 3_600_000) return null;
  const [pid, key] = readFileSync(LOCK, "utf8").trim().split(" ");
  try { process.kill(Number(pid), 0); return key ?? "unknown post"; } catch { return null; }
}

// The agent run. claude is a .cmd shim, so a plain timeout would kill only cmd.exe and leave
// the agent working on (2026-10-03 review): on timeout the whole process tree goes.
function runAgent(args, input, timeoutMs) {
  return new Promise((done) => {
    const child = spawn("claude", args, { shell: true, windowsHide: true });
    let out = "", timedOut = false;
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => { timedOut = true; spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }); }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); done({ status: timedOut ? "timeout" : code, out }); });
    child.stdin.end(input);
  });
}

const PY = tool(config.paths.python);   // needs opencv-python (scripts/similar.py)
const FINALS = rootPath(config.paths.finals);
const HAND = config.paths.handPost ? rootPath(config.paths.handPost) : null;

// The project's recent videos, pipeline-made and (if you have a hand-post folder) hand-made, newest first.
export function recentVideos(project, except = "", limit = 14) {
  return [`${FINALS}/${project}`, ...(HAND ? [`${HAND}/${project}`] : [])]
    .flatMap((d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".mp4")).map((f) => `${d}/${f}`) : []))
    .filter((f) => resolve(f) !== resolve(except || ".") && basename(f) !== basename(except || "."))   // nor a copy of it
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs).slice(0, limit);
}

// One line per recent video: its README description, so the agent knows what is used up.
function recentBlock(project) {
  const readme = [`${FINALS}/README.md`, ...(HAND ? [`${HAND}/README.md`] : [])].filter(existsSync).map((f) => readFileSync(f, "utf8")).join("\n").split(/\r?\n/);
  return recentVideos(project, "", 10).map((f) => {
    const name = basename(f);
    const line = readme.find((l) => l.includes(`/${name})`));
    return `- ${name}: ${line ? line.replace(/^- \[[^\]]*\]\([^)]*\)\s*[-—]\s*/, "").slice(0, 260) : "(no description)"}`;
  }).join("\n") || "(none yet)";
}

function similarity(video, project) {
  const others = recentVideos(project, video);
  if (!others.length) return null;
  const r = spawnSync(PY, ["scripts/similar.py", video, ...others], { encoding: "utf8", timeout: 15 * 60_000, windowsHide: true,
    env: { ...process.env, SIMILAR_SHARE: String(config.creator.similarityLimit) } });
  try { return JSON.parse((r.stdout ?? "").trim().split("\n").pop()); } catch { return null; }
}

// agents/creator.md with this machine's folders and tools filled in.
function agentInstructions(profile) {
  const win = (p) => p.replace(/\//g, "\\");
  const eleven = process.env.ELEVENLABS_API_KEY
    ? `ElevenLabs through \`${tool(config.paths.python)} ${win(join(ROOT, "tools/eleven.py"))}\`: voiceover \`--text "..." -o vo.wav\` (or \`--lines\`/\`--out-dir\` for multi-line), music bed \`--music --text "<genre, mood, BPM, no vocals>" --seconds <n> -o bgm.mp3\`, sound effects \`--sfx --text "..." -o sfx.wav\`. Mix voice over music at about -14 LUFS.`
    : "no voice service is configured (ELEVENLABS_API_KEY is empty): use on-screen text with royalty-free music already in the workspace's assets, or mark the post blocked if it needs a voice.";
  const fill = {
    ROOT: win(ROOT), FINALS: win(FINALS), APPS: win(join(ROOT, "apps")), WORKSPACE: win(projectWorkspace(profile)),
    GUIDELINES: win(rootPath(config.paths.guidelines)), CONTEXT: win(rootPath(config.paths.context)), TEMPLATE: win(join(ROOT, "content/TEMPLATE.md")),
    PYTHON: tool(config.paths.python), COMPOSITION: config.creator.composition, AUDIO: eleven,
    SIMILAR_PCT: String(Math.round(config.creator.similarityLimit * 100)),
    LOCAL_MODELS: config.creator.localVideoModels ? ` If a scene truly needs generated footage, use the local models only: ${config.creator.localVideoModels}` : " Don't generate footage with AI models unless the plan asks for it.",
    PAID_RULE: config.creator.paidVideoApis
      ? "**Paid video-generation APIs** (Runway, Fal, Kling, Veo, ...) are allowed when a scene can't be made well otherwise; say which and why in the run note."
      : "**Paid video-generation APIs are off-limits** (Runway, Fal, Kling, Veo, ...). If the post cannot be made well without one, stop and run `node scripts/posts.mjs set KEY blocked --note \"<what you need from which API, and why>\"`. The user decides.",
    HANDPOST_RULE: HAND ? `\nDo NOT copy finals to \`${win(HAND)}\` (the user posts from it by hand; these videos post automatically, so a copy there gets posted twice).` : "",
  };
  return readFileSync("agents/creator.md", "utf8").replace(/\{\{(\w+)\}\}/g, (m, k) => fill[k] ?? m);
}

export function nextPost(only) {
  const reg = loadRegistry();
  const health = new Map(db.prepare("SELECT account, ok, paused FROM account_health").all().map((r) => [r.account, r]));
  const live = new Set(reg.accounts.filter((a) => a.enabled && (!only || a.id === only) &&
    !reg.errors.some((e) => e.startsWith(`${a.id}:`)) && !health.get(a.id)?.paused && health.get(a.id)?.ok !== 0).map((a) => a.id));
  return duePosts(7).find((r) => live.has(r.account)) ?? null;
}

if (import.meta.filename === process.argv[1]) {
  if (existsSync("STOP_AUTOMATION")) { console.log("STOP_AUTOMATION present — nothing runs."); process.exit(0); }
  if (creatorRunning()) { console.log("a creator run is already going."); process.exit(0); }
  if (db.prepare("SELECT 1 FROM week_plans WHERE status='rendered'").get()) { console.log("a video is waiting for review."); process.exit(0); }
  const p = nextPost(process.argv[2]);
  if (!p) { console.log("No planned post is due."); process.exit(0); }
  lifecycle(p.key);

  writeFileSync(LOCK, `${process.pid} ${p.key}`);
  let redo = false;
  try {
    const before = JSON.parse(db.prepare("SELECT plan_json FROM week_plans WHERE key=?").get(p.key).plan_json);
    const runs = (before.creator_runs ?? 0) + 1;
    setPost(p.key, "planned", { creator_runs: runs });
    const reg = loadRegistry();
    const account = reg.accounts.find((a) => a.id === p.account);
    const MODEL = model("creator");
    const profile = reg.projects.find((x) => x.id === account.project);
    const prompt = [`KEY=${p.key}`, `ACCOUNT=${p.account}`, `PROJECT=${account.project}`, `DAY=${p.day}`, `POST_AT=${p.post_at}`,
      `POST=${db.prepare("SELECT plan_json FROM week_plans WHERE key=?").get(p.key).plan_json}`,
      `RECENT (this brand's latest videos; yours must look clearly different from every one):\n${recentBlock(account.project)}`,
      "", agentInstructions(profile)].join("\n");
    console.log(`\n=== creator ${p.key} run ${runs} at ${new Date().toISOString()} ===`);
    const perms = config.creator.permissionMode === "bypass" ? ["--dangerously-skip-permissions"] : ["--permission-mode", "auto"];
    const r = await runAgent(["-p", "--model", MODEL, ...perms], prompt, config.creator.maxRunMinutes * 60_000);   // prompt on stdin
    const out = r.out;
    const quota = /(reached|hit) your .*limit|usage limit|session limit/i.test(out);
    const after = db.prepare("SELECT status, plan_json FROM week_plans WHERE key=?").get(p.key);
    log(p.key, "creator_run", `model=${MODEL} run=${runs} rc=${r.status} status=${after.status}${quota ? " QUOTA" : ""}`);
    console.log(out.slice(-2000));
    if (after.status === "rendered") {
      relocateFinal(p.key);
      const made = JSON.parse(db.prepare("SELECT plan_json FROM week_plans WHERE key=?").get(p.key).plan_json);
      const sim = made.video && existsSync(made.video) ? similarity(made.video, account.project) : null;
      const like = sim?.worst ? basename(sim.worst, ".mp4") : "", pct = Math.round((sim?.share ?? 0) * 100);
      log(p.key, "similarity", sim ? `${pct}% like ${like}` : "not checked");
      // The check takes about a minute: act only if nobody decided the post meanwhile.
      const now = db.prepare("SELECT status FROM week_plans WHERE key=?").get(p.key).status;
      if (now !== "rendered") log(p.key, "similarity_skipped", `post became ${now} during the check`);
      else if (sim?.near_duplicate && runs < MAX_RUNS) {
        // A new cut: answers to the copied cut's messages are refused, and it stays hidden
        // from review until the remake has been checked.
        setPost(p.key, "planned", { note: `auto-redo: ${pct}% of shots reuse ${like}`, cut: (made.cut ?? 1) + 1, reminded_at: null,
          feedback: `Too similar to ${like}: ${pct}% of your shots reuse its screens or footage. Make it visibly different: other app screens or footage, another scene, a different layout. Check RECENT.` });
        redo = true;
      } else {
        if (sim?.near_duplicate) setPost(p.key, "rendered", { note: `⚠ still ${pct}% like ${like} after ${runs} tries. ${made.note ?? ""}`.trim() });
        else if (!sim) setPost(p.key, "rendered", { note: `⚠ similarity not checked. ${made.note ?? ""}`.trim() });
        await sendForReview(p.key, "🎬 New video");
      }
    }
    // Approved (or further) before this run even exited: the user reviewed it in cc already.
    else if (["approved", "queued", "posted"].includes(after.status)) relocateFinal(p.key);
    else if (after.status === "blocked") await notify(`✋ ${p.key} is blocked: ${JSON.parse(after.plan_json).note ?? "no note"}\nReply "next" to move on to the following post.`);
    else if (quota) {
      // Not counted against the post: the limit, not the post, failed. The pulse retries later.
      setPost(p.key, "planned", { creator_runs: runs - 1 });
      writeFileSync(QUOTA, new Date().toISOString());
      await notify(`⏸ Claude usage limit hit while making ${p.key}. The pulse tries again in 2 hours.`);
    } else if (runs >= MAX_RUNS) {
      setPost(p.key, "blocked", { note: `${MAX_RUNS} creator runs ended without a video (last rc=${r.status}) — see logs/creator.log` });
      await notify(`✋ ${p.key} is blocked after ${MAX_RUNS} failed runs. Reply "next" to move on.`);
    } else await notify(`❌ ${p.key}: run ${runs} ended without a video (rc=${r.status}). The pulse retries it.`);
  } finally {
    rmSync(LOCK, { force: true });
  }
  if (redo) nextVideo();   // the remake starts now, once this run's lock is gone
}
