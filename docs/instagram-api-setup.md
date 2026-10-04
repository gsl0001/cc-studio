# Instagram Graph API setup (one-time, ~15 minutes, free)

Switches an Instagram account from the Playwright browser flow to the official
API. For accounts you own, in a dev-mode app, no Meta app review is needed.
Limit ~25 API posts/account/day (we use 1–2). The API cannot schedule — the
account keeps its post-now behaviour (tick releases at slot time).

## Steps (human — logins involved)

1. **Meta developer account**: https://developers.facebook.com → log in with
   any Facebook account → create a developer account if asked.
2. **Create an app**: My Apps → Create App → use case **"Instagram"** →
   type Business. Name it e.g. `auto-bot-publisher`.
3. **Instagram API with Instagram Login**: in the app dashboard, add the
   product "Instagram" and choose **API setup with Instagram login**
   (this flavour needs NO Facebook Page).
4. **The IG account must be Professional** (Business or Creator — free, in the
   app: Settings → Account type). 
5. **Add the IG account as a tester**: App dashboard → Instagram → API setup →
   "Add account" → log in as the IG account and authorize. Dev-mode apps can
   publish for accounts with a role on the app — this is the no-review path.
6. **Generate a long-lived access token**: same screen → "Generate token" for
   the linked account. Copy the token AND the Instagram user ID shown.
   (Long-lived tokens last ~60 days; refresh with
   `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=<token>`
   — the authcheck failing with an expired token is the reminder.)
7. **Put credentials in `.env`** at the repo root (gitignored; account id with
   dashes → underscores, uppercase):

   ```
   IG_TOKEN_MYBRAND_INSTAGRAM=IGQW...
   IG_USER_MYBRAND_INSTAGRAM=1784...
   ```

8. **Flip the account's platform** in `apps/<project>/profile.json`:
   `"platform": "instagram-api"` (was `"instagram"`). Then:

   ```
   npm run registry
   npm run check -- mybrand-instagram
   ```

   The check calls `/me` with the token and verifies it matches the user id —
   `api ok (@handle)` means done. The next tick publishes via the API.

## Rollback

Set `"platform": "instagram"` back — the browser profile and old adapter are
untouched.
