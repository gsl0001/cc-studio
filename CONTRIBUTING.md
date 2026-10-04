# Contributing

Thanks for helping. A few things keep cc-studio dependable:

- **Run `npm test`** before you open a pull request (the Node self-checks, the strategist's
  tests and, on Windows, cc's speech rewrites). New logic with branches gets a small test next
  to it, in the same style: a plain `node:assert` script.
- **Keep it resumable.** Every job must survive being killed at any point: write state before
  acting, use locks with a time limit, and make re-runs harmless.
- **Never act without the human.** Nothing may post a video the user hasn't approved, raise
  posting volume, or press a platform's final button on an account that isn't set to do so.
- **No personal data in the repo.** Configuration (`studio.config.json`, `.env`,
  `apps/<project>/`, `content/CONTEXT.md`) is gitignored; examples use the fictional
  `apps/example/` project.
- **Platform adapters** live in `src/platforms/<platform>.js` and export `meta` (with
  `loginUrl`) plus the upload functions the publisher calls; see `tiktok.js`. Platforms change
  their pages often: prefer robust selectors and verify the result on the platform's own
  content list.
- **cc** (`scripts/cc.ps1`) is Windows PowerShell 5.1 and must stay ASCII-only.

Bug reports are most useful with the relevant lines from `npm run logs -- --errors` and
`npm run doctor`.
