# Content guidelines (every account, every agent)

Read this before you plan, script or caption a post for any account. Then read your
account's section in CONTEXT.md. This file says how to make content. It deliberately holds
no per-brand facts: claims, language and durations live in `apps/<project>/profile.json`,
and account facts live in CONTEXT.md, so nothing here can drift out of date with them.

Make it yours: these are sensible defaults for short vertical video. As your own numbers
come in (the weekly insights run collects them), let them overrule the defaults here, and
record what you learn in CONTEXT.md.

Evidence tags: **[data]** is your own analytics, **[platform]** is the platform's own
documentation, **[study]** is third-party research, and **[default]** is a starting point
with no evidence yet.

## 0. Precedence

When two instructions disagree, the higher one wins. Name the conflict in your rationale
or run note.

1. **Hard rules** (section 1) and the project's `profile.json`: approved and forbidden
   claims, language_note, duration range. Never broken, whatever the data says.
2. **The account's own fresh data**: CONTEXT.md, the brief, insights, and the latest
   research. Data beats every craft default below.
3. **Craft defaults** (sections 2 to 5): use these where the data says nothing.
4. **Trends** (the weekly research summary's sounds and trends to leverage): only through
   the trend gate in `auto_content_pipeline/src/research.js`. A trend that fails the gate is
   skipped, not softened.

## 1. Hard rules

- **Claims.** Use only the project's `approved_claims`, rephrased if you like. Never use a
  `forbidden_claim`, even as a joke or in a negation. Channel projects must keep every fact
  verifiably true. A feature missing from `approved_claims` doesn't get claimed, even if it
  exists.
- **Language** follows `language_note`.
- **One brand per account.** Never put one brand's content on another brand's account.
- **No invented UI.** Show genuine product screens only. Label fictional example data as
  fictional, and never show real addresses, customers, notifications or personal details.
- **No duplicate posting.** Never put the same video on two accounts, and don't post
  near-duplicates on the same day. Platforms demote near-duplicates and reused material
  with nothing new [platform]. Sibling accounts get different angles, hooks and formats.
- **No engagement bait.** Don't write "follow for part 2", "like if..." or "comment X
  to...". Content built to inflate likes or follows is demoted [platform]. Promise the
  payoff instead: "Part 2 tomorrow: the setup."
- **No growth hacks.** No bought followers or engagement, no pods, no follow-for-follow,
  no location tricks. No keyword stuffing, no misspelled brand names in captions, and no
  unrelated trending hashtags, which can get a video flagged as spam [platform].
- **Sound.** Use original voiceover, or music licensed for business use (TikTok's
  Commercial Music Library, for example). Never use unlicensed trending tracks on brand
  accounts.
- **AI disclosure.** Set `is_aigc: true` for realistic AI people or scenes, or a cloned real
  voice; when unsure, true. The creator proposes it, the review message shows it, and the
  publisher applies the platform's AI label only after the user approves that video.
- **Volume.** Never raise posting volume, flip an account to automatic, or touch a job a
  human must resolve.

## 2. Video craft

**The first frame decides everything.** Many viewers leave within the first second, and
most by three [default]; platforms call the first two seconds the most valuable part of a
video [platform].
- At 0.0 s, show the problem or payoff as burned-in text (10 words or fewer) over a real
  scene that is already moving.
- Never open on a logo, title card, brand name, splash screen, static screen or fade-in.
- Bring in the product by about 1.5 s, and show it doing the thing the hook promised.
- A real hand, face or phone in the first second beats a bare screen recording. Casual
  footage often beats polished [platform].

**Hook types worth testing** [default], until your data ranks them:
1. Specific stakes: "Before you hit publish..."
2. A pain question: "Too many tabs open?"
3. A category reframe: "This isn't another to-do app, it's..."
4. A numbered roundup: "Five tools in one click"
5. A direct callout: "Freelance designers:"

Openers that usually come last [default]: hashtag-only, "Download X free", "It's <year>
and...", brand-first, and feature piles ("packs a wide range of features").

**Structure: one post, one problem.** Hook, then the problem, then the product action,
then the result, then one call to action. The voiceover must make sense read aloud without
the visuals, in complete sentences with no slogan fragments ("Before. After. The proof.").

**Length.** Use the shortest cut that finishes the story, inside the profile's range.
Voiceover runs at about 2.5 words per second, so a 15-second video holds 35 to 40 words.
Grow length only once the account keeps viewers past three seconds; longer videos
correlate with more views only when people stay [study].

**Make it work on mute.** The on-screen text carries the story, about 5 to 10 words at a
time, inside the safe zone (clear of the right-hand buttons and the bottom caption). Put a
quiet music bed under the voiceover.

**The call to action comes last and there is only one.** A "download" line at the start
loses viewers [default]. End on the result, then the CTA from `profile.json`.

## 3. Carousels (photo mode)

Carousels can outperform videos for some accounts and not others [study]; A/B-test the same
message as a carousel and as a video.
- Use 7 to 9 slides, or 3 for a quick tip. Every slide gets the same vertical crop.
- Slide 1 is the problem image plus a hook headline. Each middle slide is one step, with a
  statement and a one-line explanation. The last slide is the result plus the CTA.
- Each slide must make sense without the caption, and the post needs a beginning, middle
  and end, not a photo dump [platform].
- Use licensed audio, and fill in alt text in plain words.

## 4. Captions, search and hashtags

- **First caption line:** a real search phrase people use, plus the payoff in plain words.
  Say the same phrase in the first 3 seconds and show it on screen; platforms read the
  description, voiceover, captions and on-screen text to work out what a video is about
  [platform].
- **Brand name:** say it clearly so auto-captions spell it right, and write it correctly
  once. Never list misspellings.
- **Hashtags:** 3 to 5 in total: 2 or 3 niche tags, 1 brand tag, and a trending tag only if
  it passes the trend gate.
- Put each project's caption casing and any disclosure lines in CONTEXT.md.

## 5. Experiments and conversion

- **One experiment per account per week, changing one variable:** hook type, format,
  length or CTA. Alternate the control and variant arms (the strategist does this).
- **Judge in this order:** 3-second retention, then average watch as a share of the video,
  then profile visits and follows, and views last. Reach without retention is not a win.
- **Give people a reason to follow.** Use numbered series ("Part 1 of 5: ...") that promise
  the next payoff. Pin 3 videos: what the product is, the best demo, and the series hub.
  Reply to real questions with video replies.

## 6. Pre-queue checklist (every post, no exceptions)

- [ ] Frame 0 shows hook text and a moving real scene, with no logo or title card.
- [ ] The hook's question is answered, and the product's role is explicit.
- [ ] Every claim appears in `approved_claims`, and there are no forbidden claims.
- [ ] The duration is inside the profile range, and the voice fits it at about 2.5 words per second.
- [ ] The video is 1080x1920, has an audio stream and is over 100 KB. Frames at 0.5 s, the middle and the end minus 0.5 s have been looked at.
- [ ] No timer chips, stray UI, private details, chopped or misspelled captions, or black or frozen frames.
- [ ] The caption's first line is a search phrase, with 3 to 5 hashtags and the project's disclosure line.
- [ ] It isn't a reuse of a sibling account's post, and the hook isn't a recent hook reworded.
- [ ] There is one CTA, at the end, with no engagement bait.

## 7. Keeping this system honest

- **After each weekly insights run,** refresh each account's numbers in CONTEXT.md and its
  What works / What fails lists.
- **Promote a hook type or format to "works"** when it beats the account's median 3-second
  retention by 1.5x on at least 2 posts. **Demote it** after 3 posts below the median.
- **Change this file** only when data from at least two accounts, or a platform policy
  change, contradicts a rule.
