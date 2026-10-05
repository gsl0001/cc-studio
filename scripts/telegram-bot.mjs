// The Telegram approval bot. Long-polls the bot for your answers to the videos the
// creator sends (scripts/creator.mjs) and acts on them:
//   ✅ Approve / "approve"     -> approved, queued at the planned time, next video starts
//   🔁 Redo + reply / "<text>" -> back to planned with your note as feedback, remade next
//   ⏭ Skip / "skip"           -> rejected, next video starts
//   "next"                     -> start the next video (after a blocked or failed run)
//   "status"                   -> what is waiting, blocked and queued
//   "pause" / "resume"         -> create / remove STOP_AUTOMATION
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
    if (verdict === "cc") { ccTap(q, key).catch((e) => say(`cc: ${e.message}`)); return; }
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
  if (!m?.text || String(m.chat.id) !== chatId) return;
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
