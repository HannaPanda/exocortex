---
name: eXocortex
description: Self-hostable collaborative workspace and external brain. A slate sheet, light ink, one amber signal.
colors:
  overlay: 'oklch(0.160 0.020 234 / 0.78)'
  sunken: 'oklch(0.270 0.029 234)'
  surface: 'oklch(0.320 0.031 234)'
  popover: 'oklch(0.355 0.032 234)'
  background: 'oklch(0.393 0.033 234)'
  card: 'oklch(0.437 0.034 234)'
  muted: 'oklch(0.478 0.030 234)'
  secondary: 'oklch(0.478 0.030 234)'
  accent-solid: 'oklch(0.445 0.045 72)'
  accent-strong: 'oklch(0.505 0.080 72)'
  border: 'oklch(0.510 0.024 234)'
  signal-line: 'oklch(0.585 0.065 72)'
  border-strong: 'oklch(0.725 0.022 234)'
  input: 'oklch(0.725 0.022 234)'
  foreground: 'oklch(0.933 0.003 248)'
  muted-foreground: 'oklch(0.832 0.013 240)'
  secondary-foreground: 'oklch(0.933 0.003 248)'
  accent-foreground: 'oklch(0.960 0.010 80)'
  primary: 'oklch(0.796 0.155 72)'
  primary-foreground: 'oklch(0.255 0.040 234)'
  primary-text: 'oklch(0.860 0.145 74)'
  ring: 'oklch(0.796 0.155 72)'
  destructive: 'oklch(0.545 0.195 25)'
  destructive-foreground: 'oklch(0.975 0.012 25)'
  destructive-text: 'oklch(0.880 0.130 25)'
  warning: 'oklch(0.870 0.135 100)'
  warning-foreground: 'oklch(0.255 0.050 100)'
  success: 'oklch(0.795 0.135 155)'
  success-foreground: 'oklch(0.235 0.045 155)'
  info: 'oklch(0.815 0.105 235)'
  info-foreground: 'oklch(0.230 0.035 235)'
  presence-1: 'oklch(0.875 0.125 72)'
  presence-2: 'oklch(0.820 0.115 250)'
  presence-3: 'oklch(0.845 0.135 340)'
  presence-4: 'oklch(0.915 0.085 195)'
  presence-5: 'oklch(0.795 0.140 300)'
  presence-6: 'oklch(0.775 0.130 30)'
  presence-foreground: 'oklch(0.200 0.025 234)'
typography:
  page-title:
    fontFamily: 'Inter Variable, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, Noto Sans, sans-serif'
    fontSize: '1.75rem'
    fontWeight: 720
    lineHeight: 1.15
    letterSpacing: '-0.035em'
  section-title:
    fontFamily: '{typography.page-title.fontFamily}'
    fontSize: '1.375rem'
    fontWeight: 600
    lineHeight: 1.375
    letterSpacing: '-0.015em'
  subsection-title:
    fontFamily: '{typography.page-title.fontFamily}'
    fontSize: '1.125rem'
    fontWeight: 600
    lineHeight: 1.375
    letterSpacing: '-0.01em'
  body:
    fontFamily: '{typography.page-title.fontFamily}'
    fontSize: '0.9375rem'
    fontWeight: 400
    lineHeight: 1.625
    letterSpacing: 'normal'
  ui:
    fontFamily: '{typography.page-title.fontFamily}'
    fontSize: '0.875rem'
    fontWeight: 500
    lineHeight: 1.43
    letterSpacing: 'normal'
  meta:
    fontFamily: '{typography.page-title.fontFamily}'
    fontSize: '0.75rem'
    fontWeight: 400
    lineHeight: 1.333
    letterSpacing: 'normal'
  micro:
    fontFamily: '{typography.page-title.fontFamily}'
    fontSize: '0.6875rem'
    fontWeight: 400
    letterSpacing: 'normal'
  nano:
    fontFamily: '{typography.page-title.fontFamily}'
    fontSize: '0.625rem'
    fontWeight: 400
    letterSpacing: 'normal'
  mono:
    fontFamily: 'JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace'
    fontSize: '0.85em'
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 'normal'
rounded:
  xs: '0.125rem'
  sm: '0.3125rem'
  md: '0.5rem'
  lg: '0.75rem'
  full: '9999px'
spacing:
  xs: '0.25rem'
  sm: '0.5rem'
  md: '0.75rem'
  lg: '1rem'
  xl: '1.5rem'
  2xl: '2rem'
layout:
  header-height: '3rem'
  sidebar-width: '17rem'
  context-panel-width: '21rem'
  reading-measure: '68ch'
motion:
  ease: 'cubic-bezier(0.22, 1, 0.36, 1)'
  duration-fast: '120ms'
  duration-settle: '480ms'
components:
  button-primary:
    backgroundColor: '{colors.primary}'
    textColor: '{colors.primary-foreground}'
    rounded: '{rounded.md}'
    padding: '0 1rem'
    height: '2.25rem'
    typography: '{typography.ui}'
  button-secondary:
    backgroundColor: '{colors.secondary}'
    textColor: '{colors.secondary-foreground}'
    rounded: '{rounded.md}'
    padding: '0 1rem'
    height: '2.25rem'
    typography: '{typography.ui}'
  button-ghost:
    backgroundColor: 'transparent'
    textColor: '{colors.foreground}'
    rounded: '{rounded.md}'
    padding: '0 1rem'
    height: '2.25rem'
    typography: '{typography.ui}'
  button-ghost-hover:
    backgroundColor: '{colors.accent-solid}'
    textColor: '{colors.accent-foreground}'
  button-destructive:
    backgroundColor: '{colors.destructive}'
    textColor: '{colors.destructive-foreground}'
    rounded: '{rounded.md}'
    padding: '0 1rem'
    height: '2.25rem'
    typography: '{typography.ui}'
  input:
    backgroundColor: 'transparent'
    textColor: '{colors.foreground}'
    rounded: '{rounded.md}'
    padding: '0 0.75rem'
    height: '2.25rem'
    typography: '{typography.ui}'
  card:
    backgroundColor: '{colors.card}'
    textColor: '{colors.foreground}'
    rounded: '{rounded.lg}'
    padding: '1.5rem'
  popover:
    backgroundColor: '{colors.popover}'
    textColor: '{colors.foreground}'
    rounded: '{rounded.lg}'
    padding: '0.25rem'
  nav-item:
    backgroundColor: 'transparent'
    textColor: '{colors.muted-foreground}'
    rounded: '{rounded.sm}'
    padding: '0.25rem 0.5rem'
    typography: '{typography.ui}'
  nav-item-active:
    backgroundColor: '{colors.accent-solid}'
    textColor: '{colors.foreground}'
---

# Design System: eXocortex

## 1. Overview

**Creative North Star: "Schiefer & Signal"**

eXocortex is a precision instrument for thinking, not a document product. The
page is slate: `#344955`, a deep blue-grey that carries light rather than
swallowing it. Around it the shell is the same slate, darker, and it recedes. A
single amber signal, `#F9AA33`, marks everything that is interactive or
happening. Nothing else in the interface is allowed to be a colour.

Two things do the work here. The first is that the sheet is the brightest large
surface in the product and the chrome around it is not, so the eye lands on the
writing before anyone decides to look there. The second is that amber appears
only where something is live, so the eye has exactly one thing to track. That
matters more here than in most products: the primary user has ADHD and works in
long sessions, so every competing call to attention is a defect, not a feature.

The lineage is the lit instrument panel: a slate housing, a readout that glows,
one warm indicator. Not the neon street sign, and not the terminal costume. Two
earlier palettes were exactly that costume -- saturated green on near-black,
then near-black graphite with an amber terminal glow -- and both were removed.
This one is a mid-tone: the interface is dark, but it is not hiding.

The three colours are the logo's, not a scheme laid over it. `#344955` is its
ground, `#F9AA33` is its ink, `#E7E9EB` is the rule between the mark and the
wordmark. The product wears its own logo rather than the other way round.

Register: **product**. Design serves the work. See `PRODUCT.md` for users, voice
and strategic principles.

## 2. Colors: Slate and Signal

Authored in OKLCH throughout, because the perceptually uniform lightness axis is
what makes the surface ramp read as evenly spaced steps. Values live in
`packages/ui/src/tokens.css` and are exposed to Tailwind through
`packages/ui/src/styles.css`. Frontmatter carries OKLCH rather than hex on
purpose: the project has an OKLCH-only doctrine and there is one source of truth.
The three brand hexes appear exactly twice each, in `tokens.css` as the anchors
of the system and in `logo.tsx` as the logo's own ink.

### Primary

`primary` `oklch(0.796 0.155 72)`, which is `#F9AA33`. The only brand colour. It
marks the focus ring, the active page in the tree, the primary action, live job
progress and your own collaboration cursor.

`primary-foreground` `oklch(0.255 0.040 234)` sits on it at 8.1:1, and it is
slate rather than black: the brand blue appears inside the brand amber, which is
what keeps a primary button looking like part of the product.

`primary-text` `oklch(0.860 0.145 74)` is the same amber lifted for use as text
and as an icon colour, at 5.9:1 on the page and 4.9:1 on a card. The lift is not
cosmetic. On this palette `primary` used as text measures 4.0:1 on a card and
fails; the Fill-Is-Not-Text Rule below is enforced by arithmetic, not taste.

### Secondary

There is no second brand colour, and that is the point. What there is instead is
a **four-step scale of the one colour**, because amber used as an on/off switch
left the interface with a single amber element per screen and no warmth
anywhere else:

| Token           | Value                   | Job                                                     |
| --------------- | ----------------------- | ------------------------------------------------------- |
| `accent-solid`  | `oklch(0.445 0.045 72)` | hover                                                   |
| `accent-strong` | `oklch(0.505 0.080 72)` | selection, "you are here"                               |
| `signal-line`   | `oklch(0.585 0.065 72)` | structure: rules, leader dots, tree guides. Never text. |
| `primary`       | `oklch(0.796 0.155 72)` | action, focus, live                                     |

Only the last of the four is a colour you notice. The first three are warmth you
feel, which is what keeps the scale inside the One Signal Rule: amber still
means "interactive or happening", and a rule is neither. Note that the four are
listed by lightness and not by loudness: `signal-line` is lighter than the
selection tint and still quieter, because it is a hairline and the tint is a
field. Area is half of how loud a colour is.

`secondary` `oklch(0.478 0.030 234)` is a neutral slate chip, deliberately
untinted: a second warm control would compete with the signal.

`accent-solid` has to clear `background`, not just `surface`. A hover lands on a
tree item in the dark chrome, on a menu row, and on a table row on the open page,
and the page is the lightest of the three. A hover tint calibrated against the
sidebar alone is invisible exactly where the density is highest.

`accent-strong` is a separate token rather than a stronger opacity of the hover.
Selection answers "where am I", which in a retrieval-first product is the state
the user reads most often; it has to survive a glance from across the desk.
Foreground text sits on it at 4.9:1. `primary-text` sits on it at 3.7:1, which is
enough for the amber file icon on a selected row (WCAG 1.4.11) and not enough for
running text, so a selected row never carries amber prose.

### Tertiary

Status colours are a separate system from the brand signal, never decorative.
All of them are pitched brighter than they were under the near-black palette,
because they now have to carry against a mid-tone page:

- `destructive` `oklch(0.545 0.195 25)` -- fill. `destructive-text`
  `oklch(0.880 0.130 25)` -- the same red as text and icons, at 4.6:1 on a card.
- `warning` `oklch(0.870 0.135 100)` -- yellow-gold, held 28 degrees of hue away
  from the amber signal so a caution never reads as a primary action.
- `success` `oklch(0.795 0.135 155)`, `info` `oklch(0.815 0.105 235)`.

`presence-1…6` are the collaboration cursors, spread across hue _and_ lightness
(0.775…0.915) so they survive deuteranopia and protanopia, where hue alone
collapses. The whole band sits high for the same reason as the status colours:
every one of them has to clear 3:1 on `card`, the lightest surface a cursor can
land on. `presence-1` is the amber signal and it is reserved: on your own screen
it is always you, and `presenceColor` hashes everyone else across the remaining
five so a remote user can never draw it. That costs one colour out of six and
buys the answer to the question a presence strip is asked first.

### Neutral

Six steps, all at hue 234 and chroma <= 0.034, with the page near the top rather
than at the bottom:

| Token        |     L | Role                                           |
| ------------ | ----: | ---------------------------------------------- |
| `sunken`     | 0.270 | wells: code blocks, readouts cut into the page |
| `surface`    | 0.320 | the housing: sidebar, header, context panel    |
| `popover`    | 0.355 | floating: menus, dialogs, the command palette  |
| `background` | 0.393 | the page. `#344955`                            |
| `card`       | 0.437 | a block raised off the page                    |
| `border`     | 0.510 | separation                                     |

The foreground is `#E7E9EB` at 7.7:1 on the page and 6.4:1 on a card.

Three things about this ramp are worth stating, because each of them looks like
a mistake until the arithmetic is on the table.

**The page is not the bottom.** A brand colour at lightness 0.393 is a mid-tone,
and a mid-tone canvas has room above it and below it. Putting the shell below
the page is what makes the sheet read as lit; putting it above would have made
the writing the darkest thing on screen.

**`popover` sits below `background`.** This is the one break in the monotone
ramp and it is deliberate. A menu, a dialog and the command palette belong to the
housing, not to the sheet, and they are marked as floating by a `border-strong`
outline and a shadow rather than by out-lightening the page. Letting them climb
instead would push the lightest surface past 0.47, and past 0.47 neither the
amber signal nor the muted text clears 4.5:1 any more. That is the bill a
mid-tone canvas hands you, and this is the cheapest place to pay it: a menu that
is a shade darker than the page still reads as a menu, which is how every
desktop has drawn one for thirty years.

**The ink moved up, not down.** `muted-foreground` is 0.832 where it used to be
0.740, `destructive-text` 0.880 where it was 0.815, and the content colours are
all at a single 0.865. On a near-black background those values would have been
glare. On this one they are the floor.

### Named Rules

**The One Signal Rule.** Amber is used on at most ~10% of any screen and only
where something is interactive or happening. If a decorative element is amber,
the element is wrong, not the rule.

**The Fill-Is-Not-Text Rule.** `primary` and `destructive` are fill colours,
sized for dark text on top of them. `primary-text` and `destructive-text` are
their text and icon counterparts. A fill colour used as a text colour is a bug,
and on this palette it is a measurable one: 4.0:1 against 4.9:1 on a card.

**The Border Weight Rule.** `border` (1.4:1 on card) separates; it never
delimits a control. Anything the user must perceive as a boundary uses `input`
or `border-strong` (3.2:1 on card, the lightest surface a form field ever sits
on, WCAG 1.4.11). `signal-line` (1.9:1 on card) sits between the two and is
neither: it is warm, so a structural rule reads as drawn rather than as a seam,
and it is never a boundary you can act on.

**The Structure-Is-Not-Signal Rule.** A line that describes the shape of a
screen wears `signal-line`; a thing you can act on wears `primary`. The two are
the same hue on purpose and are never interchangeable. If a rule, a leader or a
tree guide turns bright amber, it has started claiming to be a control.

**The Never-Only-Colour Rule.** Status, validation, presence and diff state each
carry an icon or text as well. Remove all colour and the interface still works.

**The Selected-Is-Not-Hover Rule.** Hover is `accent-solid`, selection is
`accent-strong`, and selection additionally changes weight or turns an icon
amber. A selected element that differs from a hovered one only in opacity is a
bug: pointer feedback and "you are here" are different questions.

**The Code-Is-A-Well Rule.** Code, identifiers and machine readouts sit on
`sunken`, below the page, never on `muted` above it. A code block is something
the sheet is cut into, not a card stacked on top of it, and on a mid-tone page
the difference is the whole legibility of the block.

## 3. Typography

**Display Font:** Inter Variable, self-hosted (`Inter Variable, ui-sans-serif, …`)
**Body Font:** same stack
**Label/Mono Font:** JetBrains Mono, self-hosted (`JetBrains Mono, ui-monospace, …`)

**Character:** Embedded, not system, by decision (superseding the earlier
"no webfont" call). The system-font stack meant the same line of text wrapped
differently on every OS, because `ui-sans-serif`/`system-ui` resolve to a
different typeface with different glyph widths per platform: Segoe UI on
Windows, Helvetica Neue on macOS, Roboto on Android. That made cross-device
reflow unpredictable, which matters for a tool people also read from a phone.
Inter Variable and JetBrains Mono are bundled at build time via `@fontsource`
(`packages/ui/src/styles.css`), never fetched from a CDN at runtime, the same
rule already applied to KaTeX (`apps/web/src/app/globals.css`). Both are SIL
OFL 1.1. `font-display: swap`
keeps first paint from blocking on the download; the fallback stack after each
font is what renders during that gap. The system stack remains as the
fallback chain, not the primary, so a machine that somehow fails to load the
bundled font still gets something legible. Monospace is reserved for code,
IDs and anything the user might copy verbatim; it is a semantic signal, not
decoration.

**Logo Font:** Neuropol, and only in the logo. The wordmark in
`packages/ui/src/components/logo.tsx` is set in it and then converted to
outlines, so the face is never loaded at runtime, never appears in a UI label,
and cannot be picked by accident. That is the deal a display face gets here: it
carries the name, Inter carries everything else. The typeface (Ray Larabie,
1996, CC0 since 2024) sits in `packages/ui/src/assets/` so the wordmark can be
reset; `packages/ui/src/assets/README.md` has the recipe and the licence note.
Neuropol X, the commercial expansion, is a different font and is not in this
repository.

### Hierarchy

| Role              | Utility           | Size      | Weight | Tracking | Use                                        |
| ----------------- | ----------------- | --------- | ------ | -------- | ------------------------------------------ |
| Page title        | `text-title`      | 1.75rem   | 720    | -0.035em | the name of whatever you are looking at    |
| Section title     | `text-section`    | 1.375rem  | 600    | -0.015em | H1 inside documents                        |
| Subsection        | `text-subsection` | 1.125rem  | 600    | -0.01em  | H2                                         |
| Sub-subsection    | `text-body` + 600 | 0.9375rem | 600    | normal   | H3                                         |
| Body              | `text-body`       | 0.9375rem | 400    | normal   | editor content, prose                      |
| UI                | `text-ui`         | 0.875rem  | 500    | normal   | buttons, labels, nav                       |
| Meta              | `text-meta`       | 0.75rem   | 400    | normal   | timestamps, counts, hints                  |
| Instrument        | `text-micro`      | 0.6875rem | 400    | normal   | section-rule labels, key caps, chip counts |
| Instrument, small | `text-nano`       | 0.625rem  | 400    | normal   | avatar initials, a count inside a dot      |

The ladder is theme tokens in `packages/ui/src/styles.css`, not prose: a rung
nobody can name is a rung every screen decides for itself, which is how the
application ended up with 44 arbitrary `text-[…]` values, 28 of them the same
0.6875rem the instrument marks use. The top three rungs carry a full treatment
(size, leading, weight, tracking) because a heading is a treatment rather than a
size; the rest set size and leading only, so adopting `text-ui` never silently
re-weights a call site.

The bottom two rungs were undocumented for a long time and are the reason for
the invented sizes. They exist because the instrument marks need a tier below
Meta: an uppercase section label, a key cap, a count riding on a rule. They set
size alone, because they live inside rows and chips whose height is already set
by the row.

The ratio tightens on the way down (1.27 → 1.22 → 1.20) and the last step is
carried by weight alone, so H3 and body share a size. The page title clears the
document's own H1 by a full step, because the two are different things: one names
the page, the other opens a section. A knowledge tool with 3rem headings wastes
the vertical space the content needs, but a ladder whose top two rungs are the
same size has no hierarchy at all.

**Weight carries the top of the ladder, not size.** The whole ladder used to run
between 400 and 600, which is not a contrast but a gradient: nothing on the
screen was heavy, so nothing read as first. The page title is now 720, and the
tracking tightens with it, because letterforms that heavy set loose look unset
rather than airy. Inter Variable has the axis; this is the one place worth
spending it. The treatment lives in `.exocortex-page-title`
(`packages/ui/src/styles.css`) and is used by every page title in the product:
the document's own title field, the workspace name on the overview, the heading
of an administration page. Those used to be two different sizes for the same
question.

Vertical space is part of the ladder. Space above a heading is several times the
paragraph gap; space below it is nearly nothing. The gap groups the section,
which is why documents need no rules or boxes to look structured.

### Named Rules

**The Measure Rule.** Long-form text is capped at 68ch. The editor column is
never full-bleed, no matter how wide the window.

**The Meta-Is-Muted Rule.** Anything that is not content is `muted-foreground` at
0.75rem. Timestamps, counts and status never compete with the text they describe.

**The Values-Are-Monospace Rule.** Numbers and identifiers wear the mono face
with tabular figures (`.exocortex-numeric`): timestamps, counts, versions, IDs,
keyboard keys, the search readout. Labels and prose never do. A count that keeps
its width while it changes is the difference between a readout and a jitter, and
holding the line at _values only_ is what keeps this instrument typography
instead of the terminal costume PRODUCT.md rules out.

## 3a. Motion

One curve, `cubic-bezier(0.22, 1, 0.36, 1)`, an exponential ease-out: movement
leaves fast and settles long, so it reads as arrived rather than slid. No bounce,
no elastic, no spring.

`duration-fast` 120ms is the project default for every transition, set through
Tailwind's `--default-transition-*` variables so no component has to opt in. It
is short on purpose: "fast" is a claim the product makes about itself.
`duration-settle` 480ms is the decay of a signal that has fired, long enough to
catch in peripheral vision and short enough not to linger.

### Named Rules

**The Motion-Is-State Rule.** Every animation reports a state change: something
appeared, something was pressed, something was saved. Nothing moves to look
alive. There are no entrance choreographies and no scroll effects; the product
opens into a task.

**The One-Pixel-Press Rule.** Buttons drop one pixel on `:active`. That is the
entire press vocabulary. A control that does not move under the pointer feels
like a picture of a control.

**The Signal-Fires-Then-Fades Rule.** When amber marks an event rather than a
place (the save heartbeat), it brightens instantly and decays over
`duration-settle`. The same information is always also readable as text, so
`prefers-reduced-motion` loses the beat and nothing else.

## 4. Elevation

Elevation is the surface ramp, not shadow. A step of the slate says where a
layer sits; shadows only confirm what the colour already said.

`sunken` (a well cut into the page) → `surface` (the housing: sidebar, header,
panels) → `background` (the page) → `card` (a block raised off it) → `overlay`
(modal scrim, `oklch(0.160 0.020 234 / 0.78)`, far below the ramp so the dimmed
content reads as pushed back rather than covered in black).

`popover` is the exception, and it is the only one. Menus, dialogs and the
command palette sit at 0.355, between the housing and the page, because they
belong to the housing rather than to the sheet. They are read as floating from
their `border-strong` outline and their shadow. Section 2 has the arithmetic:
climbing instead would push the ramp past the point where the amber signal still
clears 4.5:1.

Each step is at least 0.035 of lightness apart, and that number is the whole
rule. Below about 0.03 the eye stops resolving the step, and the ramp becomes a
claim the tokens make and the screen does not keep. A new surface that cannot
afford a clear step is not a new surface.

### Radius

Four steps, and the step is the point: a radius says how big the thing wearing
it is.

| Token | Value     | Wears it                                                        |
| ----- | --------- | --------------------------------------------------------------- |
| `xs`  | 0.125rem  | a tint over text or a graphic: a diff span, a chart bar         |
| `sm`  | 0.3125rem | a mark smaller than a control: a chip, a key cap, a tree button |
| `md`  | 0.5rem    | a control: button, input, select                                |
| `lg`  | 0.75rem   | a surface: popover, dialog, sheet, card                         |

There used to be six values in use against three tokens. Tailwind's bare
`rounded` (4px) sat one pixel under `sm`, and `xl` was documented at 14px, never
defined, and therefore resolved to Tailwind's 12px — so a card and a popover
shared a radius while this document said they did not. Neither gap is one anybody
sees, so both were a tier the system claimed and the screen did not keep. What
is left is about 1.6x per step.

### Shadow Vocabulary

Four steps, tinted with the page's own hue rather than black. A pure black
shadow on a mid-tone slate reads as dirt instead of as a layer, and 10% of
black — Tailwind's default — is invisible on a surface this light. The colour is
the same deep slate as the modal scrim.

- `shadow-xs` — a field at rest
- `shadow-sm` — a block raised off the page: a card, a PDF page
- `shadow-md` — a floating surface: menu, popover, toolbar, tooltip
- `shadow-lg` — a modal surface: dialog, sheet

There is no fifth step. `shadow-xl` was in use for dialogs while `shadow-md` was
carrying exactly one tooltip, which is two names for one job and one name for
none.

### Named Rules

**The Flat-By-Default Rule.** Surfaces are flat at rest. Depth appears when
something floats above the page or responds to state, never as ornament.

**The No-Glass Rule.** No backdrop blur. Blur on a dark UI reduces text contrast
and adds a per-frame compositing cost for a decorative effect. The modal scrim is
a flat tinted colour.

## 5. Components

Built on Base UI primitives (`@base-ui/react`), sourced through the
shadcn registry and adapted. One primitive library, no exceptions.

### Buttons

- **Primary** — `bg-primary` / `text-primary-foreground`, `rounded-md`, height
  2.25rem, hover `bg-primary/90`. One per screen region. If a screen has two
  primary buttons, one of them is not primary.
- **Secondary** — neutral slate fill, for the second-most-likely action.
- **Outline** — 1px `border`, transparent fill, hover to `accent-solid`.
- **Ghost** — no chrome at rest, hover to `accent-solid`. The default for
  toolbar and icon actions; the app shell is mostly ghost buttons.
- **Destructive** — `bg-destructive`, only for irreversible actions.
- **Link** — `primary-text` with underline on hover.

Sizes: `sm` 2rem, default 2.25rem, `lg` 2.5rem, `icon` 2.25rem square, `icon-sm`
1.75rem square.

### Focus

One ring, everywhere: 3px `ring-ring/50`, and no outline (P11, decided
2026-09-24). The primitives carry it as `focus-visible:ring-[3px]
focus-visible:ring-ring/50`; everything without a rule of its own gets the same
ring from `:focus-visible` in the base layer of `packages/ui/src/styles.css`, so
a link, a tree row and a button look alike. A field additionally moves its
border to `ring`; that belongs to the field, not to the focus language. Where a
container clips (`overflow: hidden`, a scrollport flush with the element), the
element adds `ring-inset` instead of reaching for another shape. The ring is a
shadow, so under `forced-colors: active` an unlayered rule in the same file
replaces it with a 2px `CanvasText` outline. There is no 1px ring, no 2px
outline and no fill as a focus state.

### Cards / Containers

`rounded-lg`, `bg-card`, 1px `border`, `shadow-sm`, 1.5rem padding, 1rem
internal gap. Used for genuinely separable blocks, and after the 2026-09-20
review that is two places: the front door, where one form floats on an empty
page, and the pair of setup recipes in the connection panel. A card is not the
answer to grouping — `SectionRule` is — and the administration overview, which
used to be eight of them in a grid, now uses `Readout` under rules.
**Never nested.** A card inside a card means the hierarchy is wrong.

**And never as a list row.** The references and activity panels each drew a
bordered box per entry, which turned a list into a stack of identical outlined
cards -- the card grid this system rules out, at panel scale. A row needs a
section rule above it and a hover fill under the pointer; it does not need
chrome of its own. A row also never paints its own background: a row that knows
which surface it is on gets it wrong the moment it is reused, and paints a hole
into the panel.

### Inputs / Fields

`rounded-md`, transparent fill, 1px `input` border (3.4:1, perceivable),
height 2.25rem, `shadow-xs`. Focus moves the border to `ring` and adds a 3px
`ring/50`. Invalid state moves the border to `destructive` and the ring to
`destructive/20`, and is always accompanied by a message.

A date is entered with `DatePicker` (and `DateTimePicker` where a time
belongs to it), never with a native date field (decided 2026-09-24 from the
experiment "Datumseingabe"): a field-bordered button naming the day as
"Mo., 05.10.2026", and `Calendar` in a popover that opens on the chosen day,
with month and year dropdowns, "Heute", and "Entfernen" where the value is
optional. The time beside it stays the native field, because a time is typed
rather than browsed. ESLint refuses a literal `type="date"` or
`type="datetime-local"` in the interface.

Every other input type goes through the same `Input`, and
`/design-system#feld-typen` shows each one the product uses. The parts the browser draws itself (the date
and time popups, the spin buttons, a range slider) are dark through
`color-scheme: dark` and amber through `accent-color: var(--primary)` on the
root, so no native control is left in the browser's blue.

### Navigation

The page tree is the primary navigation: `nav-item` at `muted-foreground`,
`rounded-md`, tight 0.25rem/0.5rem padding for density. The tree recedes so the
current page can come forward: it is `accent-strong` with full-strength
`foreground`, weight 500, and an amber file icon. Hover is `accent-solid` and
never approaches it. The same three-part treatment marks the active row in the
command palette and the selected tab in the context panel, so "this one" looks
identical wherever the user meets it.

### The instrument marks

Two primitives in `packages/ui/src/components/instrument.tsx` carry the
structure of every dense screen. Both are drawn in `signal-line`, and the
difference between them is mass, not colour: a solid square against a hairline.

**`SectionRule`** is a label riding on a short rule, opened by a small square.
It is the alternative to a card header: it separates without enclosing. The rule
is fixed and short rather than full width, because a rule that crosses the whole
column competes with the leaders in the rows beneath it, and two systems of
horizontal line on one screen read as stripes. It appears at the same treatment
everywhere a section is announced -- the workspace overview, the page tree
header, the properties, references and activity panels -- so "this is a section"
is learned once. Its optional `trailing` slot takes a count, and a count of zero
is never passed: a section that says its own emptiness in a sentence would
otherwise report the absence twice.

**`Leader`** is the dotted rule that carries the eye from a label across to its
value. A two-column list of a name and a number fails at exactly the width where
it becomes useful, and a table of contents solved that a long time ago. Dotted
rather than dashed and held to 70%: a dash long enough to read as a dash stops
leading the eye and starts being a rule. It expects to sit between two items in
a `flex items-baseline` row.

**`Readout`** is the row `Leader` was drawn for, given a name: a label, the
dotted rule, the value in the numeric face, and an optional line of context
under it. It is what this product uses instead of a metric tile. A grid of
identical boxes each holding a caption and a big number is the shape PRODUCT.md
rules out, and it carries no ranking -- "Nutzer" and "KI-Kosten (24 h)" are not
equally important and a grid draws them identically. A column of readouts under
a `SectionRule` says which group a figure belongs to, and the order inside the
group says which one is read first. Its `tone="live"` marks the figures about
what just happened rather than what is stored, which is the one place on such a
screen where amber still means what it means everywhere else.

The typography of the mark is exported on its own as `sectionLabelClassName`,
for the two places that are not section announcements and still belong to the
family: the disclosure that opens the technical properties is a control, and a
day heading inside the activity list is a marker inside a section. Both used to
copy the four utilities, which is how one of them ended up at a tracking the
component had not used for months.

The same hairline device runs vertically as a **tree guide**: an unfolded branch
in the page tree draws a `signal-line` rule down its parent's chevron column, so
a branch reads as a branch several levels deep, where indentation alone stops
being countable.

### The logo

Two components, and which one you reach for is a rule rather than a preference.

`ExocortexWordmark` is the full lockup: mark, rule, name. It appears exactly
once per screen and always in the top-left corner, at `h-7` in the application
header and `h-10` at the front door (login, invitation). `ExocortexLogo` is the
mark alone, and it is for the places where a name will not fit or is not being
asked for: an avatar, a browser tab, a launcher tile, a favicon.

The lockup is the one deliberate exemption from the One Signal Rule. It is 8.3:1
and everything but its rule is brand amber, which is why the header carries it
one step below its default height rather than at `h-8`: 1.75rem of lockup in a
3rem bar is a signature, 2rem is a banner. The exemption is worth taking because
the alternative was tested and lost. A bare mark in the corner obeys the rule
and reads as a product that has not finished naming itself, and the corner is
the one place in the interface where the user is not being asked to do anything,
so the signal colour there costs nothing. Everywhere else the rule stands: the
name is never repeated inside the page, in a panel, or beside a control.

### Signature Component: the save heartbeat

`SaveIndicator` sits in the document toolbar and is the only place in the product
where amber means "this just happened" rather than "you can act here". A local
edit sets it to `saving`; 700ms after the typing stops it fires: the dot goes
full amber and decays back to `muted-foreground/50` over `duration-settle`, and
the timestamp next to it updates. The timestamp is the carrier that survives
reduced motion and colour blindness, and there is no live region, because
announcing every save would make the page unusable with a screen reader.

### Signature Component: presence

Remote cursors carry a 1px caret in the user's presence colour with a label tab
above it (`presence-foreground` text, ≥5.7:1 on every presence colour). Avatars
in the header use the same colour. Colour is consistent per person across the
whole app: the cursor in the text, the avatar in the header and the name in the
tooltip are always the same hue.

You are the exception, and deliberately so. Your own avatar is `presence-1`, the
amber, on your own screen only. The colour you broadcast into awareness stays
the hashed one, because it is what everyone else has to identify you by, and it
would be useless if every participant sent the same value. So the swap happens
where the awareness states are read rather than where they are written
(`collaboration-connection.ts`), which keeps it to one line and one place: amber
is you, everywhere you look, in every workspace and on every account.

## 6. Do's and Don'ts

### Do:

- Reach for `packages/ui/src/components/ui` before the registry, and the registry
  before a new primitive.
- Use the surface ramp for elevation and let shadow only confirm it.
- Let amber mean one thing. Focus, active, primary, live. Use `signal-line` for
  the lines that describe a screen, and never the other way round.
- Announce a section with `SectionRule`, and carry a label to its value with
  `Leader`. Both live in `@exocortex/ui`.
- Carry every status with an icon or text as well as colour.
- Keep German for everything the user reads; English for code, logs, identifiers
  and API error codes.
- Give every animation a `prefers-reduced-motion` variant that is a complete
  experience, not a degraded one.

### Don't:

- Don't hardcode a colour. Every colour is a semantic token.
- Don't use a fill colour (`primary`, `destructive`) as a text colour.
- Don't add a second accent colour. The palette is restrained on purpose.
- Don't nest cards, don't wrap something in a card just to group it, and don't
  give a list row a border of its own.
- Don't let a row paint its own background. It does not know which surface it
  is on, and a wrong guess punches a hole into the panel around it.
- Don't use a coloured left or right border as an accent on cards, list items,
  callouts or alerts. The editor is no exception (P13, decided 2026-09-24): a
  commented block carries a light `warning` wash and the count of its open
  comments at the right edge, and a transcluded section carries the same plain
  frame and header as a database embed.
- Don't use gradient text, backdrop blur as decoration, or a hero-metric block.
- Don't reach for a modal first. Exhaust inline and progressive alternatives.
- Don't animate layout properties, and don't use bounce or elastic easing. Ease
  out with exponential curves.
- Don't introduce a webfont without measuring the navigation cost first.

## 7. Design System workflow

How a new visual decision enters the system, for people and coding agents
alike (issue #128). The rules above say what the interface looks like; this
section says how it is allowed to change. It exists because the way a design
system dies is not one bad decision but many small parallel ones: a second
empty state, a third focus style, a colour nobody named.

### Where each thing lives

| Question                                           | Source of truth                                      |
| -------------------------------------------------- | ---------------------------------------------------- |
| What the rule is, and why                          | this file (normative)                                |
| The value of a token                               | `packages/ui/src/tokens.css`                         |
| Theme mapping, base layer, the focus ring          | `packages/ui/src/styles.css`                         |
| A reusable primitive, layout or state              | `packages/ui/src` (`@exocortex/ui`)                  |
| A domain component (page tree, editor, panels)     | `apps/web/src/components`, never `packages/ui`       |
| What it looks like and how it behaves, today       | `/design-system`, drawn by the components themselves |
| Which implementation is canonical, duplicate, open | `docs/design-system-inventory.md`                    |
| Where to find a component, how to install one      | `docs/ui-system.md` (technical lookup)               |
| Which examples are guarded                         | `e2e/styleguide/` (screenshots, axe, keyboard)       |

When two of these would have to state the same fact by hand, one of them should
derive it instead. The styleguide's token table is the model: it reads
`tokens.css`, and a token without a role there fails `design-tokens.test.ts`.

### Search before inventing

Before a new primitive, variant or pattern, in this order:

1. `packages/ui/src/components/ui` and `packages/ui/src/components`
2. `/design-system` and the inventory: is it already there, or already open?
3. the domain components in `apps/web/src/components` that solve the same shape
4. this file, for a rule that already answers the question
5. the shadcn registry (`docs/ui-system.md`, "Component workflow")

Only then extend, and say in the commit why none of the existing answers fits.
"It looked slightly different in the mock-up" is not a reason; a state, a
width or an interaction the existing one cannot carry is.

### What has to appear in `/design-system`

A change is visible design, and gets its example in the canonical section in
the same commit series, when it introduces any of:

- a semantic token
- a variant of a control
- a state that matters (loading, invalid, selected, disabled, empty, error)
- a pattern that will be reused
- a responsive behaviour of its own
- focus or keyboard semantics
- a way of showing status
- a layout convention

An internal refactor with no visible contract needs no entry. The test is
whether somebody building the next screen would have to know about it.

A new token also needs a reason here in §2 (what it is for, and its contrast),
a role in `foundations/token-catalog.ts`, and no second name for a job an
existing token already does. A new variant belongs on the component that owns
the concept, never in a copy of it. A pattern is a new entry when it recurs in
at least two places and has a shape of its own; until then it is a component
with a use.

### Experiments come before an unclear decision

When two or more answers are plausible and the choice is mainly visual or
interactive (responsive transformations, dense toolbars, focus treatments,
empty states, complex forms, a new information hierarchy):

- do not decide from prose
- do not build one variant quietly into the product
- draw the variants side by side under "Experimente" on `/design-system` and
  let a person decide there

An experiment is not a product contract. It is never called canonical, never
imported by product code (oxlint refuses it), and never a reference for the
next screen. The frame, the file layout and the phone-width probes are in the
inventory, §6. Once a variant is chosen:

1. The decision and the chosen variant are written into the decision's issue.
2. Product code changes, in one place where the rule allows it.
3. This file gets the rule; `docs/ui-system.md` and the inventory get the state.
4. The chosen variant's example moves into its canonical section.
5. The rejected variants are deleted, not hidden, and the experiment with them.
6. The screenshot baselines are re-approved and `impeccable detect` runs again.

### Baselines

A screenshot baseline in `e2e/styleguide/__screenshots__/` changes only
because a decision changed what it shows: a token, a variant, a spacing rule, a
chosen experiment. It is updated with `pnpm test:styleguide:update`, looked at,
and committed on its own with the decision it records. A baseline rewritten to
make a red build green, without anybody deciding the new picture is right,
defeats the only thing it is for.

### What the machine checks

Where a rule is objective it is a gate, not a sentence:

| Rule                                     | Enforced by                                                     |
| ---------------------------------------- | --------------------------------------------------------------- |
| no literal colour outside the tokens     | `check-semantic-colours.mjs`, a hard gate in `build.sh`         |
| no import from the experiments           | `no-restricted-imports` in the generated `.oxlintrc.json`       |
| a date is a `DatePicker`, not native     | `no-restricted-syntax` in `eslint.config.mjs`                   |
| every token has a role in the styleguide | `design-tokens.test.ts`                                         |
| canonical examples still look the same   | `pnpm test:styleguide`, screenshots, in `build.sh --full-tests` |
| WCAG 2.2 AA, focus, keyboard             | `pnpm test:styleguide`, axe and keyboard tests                  |
| the anti-patterns in §6                  | `impeccable detect`, by hand (the detector ships with a plugin) |

Taste is not turned into a regex. Spacing, hierarchy and whether a screen has a
point of view stay with a person and the design skills.

### Checklist for a UI change

- Is an existing component or pattern reused, and if not, is the reason written
  down?
- Is a new token really needed, or does one already do the job?
- Are all the states there: loading, empty, error, disabled, invalid?
- Keyboard and touch checked, and the focus ring visible?
- Checked at 390 px?
- Is the `/design-system` example updated, or added?
- Does this file need a rule, or a changed one?
- Did a screenshot baseline change, and was that intended?
- Is `pnpm test:styleguide` green?
