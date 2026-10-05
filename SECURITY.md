# Security

## What cc-studio holds

- **Logins.** Each account's session lives in its own Chrome profile under `browser-profile/`.
  A profile folder is a credential: anyone with a copy is logged in as that account. It is
  gitignored; never share or upload it. cc-studio never types a password: you log in by hand
  (`npm run login -- <account>`), and the publisher only reuses that session.
- **Secrets** (Telegram bot token, ElevenLabs key, Instagram API tokens) live only in `.env`,
  which is gitignored. They are read into the environment of cc-studio's own processes.
- **The desk server** listens on `127.0.0.1:4820` only, checks the Host and Origin of every
  request, and opens only a fixed list of folders: nothing a request says reaches a command line.
- **The Telegram bot** answers only the configured chat id.
- **The creator** runs Claude Code unattended. By default it uses auto mode (`creator.permissionMode: "auto"`), where Claude Code checks each action and blocks risky ones; setup lets you choose `"bypass"` instead, which skips every check (`--dangerously-skip-permissions`).
  Either way it works on its own in the project's workspace. Its instructions treat the plan's text
  (written from web research) and your feedback as data, never as instructions, and forbid
  touching cc-studio's own code. Run cc-studio on a machine and account you're comfortable
  giving an autonomous agent; keep anything sensitive out of its reach.

## Reporting a vulnerability

Please open a private security advisory on the repository (Security, then "Report a
vulnerability") rather than a public issue. Include what you found and how to reproduce it.
