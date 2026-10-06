# Configuration

`npm run setup` writes all of this for you; this page is for editing it by hand. After an
edit, `npm run doctor` (everything) or `npm run registry` (profiles only) tells you whether
it holds together.

## studio.config.json

Global settings. Every field is optional: a missing one takes the default shown.
`studio.config.example.json` has the same content. Paths are relative to the repo root
unless absolute.

| Field | Default | Meaning |
|---|---|---|
| `assistant.name` | `"cc"` | What the desktop assistant calls itself, in chat and on its window. |
| `assistant.voice` | `"cc_bright"` | cc's voice: `cc_bright`, `cc_chill`, `cc_mellow` (presets in `scripts/voice.py`), any Kokoro voice id (`af_heart`, `am_michael`, ...), or a Windows voice name. cc's right-click menu overrides it per user. |
| `assistant.color` | `"charcoal"` | cc's body colour: `charcoal`, `snow`, `sky`, `mint`, `lavender`, `pink`, `peach` or `yellow`. cc's right-click menu overrides it per user. |
| `assistant.autoHideMinutes` | `3` | Minutes without you before cc hides at the screen's edge; `0` never. cc's right-click menu overrides it per user. |
| `models.creator` | `"claude-opus-5-5"` | Makes the videos. Env `CLAUDE_MODEL` overrides. |
| `models.strategist` | `"claude-opus-5-5"` | Plans the week. Env `STRATEGIST_MODEL` overrides. |
| `models.desk` | `"claude-haiku-4-5-20251001"` | cc's chat (fast). Env `DESK_MODEL` overrides. |
| `models.plan` | `"sonnet"` | The one-post planner (`npm run plan`). Env `PLAN_MODEL` overrides. |
| `paths.finals` | `"finals"` | Finished videos, as `finals/<project>/`, with `manifest.json` and `README.md`. |
| `paths.workspaces` | `"workspaces"` | Default home of each project's workspace (`workspaces/<project>/`). |
| `paths.guidelines` | `"content/GUIDELINES.md"` | How to make content, read by the strategist and the creator. |
| `paths.context` | `"content/CONTEXT.md"` | Facts per account (audience, search terms, what works). |
| `paths.python` | `"python"` | A Python 3.10+ with `opencv-python`, `numpy` and `pillow` (similarity check, avatar, video analysis). A command on PATH or a path. |
| `paths.handPost` | `null` | Optional: a folder you post videos from by hand. Pipeline videos are kept out of it (they post automatically; a copy there would be posted twice). |
| `creator.maxRunMinutes` | `90` | A creator run is stopped after this long. |
| `creator.similarityLimit` | `0.35` | A render that reuses this share of a recent video's shots goes back for a remake (up to 3 tries). |
| `creator.composition` | HyperFrames or Remotion; ffmpeg | What the creator should build videos with, in words. |
| `creator.localVideoModels` | `""` | Optional: local video-generation models on this machine and how to run them, told to the creator. Empty: no AI footage unless the plan asks for it. |
| `creator.permissionMode` | `"auto"` | How the unattended creator gets permission for each action: `"auto"` uses Claude Code's auto mode (a check approves routine work and blocks risky actions, which then fail rather than wait), `"bypass"` skips every check (`--dangerously-skip-permissions`; fastest, but nothing stands between a bad instruction and your machine). Auto mode needs a model that supports it (the default creator model does). |
| `creator.paidVideoApis` | `false` | `true` lets the creator use paid video-generation APIs; `false` marks such posts blocked so you decide. |
| `telegram.enabled` | `true` | Turn Telegram off without deleting the token. |

## .env

Secrets only; never commit it. `.env.example` lists them.

| Key | Used for |
|---|---|
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Approvals and alerts. Make a bot with @BotFather; setup finds your chat id when you message the bot. Give cc-studio its own bot (Telegram delivers a bot's updates to one program only). |
| `ELEVENLABS_API_KEY` | Voiceover, music beds and sound effects (`tools/eleven.py`). |
| `PEXELS_API_KEY`, `PIXABAY_API_KEY` | Free stock footage. Before generating a scene, the creator runs `npm run clips -- find "<scene>"`: your clip library (`library/clips/`) first, then Pexels and Pixabay, then Wikimedia Commons' public-domain clips and NASA's video library (those two need no key), downloading what fits into the library. Both keys are free; without them it still searches the library, Wikimedia Commons and NASA. When nothing fits, the creator first makes the scene another way (your photos and screens animated, motion graphics, generated footage if you allow it); only when a scene truly needs real footage does it ask you in Telegram for a clip, with search links; reply with the video, or drop files over 20 MB in `library/clips/inbox/`. |
| `IG_TOKEN_<ACCOUNT>`, `IG_USER_<ACCOUNT>` | Instagram Graph API accounts (`"platform": "instagram-api"`); the account id upper-cased, dashes as underscores. See [instagram-api-setup.md](instagram-api-setup.md). |

## apps/&lt;project&gt;/profile.json

One per brand, product or channel. `apps/example/profile.json` is a complete example.

| Field | Required | Meaning |
|---|---|---|
| `id` | | Defaults to the folder name. Used in file names and post keys. |
| `name` | | How you and cc call it. |
| `type` | | `"app"` (default: you market a product; claims and CTA are contractual) or `"channel"` (you grow a following; accuracy is enforced by prompt). |
| `positioning.one_liner`, `positioning.problem`, `positioning.audience` | | What it is, the problem it solves, who it's for. |
| `site_url`, `category`, `features` | | Context for the strategist. |
| `language_note` | yes | The language(s) to use, e.g. `"English only."` |
| `approved_claims` | yes (apps) | The only claims a video may make. Keep them true and provable. |
| `forbidden_claims` | yes | Claims a video must never make, even as a joke. |
| `cta.primary` | yes (apps) | The call to action at the end of each video. |
| `content.preferred_duration_seconds` | yes | `[min, max]` video length. |
| `content.preferred_styles` | yes | Formats to lean on, e.g. `problem_solution`, `feature_demo`, `pov_scenario`. |
| `video_workspace` | | The folder the creator builds from: real assets in `assets/`, brand rules in its `README.md` or `CLAUDE.md`. Default `workspaces/<id>`. |
| `pronounce` | | Words cc's voice says wrong, written as they should sound: `{ "Acme": "Ack-me" }`. |
| `accounts` | | The social accounts, below. |

### accounts[]

| Field | Default | Meaning |
|---|---|---|
| `id` | | Unique, e.g. `acme-tiktok`. Must not end in a date. Post keys are `<id>-YYYY-MM-DD-NNN`. |
| `name` | the project's name | What you call it ("pause Acme"). |
| `platform` | | `tiktok`, `instagram` (browser) or `instagram-api` (Graph API). |
| `handle` | | The account's handle, without @. |
| `browser_profile` | `<platform>-<project>` | The Chrome profile folder under `browser-profile/` holding this login. Never share one between brands. |
| `slots` | `["18:00"]` | Posting times, 24 h, local time. |
| `post_time` | none | One fixed daily posting time (`"17:00"`): the strategist uses it instead of picking a time from the numbers, and the 45-minute spacing rule doesn't apply. Set it from cc with "post at 5pm" (every account) or "post at 5pm for <account>"; "posting time auto" removes it. |
| `lead_days` | `0` | How far ahead uploads are scheduled (TikTok allows up to 10 days; 7 is a good value). |
| `can_schedule` | `true` | Whether the platform's scheduler is used (Instagram via browser: `false`, it posts right away). |
| `mode` | `"UPLOAD_ONLY"` | `"SCHEDULE"`: upload and schedule; `"UPLOAD_ONLY"`: upload and stop before the final button. |
| `allow_final` | `false` | With `"SCHEDULE"`, `true` lets the publisher press the final Schedule/Post button after you approved the video. |
| `enabled` | `true` | `false` keeps the account in the profile but out of planning and posting. |
| `style` | proposed | `group` (accounts planned together), `pillar` (main theme), `voice`, `formats`, `differentiator`. Missing: the strategist proposes one; accept proposals with `npm run strategist -- --accept-styles`. |

## content/

- `GUIDELINES.md`: the shared rules for planning, scripting and captioning (precedence, hard
  rules, video craft, captions, experiments, a pre-queue checklist). Ships with sensible
  defaults; make it yours.
- `CONTEXT.md`: one section per account (`## <account-id>`): audience, search terms, caption
  rules, and a "Now" block of numbers you refresh after each weekly insights run. Setup
  creates it from `CONTEXT.example.md`.
- `TEMPLATE.md`: the post package the creator writes for each video.
