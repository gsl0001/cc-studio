---
account: <account-id, e.g. mybrand-tiktok>
day: <YYYY-MM-DD>
post_at: <HH:MM, your local time>
format: <video | carousel>
pillar: <e.g. job-site habit, feature demo, story>
experiment_arm: <control | variant | none>
is_aigc: <true | false>  # proposal; applied when the user approves the video
status: draft            # draft -> approved (user) -> produced -> posted
job_key:                 # filled at hand-off, e.g. mybrand-tiktok-2026-10-06-001
final_path:              # filled at hand-off
---

# <working title>

## Hooks
| # | Type (GUIDELINES §2) | On-screen text (≤10 words) |
|---|---|---|
| 1 | | |
| 2 | | |
| 3 | | |

**Chosen:** # because <data from CONTEXT.md, the brief or research>.

**Frame 0:** <what is on screen and already moving at 0.0s; when the product appears>

## Script (video)
| Start–end (s) | Visual | Voiceover | On-screen text |
|---|---|---|---|
| 0–1.5 | | | |

Duration: <s> · Words: <n> (about 2.5 words per second)

## Slides (carousel, 7–9)
| # | Image | Headline | One-line explanation |
|---|---|---|---|
| 1 | problem image | hook | |

Alt text: <up to 300 characters>

## Caption
<first line: search phrase + payoff>
<body>
<project disclosure line, if any>

Hashtags: <3–5> · Search keywords: <2–4, from CONTEXT.md search terms>
CTA: <the profile's CTA, last> · Sound: <original voiceover | a licensed track>

## Rationale
<the data, post or research finding behind this; what the experiment tests>

## Backups
1. Hook: … · Angle: … · Caption: …
2. Hook: … · Angle: … · Caption: …

## Checklist (GUIDELINES §6)
- [ ] Frame 0: hook text and a moving real scene, with no logo or title card
- [ ] The hook's question is answered and the product's role is explicit
- [ ] Every claim is in approved_claims, with no forbidden claims
- [ ] The duration is in range and the voice fits it
- [ ] Render checks (1080x1920, audio, >100KB, frames looked at): at render
- [ ] No stray UI, private details, or chopped or misspelled text
- [ ] The caption leads with a search phrase, has 3–5 hashtags and the disclosure line
- [ ] Not a sibling account's post; not a recent hook reworded
- [ ] One CTA, at the end, with no engagement bait
