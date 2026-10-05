// Telegram pings and the approval bot: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env
// (npm run setup finds the chat id). Give cc-studio a bot of its own: Telegram hands a bot's
// updates to one poller only. No config (or telegram.enabled false) -> no-op.
// notify() never throws: a Telegram outage must not fail the run that is reporting.
import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { config } from "./config.js";

export function channel() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim(), chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  return config.telegram.enabled && token && chatId ? { token, chatId } : null;
}

// Returns true when Telegram accepted the message (and the file, if one was given).
export async function notify(text, file = null) {
  const tg = channel();
  if (!tg) { console.log("Telegram not configured — no ping."); return false; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: tg.chatId, text }),
    });
    if (!r.ok) throw new Error(`sendMessage ${r.status}`);
    if (file) {
      const form = new FormData();
      form.append("chat_id", tg.chatId);
      form.append("caption", "Full report — open in a browser");
      form.append("document", new Blob([readFileSync(file)], { type: "text/html" }), basename(file));
      const d = await fetch(`https://api.telegram.org/bot${tg.token}/sendDocument`, { method: "POST", body: form });
      if (!d.ok) throw new Error(`sendDocument ${d.status}`);
    }
    return true;
  } catch (e) {
    console.log(`telegram failed: ${e.message}`);
    return false;
  }
}

// Bot API call for the approval bot. Unlike notify(), this throws: the bot retries.
export async function tg(method, body = {}) {
  const c = channel();
  if (!c) throw new Error("Telegram not configured");
  const r = await fetch(`https://api.telegram.org/bot${c.token}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw Object.assign(new Error(`${method} ${r.status}: ${j.description ?? ""}`), { status: r.status });
  return j.result;
}

// A finished video with buttons. Bots may upload at most 50 MB; above that the cover goes instead.
export async function sendVideo(file, caption, buttons, cover = null) {
  const c = channel();
  if (!c) { console.log("Telegram not configured — no video sent."); return null; }
  try {
    const big = statSync(file).size > 49 * 1024 * 1024;
    const form = new FormData();
    form.append("chat_id", c.chatId);
    form.append("caption", caption.slice(0, 1024));
    if (buttons?.length) form.append("reply_markup", JSON.stringify({ inline_keyboard: [buttons] }));
    if (big && cover) form.append("photo", new Blob([readFileSync(cover)], { type: "image/jpeg" }), basename(cover));
    else form.append("video", new Blob([readFileSync(file)], { type: "video/mp4" }), basename(file));
    if (!big) {
      form.append("supports_streaming", "true");
      // Without dimensions Telegram clients preview a 9:16 upload as square or landscape.
      try {
        const [w, h, d] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
          "stream=width,height:format=duration", "-of", "csv=p=0:s=,", file]).toString().split(/[,\r\n]+/);
        form.append("width", w); form.append("height", h); form.append("duration", String(Math.round(Number(d))));
      } catch {}
      if (cover) form.append("thumbnail", new Blob([readFileSync(cover)], { type: "image/jpeg" }), basename(cover));
    }
    const r = await fetch(`https://api.telegram.org/bot${c.token}/${big && cover ? "sendPhoto" : "sendVideo"}`, { method: "POST", body: form });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`sendVideo ${r.status}: ${j.description ?? ""}`);
    return j.result;
  } catch (e) {
    console.log(`telegram failed: ${e.message}`);
    return null;
  }
}
