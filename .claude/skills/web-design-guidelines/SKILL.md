---
name: web-design-guidelines
description: Review UI code against Vercel's Web Interface Guidelines — accessibility, focus states, forms, keyboard handling, responsive behaviour, typography, animation, performance and content. Use when asked to review an interface, check accessibility, audit a screen, or verify a component against web best practices. Reads a pinned copy of the guidelines from this repository; it never fetches them from the network.
---

# Web Interface Guidelines (pinned)

An objective review pass over UI code. It is deliberately not an art-direction
skill: it says what is wrong, not what would be beautiful.

## How to run a review

1. Read `guidelines.md` next to this file. That file is the whole rule set.
2. Read the files the user named. With no files named, ask which ones; do not
   guess a surface.
3. Check every rule that applies to what you read. A rule that cannot apply to
   the file at hand is skipped silently.
4. Report findings as `file:line — rule — what to change`, most severe first,
   and say plainly when a file has none.

Report only what the code shows. A rule about a rendered result (contrast on a
real background, motion at real durations) needs the running application, so
either look at it or mark the finding as unverified.

## Why the rules are pinned here

The upstream skill fetches its rules from the `main` branch of
`vercel-labs/web-interface-guidelines` on every run, so what an agent checks
against could change between two reviews without anybody deciding it. The copy
in `guidelines.md` is that same file at a reviewed commit:

- Source: `https://github.com/vercel-labs/web-interface-guidelines/blob/main/command.md`
- Pinned commit: `e3d624baaf29dc1fc645aff3e38f03e564d2d6b1` (2026-08-18)
- Pinned blob: `e1e8e3460db7c1440e34642c4f7b885185ca5366`
- Licence: MIT, see `LICENSE` beside this file

`guidelines.md` is a verbatim copy and is listed in `.prettierignore`, so the
blob hash above stays comparable. Never edit it. A house rule that differs from
the upstream text belongs under "Project amendments" below, where the next
update cannot overwrite it.

## Updating the pin

```bash
bash .claude/skills/web-design-guidelines/update.sh
```

The script fetches the current upstream file, prints the diff against the pin
and stops. Read the diff, and only then let it write: it is a review, not a
sync. A rule that arrives this way has to hold for an information-dense
application, not only for a marketing page.

## Project amendments

eXocortex is a dense working surface, not a landing page. Where the upstream
text assumes a marketing site, these amendments win:

- Visible UI text is German (`CLAUDE.md`, rule 8). A finding about wording is
  written about the German string, never as a proposal to switch to English.
- Colours come from the semantic tokens in `packages/ui/src/tokens.css`
  (`CLAUDE.md`, rule 9). "Use a lighter grey" is not a finding; "this token is
  the wrong one for a disabled control" is.
- The brand is written `eXocortex` in every string a human reads.
