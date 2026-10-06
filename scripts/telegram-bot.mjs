// The Telegram approval bot. Long-polls the bot for your answers to the videos the
// creator sends (scripts/creator.mjs) and acts on them:
//   ✅ Approve / "approve"     -> approved, queued at the planned time, next video starts
//   🔁 Redo + reply / "<text>" -> back to planned with your note as feedback, remade next
//   ⏭ Skip / "skip"           -> rejected, next video starts
//   "next"                     -> start the next video (after a blocked or failed run)
//   "status"                   -> what is waiting, blocked and queued
//   "pause" / "resume"         -> create / remove STOP_AUTOMATION
//   a video (reply to a clip request) -> into the clip library; the post is remade with it
//   any other photo, screenshot, video -> a project's assets ("acme <what it shows>" as caption)
//   anything else              -> cc: the same chat as on the desktop (its commands and Claude),
//                                 its buttons as Telegram buttons, videos sent here
// Only messages from the configured chat count. Keep exactly one copy running: Telegram
// gives a bot's updates to one poller (409 Conflict otherwise). Answers sent while the bot
// is down wait on Telegram's side (24h) and are handled when it starts again; handling one
// twice is harmless (a decided post is left alone, the creator lock allows one run).
//
//   node scripts/telegram-bot.mjs
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { niceWhen, pause, pauseEnd } from "../src/pause.js";
import { db, log } from "../src/db.js";
import { lifecycle, note } from "../src/log.js";
import { channel, sendVideo, tg } from "../src/telegram.js";
import { decide, nextVideo as next, resolveHandoff, setPost } from "./posts.mjs";
import { fulfil, openRequests, skipRequest } from "./clips.mjs";
import { ingest, workspaces } from "./assets.mjs";
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join as pjoin } from "node:path";

const chatId = channel()?.chatId;
if (!chatId) { console.error("Telegram not configured: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env (npm run setup)"); process.exit(1); }

lifecycle();
const say = (text, extra = {}) => tg("sendMessage", { chat_id: chatId, text, ...extra }).catch((e) => { console.log(`send failed: ${e.message}`); note("warn", `send failed: ${e.message}`); });
// A dead network fails every poll; log a failure once until it changes or polling recovers.
let lastPollError = null;
// cc's desk, the same chat as on the desktop. Its buttons can't ride in callback_data (64
// bytes), so they wait here under a short id; a restart forgets them, and a stale tap says so.
const DESK = `http://127.0.0.1:${process.env.DESK_PORT || 4820}`;
const ccButtons = new Map();
let ccSeq = 0;
const remember = (what) => { const id = String(++ccSeq); ccButtons.set(id, what); if (ccButtons.size > 200) ccButtons.delete(ccButtons.keys().next().value); return id; };
async function askCc(text, fallback = null) {
  const typing = () => tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
  typing();
  const post = (path, body) => fetch(`${DESK}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) }).then((x) => x.json());
  let r = await post("/api/chat", { text, via: "telegram" }).catch(() => null);
  if (!r) return say(fallback ?? `cc's desk isn't answering right now. "status", "next", "pause" and "resume" still work here.`);
  for (let i = 0; r.id && !r.done && i < 120; i++) {   // a Claude answer streams in; wait for the whole of it
    await new Promise((ok) => setTimeout(ok, 1000));
    if (i % 4 === 3) typing();
    r = { id: r.id, ...(await fetch(`${DESK}/api/chat/poll?id=${encodeURIComponent(r.id)}`).then((x) => x.json()).catch(() => ({}))) };
  }
  if (r.video) {
    const job = db.prepare("SELECT video_path v FROM jobs WHERE key=?").get(r.video);
    const file = [job?.v, `queue/${r.video}/final.mp4`].find((f) => f && existsSync(f));
    if (file) { await sendVideo(file, r.reply || r.video, []); return; }
  }
  const rows = [];
  if (r.suggest) rows.push([{ text: r.suggest.label ?? `Do it: ${r.suggest.action}`, callback_data: `cc:${remember({ act: r.suggest })}` }, { text: "No", callback_data: "cc:no" }]);
  for (const c of (r.chips ?? []).slice(0, 8)) rows.push([{ text: c, callback_data: `cc:${remember({ say: c })}` }]);
  await say(r.reply || r.text || r.error || "(no answer)", rows.length ? { reply_markup: { inline_keyboard: rows } } : {});
}
async function ccTap(q, id) {
  await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: q.message.message_id }).catch(() => {});
  if (id === "no") return;
  const b = ccButtons.get(id);
  if (!b) return say("That button is from before a restart; ask again.");
  if (b.say) return askCc(b.say);
  const r = await fetch(`${DESK}/api/widget/act`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b.act) }).then((x) => x.json()).catch(() => null);
  return say(r ? r.message ?? r.error ?? "Done." : "cc's desk isn't answering right now.");
}
// A clip request answered (or given up on): when it was the post's last open one, the post
// goes back to the creator with a note naming the clips (or saying to make the scene another way).
function afterClip(done, skipped = false) {
  const r = done.request;
  if (!r.key || !done.lastForPost) return say(skipped ? "OK, no clip for that one." : `Got it: in the library as "${r.query}".`);
  const note = skipped ? `No clip came for "${r.query}": make that scene another way (generate it, or choose a different visual).`
    : `Use these clips from the library: ${done.clips.map((c) => `${c.file} (for: ${c.query})`).join("; ")}.`;
  const msg = decide(r.key, "redo", note, null, "Telegram");
  next();
  return say(skipped ? `OK, ${r.key} will be made without it.\n${msg}` : `Got it: in the library as "${r.query}". Remaking ${r.key} with it.\n${msg}`);
}
const TOO_BIG = 20 * 1024 * 1024;   // the most Telegram lets a bot download
async function download(fileId, name) {
  const f = await tg("getFile", { file_id: fileId });
  const r = await fetch(`https://api.telegram.org/file/bot${channel().token}/${f.file_path}`);
  if (!r.ok) throw new Error(`download ${r.status}`);
  const dir = pjoin(tmpdir(), "cc-clips"); mkdirSync(dir, { recursive: true });
  const tmp = pjoin(dir, `${name}${/\.\w+$/.exec(f.file_path)?.[0] ?? ".mp4"}`);
  writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
  return tmp;
}
async function clipArrived(m) {
  const v = m.video ?? (m.document?.mime_type?.startsWith("video/") ? m.document : null);
  if (!v) return false;
  const id = /CLIP: (\w+)/.exec(m.reply_to_message?.text ?? "")?.[1] ?? (openRequests().length === 1 && !projectIn(m.caption).project ? openRequests()[0].id : null);
  if (!id) return false;   // not for a request: an asset
  if ((v.file_size ?? 0) > TOO_BIG) { await say("That's over 20 MB, more than Telegram lets a bot download. Save it into the clip library's inbox folder on the PC instead (library/clips/inbox); it's picked up within half an hour."); return true; }
  const tmp = await download(v.file_id, id);
  const done = fulfil(id, tmp);
  rmSync(tmp, { force: true });
  if (!done) { await say("That request is already answered or closed."); return true; }
  await afterClip(done);
  return true;
}

// Photos, screenshots and videos sent here (not answering a clip request) become a project's
// assets. The caption's first word names the project ("acme settings screen, dark mode
// St"), the rest describes it; with no project named, buttons ask. An album is asked about once,
// and its caption becomes search words (Claude describes each item).
const projects = () => Object.entries(workspaces()).map(([id, w]) => ({ id, name: w.name }));
function projectIn(caption) {
  const all = projects(), m = /^\s*([\w-]+)\s*[:,-]?\s*([\s\S]*)$/.exec(caption ?? "");
  const p = m && all.find((x) => [x.id, x.name.toLowerCase()].includes(m[1].toLowerCase()));
  if (p) return { project: p.id, note: m[2].trim() || null };
  return { project: all.length === 1 ? all[0].id : null, note: caption?.trim() || null };
}
function mediaIn(m) {
  const d = m.photo?.at(-1) ?? m.video ?? (/^(image|video)\//.test(m.document?.mime_type ?? "") ? m.document : null);
  return d ? { fileId: d.file_id, size: d.file_size ?? 0, msg: m.message_id } : null;
}
const albums = new Map();   // media_group_id -> { files, caption }: an album arrives one message per item
async function assetArrived(m) {
  const media = mediaIn(m);
  if (!media) return false;
  const gid = m.media_group_id;
  if (gid && albums.has(gid)) { const a = albums.get(gid); a.files.push(media); a.caption ??= m.caption; return true; }
  const batch = { files: [media], caption: m.caption ?? null };
  if (!gid) { await takeAssets(batch); return true; }
  albums.set(gid, batch);
  setTimeout(() => { albums.delete(gid); takeAssets(batch).catch((e) => say(`Couldn't add those: ${e.message}`)); }, 2500);
  return true;
}
async function takeAssets(batch, project = projectIn(batch.caption).project) {
  if (!project) {
    const id = remember({ assets: batch }), n = batch.files.length;
    return say(`Which project ${n > 1 ? `are these ${n}` : "is this"} for?`, { reply_markup: { inline_keyboard: [projects().map((p) => ({ text: p.name, callback_data: `asset:${id}:${p.id}` }))] } });
  }
  const note = projectIn(batch.caption).note, single = batch.files.length === 1, lines = [];
  for (const f of batch.files) {
    if (f.size > TOO_BIG) { lines.push("One is over 20 MB, more than Telegram lets a bot download: put it in the project's assets folder on the PC (cc picks it up on its next scan, or say \"scan assets\")."); continue; }
    const tmp = await download(f.fileId, `tg-${f.msg}`);
    try {
      const r = ingest(project, tmp, `tg-${f.msg}${extname(tmp)}`, single ? { description: note } : { tags: note });
      lines.push(!r ? "One was skipped: too small, or it looks like a finished video."
        : r.dup ? `Already had that one (${r.entry.rel})${single && note ? "; its description is now yours" : ""}.`
        : `Added ${r.entry.rel}${r.entry.duration ? ` (${r.entry.duration}s)` : ""}.`);
    } finally { rmSync(tmp, { force: true }); }
  }
  // Claude describes what has no caption, splits videos into stretches and redoes the contact sheets.
  const out = openSync("logs/assets.log", "a");
  spawn(process.execPath, ["scripts/assets.mjs", "scan", "--project", project], { detached: true, windowsHide: true, stdio: ["ignore", out, out] }).unref();
  const name = projects().find((p) => p.id === project)?.name ?? project;
  return say(`${name}'s assets: ${lines.join(" ")}\n${single && note ? "Your caption is its description." : "Claude describes them in a few minutes."} The creator can use ${single ? "it" : "them"} from the next video.`
    + (openRequests().length ? "\n(If this was for a clip request, send it as a reply to that request.)" : ""));
}
const keyIn = (text) => /KEY: (\S+)/.exec(text ?? "")?.[1] ?? null;
const cutIn = (text) => /CUT: (\d+)/.exec(text ?? "")?.[1] ?? null;

function status() {
  const rows = db.prepare("SELECT key, status, day, post_at FROM week_plans WHERE status IN ('rendered','blocked','approved','queued') ORDER BY day, post_at").all();
  const planned = db.prepare("SELECT count(*) n FROM week_plans WHERE status='planned' AND day >= date('now','localtime')").get().n;
  return [rows.length ? rows.map((r) => `${r.status.padEnd(8)} ${r.day} ${r.post_at} ${r.key}`).join("\n") : "Nothing waiting, blocked or queued.",
    `${planned} planned post(s) still to make.`].join("\n");
}

async function handle(u) {
  if (u.callback_query) {
    const q = u.callback_query;
    if (String(q.message?.chat?.id) !== chatId) return;
    const [verdict, key, cut = null] = q.data.split(":");
    await tg("answerCallbackQuery", { callback_query_id: q.id }).catch(() => {});
    if (verdict === "clipskip") {
      await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: q.message.message_id }).catch(() => {});
      const done = skipRequest(key);
      return done ? afterClip(done, true) : say("That request is already answered or closed.");
    }
    if (verdict === "cc") { ccTap(q, key).catch((e) => say(`cc: ${e.message}`)); return; }
    if (verdict === "asset") {
      await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: q.message.message_id }).catch(() => {});
      const b = ccButtons.get(key);
      return b?.assets ? takeAssets(b.assets, cut) : say("That button is from before a restart; send the files again.");
    }
    if (verdict === "posted" || verdict === "retry") {
      await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: q.message.message_id }).catch(() => {});
      return say(resolveHandoff(key, verdict));
    }
    if (verdict === "redo") {
      await say(`What should change in ${key}? Reply to this message.\nKEY: ${key}${cut ? ` CUT: ${cut}` : ""}`, { reply_markup: { force_reply: true } });
      return;
    }
    const feedback = verdict === "redonote" ? JSON.parse(db.prepare("SELECT plan_json FROM week_plans WHERE key=?").get(key)?.plan_json ?? "{}").pending_feedback ?? "" : "";
    await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: q.message.message_id }).catch(() => {});
    await say(decide(key, verdict === "redonote" ? "redo" : verdict, feedback, cut));
    next();
    return;
  }
  const m = u.message;
  if (!m || String(m.chat.id) !== chatId) return;
  if (await clipArrived(m)) return;
  if (await assetArrived(m)) return;
  if (!m.text) return;
  const text = m.text.trim();
  const word = text.toLowerCase();
  if (word === "status") { askCc("status", status()).catch(() => say(status())); return; }
  if (word === "next") { next(); return say("Starting the next video."); }
  // The kill switch every script already honours (tick, pulse, creator, insights).
  if (word === "pause") { writeFileSync("STOP_AUTOMATION", `paused from Telegram ${new Date().toISOString()}\n`); return say("⏸ Paused: nothing renders or publishes until you send \"resume\". A render already running finishes; approvals still go into the queue."); }
  const timed = /^pause\s+(.+)$/.exec(word), until = timed && pauseEnd(timed[1]);
  if (until) { pause("Telegram", until); return say(`⏸ Paused until ${niceWhen(until)}. Then everything starts again on its own, and I'll tell you here. Send "resume" to end it sooner.`); }
  if (word === "resume") { rmSync("STOP_AUTOMATION", { force: true }); next(); return say("▶️ Resumed."); }
  const replied = m.reply_to_message?.caption ?? m.reply_to_message?.text;
  const key = keyIn(replied);
  const cut = cutIn(replied);
  if (!key) { askCc(text).catch((e) => say(`cc: ${e.message}`)); return; }
  const verdict = /^(approve|approved|yes|ok|👍|✅)$/i.test(text) ? "approve" : /^(skip|no)$/i.test(text) ? "skip" : null;
  // Free text is a redo only when it answers "What should change"; on the video itself it
  // could be praise, so ask first.
  if (!verdict && !/^What should change/.test(m.reply_to_message?.text ?? "")) {
    const row = db.prepare("SELECT status FROM week_plans WHERE key=?").get(key);
    if (row) setPost(key, row.status, { pending_feedback: text });
    return say(`Remake ${key} with this note?\n"${text}"`, { reply_markup: { inline_keyboard: [[
      { text: "🔁 Redo with this note", callback_data: `redonote:${key}${cut ? `:${cut}` : ""}` },
      { text: "✅ Approve as is", callback_data: `approve:${key}${cut ? `:${cut}` : ""}` }]] } });
  }
  await say(decide(key, verdict ?? "redo", text, cut));
  next();
}

let offset = 0;
console.log(`approval bot polling for chat ${chatId}`);
log(null, "telegram_bot_start", `pid=${process.pid}`);
for (;;) {
  // The pulse restarts the bot when this goes stale (a closed window killed it once).
  writeFileSync("logs/.bot-heartbeat", new Date().toISOString());
  try {
    const updates = await tg("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "callback_query"] });
    if (lastPollError) { note("info", "polling recovered"); lastPollError = null; }
    for (const u of updates) {
      offset = u.update_id + 1;
      await handle(u).catch((e) => { console.log(`update ${u.update_id}: ${e.message}`); log(null, "telegram_bot_error", e.message.slice(0, 300)); });
    }
  } catch (e) {
    console.log(`poll failed: ${e.message}`);
    if (e.message !== lastPollError) { note("warn", `poll failed: ${e.message}`); lastPollError = e.message; }
    // 409: another poller holds this bot. Back off instead of fighting it.
    await new Promise((r) => setTimeout(r, e.status === 409 ? 60_000 : 5_000));
  }
}
