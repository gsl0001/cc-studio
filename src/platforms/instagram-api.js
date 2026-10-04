// Instagram publishing via the official Graph API (Instagram Login flavour) —
// no browser, no DOM, free for accounts you own. Declare an account with
// "platform": "instagram-api" and put credentials in .env:
//
//   IG_TOKEN_<ACCOUNT_ID>=<long-lived access token>     (dashes -> underscores, uppercase)
//   IG_USER_<ACCOUNT_ID>=<ig user id>
//
// Flow (docs: developers.facebook.com/docs/instagram-platform/content-publishing):
//   1. POST /{ig-user-id}/media  media_type=REELS upload_type=resumable -> container
//   2. binary upload to rupload.facebook.com/ig-api-upload/{ver}/{container-id}
//   3. poll /{container-id}?fields=status_code until FINISHED (400 if published early)
//   4. POST /{ig-user-id}/media_publish -> media id, then read the permalink
//
// The API cannot schedule — the tick releases the job at slot time and this
// posts immediately, same as the account's existing post-now behaviour.
import { readFileSync } from "node:fs";

try { process.loadEnvFile(".env"); } catch { /* no .env yet */ }

export const api = true;
export const meta = { contentListName: "Instagram (Graph API)" };

const VER = process.env.IG_API_VERSION || "v23.0";
const BASE = process.env.IG_GRAPH_BASE || "https://graph.instagram.com";

export function credsFor(account) {
  const slug = account.id.replace(/-/g, "_").toUpperCase();
  const token = process.env[`IG_TOKEN_${slug}`];
  const igUser = process.env[`IG_USER_${slug}`];
  if (!token || !igUser) {
    throw new Error(`missing IG_TOKEN_${slug} / IG_USER_${slug} in .env — see docs/instagram-api-setup.md`);
  }
  return { token, igUser };
}

async function call(url, { method = "GET", body = null, headers = {} } = {}) {
  const res = await fetch(url, { method, body, headers });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    throw new Error(`${method} ${url.split("?")[0]}: ${json.error?.message ?? res.status}`);
  }
  return json;
}

export async function publishApi(job) {
  const { account, video, caption } = job;
  const { token, igUser } = credsFor(account);
  const auth = `access_token=${encodeURIComponent(token)}`;

  // 1. container
  const container = await call(
    `${BASE}/${VER}/${igUser}/media?media_type=REELS&upload_type=resumable&caption=${encodeURIComponent(caption)}&${auth}`,
    { method: "POST" });
  job.log("ig_container_created", container.id);

  // 2. binary upload
  const data = readFileSync(video);
  await call(`https://rupload.facebook.com/ig-api-upload/${VER}/${container.id}`, {
    method: "POST",
    body: data,
    headers: {
      Authorization: `OAuth ${token}`,
      offset: "0",
      file_size: String(data.length),
      "Content-Type": "application/octet-stream",
    },
  });
  job.log("ig_video_uploaded", `${data.length} bytes`);

  // 3. wait for processing — publishing early 400s. Docs say poll ≤1/min, max 5min.
  let status = null;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 30_000));
    status = (await call(`${BASE}/${VER}/${container.id}?fields=status_code&${auth}`)).status_code;
    job.log("ig_container_status", status);
    if (status === "FINISHED") break;
    if (status === "ERROR" || status === "EXPIRED") throw new Error(`container ${status}`);
  }
  if (status !== "FINISHED") throw new Error(`container still ${status} after 5min`);

  // 4. publish + verify via permalink
  const published = await call(`${BASE}/${VER}/${igUser}/media_publish?creation_id=${container.id}&${auth}`,
    { method: "POST" });
  const info = await call(`${BASE}/${VER}/${published.id}?fields=permalink&${auth}`).catch(() => null);
  job.log("ig_published", info?.permalink ?? published.id);
  return { mediaId: published.id, permalink: info?.permalink ?? null };
}

// Read-only credential check for authcheck: token valid + matches the ig user.
export async function checkApi(account) {
  const { token, igUser } = credsFor(account);
  const me = await call(`${BASE}/${VER}/me?fields=user_id,username&access_token=${encodeURIComponent(token)}`);
  if (String(me.user_id ?? me.id) !== String(igUser)) {
    return { ok: 0, note: `token belongs to ${me.username ?? me.user_id}, not IG user ${igUser}` };
  }
  return { ok: 1, note: `api ok (@${me.username})` };
}
