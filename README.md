# cc-studio

**An open-source content assistant for short-form video.** cc-studio plans your week of
TikTok and Instagram posts from your own analytics and current trends, makes each video
with Claude, sends it to you for a yes or no, and schedules the approved ones on the
platforms. **cc**, a small desktop companion, keeps you in the loop: it shows what the
pipeline is doing, talks with you, and takes your commands.

![cc's states](docs/images/cc-states.png)

Nothing is posted without your approval. You decide the claims a video may make, the
accounts it may post to, and whether it posts automatically or waits for you to press Post.

## What it does

| Stage | What happens |
|---|---|
| **Research and plan** (weekly) | Reads each account's own TikTok Studio numbers, your competitors' recent posts and current trends, then plans next week: a hook, script, caption, hashtags, posting time and a distinct visual idea per post, plus one experiment per account. |
| **Make** (one video at a time) | Claude builds each planned post into a finished 1080x1920 video from your real product screens and footage (HyperFrames, Remotion or ffmpeg), with an ElevenLabs voiceover and music bed, checks its own frames, and keeps it visibly different from your recent videos (frame-level similarity check). |
| **Approve** | The video comes to you in Telegram or in cc's chat: Approve, Redo (with your note) or Skip. |
| **Schedule and publish** | Approved videos go through TikTok Studio's own scheduler, up to 7 days ahead, using your real Chrome and your own login. Instagram is supported through the browser or the official Graph API. |
| **Learn** | Metrics are collected weekly and fed into the next plan; every part of the system writes one log you can read with `npm run logs` or by asking cc. |

**cc** (Windows) is an always-on-top character whose "pony" shows the pipeline's state by
its colour and pose. Click it to chat; it answers with Claude from the live state, speaks
in an offline voice, follows your cursor, has a Controls card for every action (make the
next video, pause an account, publish now, open any folder), and hides at the screen's edge
when you don't need it.

| Voice and sound | Hiding at the edge |
|---|---|
| ![cc talking](docs/images/cc-voice.png) | ![cc peeking](docs/images/cc-peek.png) |

## Requirements

- **Windows 10 or 11** for the full experience (cc and the Task Scheduler jobs). The Node
  pipeline also runs on macOS and Linux with cron (`npm run tasks:install` prints the lines).
- **Node.js 22.5+**, **Google Chrome**, **FFmpeg** on PATH, **Python 3.10+**.
- **[Claude Code](https://claude.com/claude-code)**, installed and logged in: the strategist,
  the creator and cc's chat run on it (a Claude subscription or API key).
- Optional: an **ElevenLabs** API key (voiceover, music, sound effects) and a **Telegram**
  bot (approvals on your phone).

## Quick start

```bash
git clone https://github.com/<you>/cc-studio.git
cd cc-studio
npm install
npm run setup
```

The setup wizard asks about your projects (brand, what videos may and may never claim, the
call to action) and their accounts (platform, handle, posting times, automatic or manual),
connects Telegram and ElevenLabs if you want them, and then offers to:

1. log in to each account (a Chrome window opens; you log in by hand, nothing is typed for you),
2. build cc's avatar and install its offline voice,
3. register the scheduled jobs,
4. run a health check (`npm run doctor`).

Then put real material in your project's workspace (`workspaces/<project>/assets`: logos,
screenshots, screen recordings, photos) and fill in `content/CONTEXT.md` (audience, search
terms). The strategist plans next week on Saturday evening, or now with `npm run strategist`.

## Everyday use

- **cc:** click it to open the chat. Plain commands answer at once: `status`, `what's next`,
  `this week`, `errors`, `approve`, `skip`, `redo: <what to change>`, `next`,
  `next <account>`, `publish now`, `check logins`, `pause` / `resume` (everything or one
  account), `folders`, `open <folder>`, `mute`, `size small`, `hide`. Anything else goes to
  Claude. `help` shows them all as buttons. Right-click cc for its menu (voice, colour,
  size, auto-hide).
- **Telegram:** each new video arrives with Approve / Redo / Skip buttons; `pause`,
  `resume`, `next` and `status` work there too.
- **Terminal:** `npm run status` (jobs), `npm run logs -- --errors` (problems),
  `npm run doctor` (health), `npm run registry` (check your profiles).

## How it fits together

```
weekly insights ──► strategist ──► week plan (planned posts)
                                         │
              pulse (every 30 min) ──► creator (Claude, one video) ──► similarity check
                                         │
                       you: Approve / Redo / Skip (Telegram or cc)
                                         │
              tick (every 30 min) ──► publisher (Playwright, TikTok Studio scheduler)
```

See [docs/architecture.md](docs/architecture.md) for the stages, statuses, files and logs,
and [docs/configuration.md](docs/configuration.md) for every setting.

## Configuration in one minute

| File | What it holds | Written by |
|---|---|---|
| `studio.config.json` | models, folders, creator rules, cc settings | `npm run setup` |
| `.env` | secrets: Telegram, ElevenLabs, Instagram API tokens | `npm run setup` |
| `apps/<project>/profile.json` | one brand: claims, CTA, durations, accounts, posting times, styles | `npm run setup`, then you |
| `content/GUIDELINES.md` | how to make content (shared defaults; make them yours) | ships |
| `content/CONTEXT.md` | facts per account: audience, search terms, what works | you |
| `workspaces/<project>/` | real material for videos, and each video's working folder | you and the creator |

## Responsible use

cc-studio automates your own accounts through your own logged-in browser. Platforms' terms
of service limit automation, and they change: you are responsible for how you use this
tool on your accounts. It is built to stay on the right side of that: a human approves every
video, posting volume is fixed by you, the AI-content label follows what was actually made,
and it never buys engagement, follows for follows, or posts unlicensed music. See
[SECURITY.md](SECURITY.md) for how secrets and logins are handled.

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Run
`npm test` before you open a pull request.

## License

[MIT](LICENSE)
