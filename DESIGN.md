---
name: Exocortex
description: Self-hostable collaborative workspace and external brain. Cool graphite, warm light, one amber signal.
colors:
  background: "oklch(0.17 0.010 275)"
  surface: "oklch(0.20 0.011 275)"
  card: "oklch(0.21 0.012 275)"
  popover: "oklch(0.235 0.013 275)"
  overlay: "oklch(0.11 0.008 275 / 0.72)"
  muted: "oklch(0.255 0.012 275)"
  secondary: "oklch(0.26 0.013 275)"
  accent-solid: "oklch(0.26 0.025 62)"
  accent-strong: "oklch(0.33 0.055 62)"
  border: "oklch(0.32 0.014 275)"
  border-strong: "oklch(0.53 0.016 275)"
  input: "oklch(0.53 0.016 275)"
  foreground: "oklch(0.93 0.008 85)"
  muted-foreground: "oklch(0.72 0.012 275)"
  secondary-foreground: "oklch(0.90 0.008 85)"
  accent-foreground: "oklch(0.94 0.010 75)"
  primary: "oklch(0.78 0.150 62)"
  primary-foreground: "oklch(0.20 0.035 62)"
  primary-text: "oklch(0.78 0.150 62)"
  ring: "oklch(0.78 0.150 62)"
  destructive: "oklch(0.53 0.190 25)"
  destructive-foreground: "oklch(0.97 0.012 25)"
  destructive-text: "oklch(0.72 0.150 25)"
  warning: "oklch(0.84 0.140 100)"
  warning-foreground: "oklch(0.24 0.050 100)"
  success: "oklch(0.72 0.140 152)"
  success-foreground: "oklch(0.20 0.040 152)"
  info: "oklch(0.74 0.110 235)"
  info-foreground: "oklch(0.19 0.030 235)"
  presence-1: "oklch(0.82 0.125 62)"
  presence-2: "oklch(0.75 0.120 245)"
  presence-3: "oklch(0.78 0.150 340)"
  presence-4: "oklch(0.86 0.090 200)"
  presence-5: "oklch(0.70 0.150 295)"
  presence-6: "oklch(0.66 0.120 30)"
  presence-foreground: "oklch(0.18 0.020 275)"
typography:
  page-title:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, Noto Sans, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.333
    letterSpacing: "-0.025em"
  section-title:
    fontFamily: "{typography.page-title.fontFamily}"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.025em"
  body:
    fontFamily: "{typography.page-title.fontFamily}"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.625
    letterSpacing: "normal"
  ui:
    fontFamily: "{typography.page-title.fontFamily}"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.43
    letterSpacing: "normal"
  meta:
    fontFamily: "{typography.page-title.fontFamily}"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.333
    letterSpacing: "normal"
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace"
    fontSize: "0.85em"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
rounded:
  sm: "0.3125rem"
  md: "0.5rem"
  lg: "0.75rem"
  xl: "0.875rem"
  full: "9999px"
spacing:
  xs: "0.25rem"
  sm: "0.5rem"
  md: "0.75rem"
  lg: "1rem"
  xl: "1.5rem"
  2xl: "2rem"
layout:
  header-height: "3rem"
  sidebar-width: "17rem"
  context-panel-width: "21rem"
  reading-measure: "68ch"
motion:
  ease: "cubic-bezier(0.22, 1, 0.36, 1)"
  duration-fast: "120ms"
  duration-settle: "480ms"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    padding: "0 1rem"
    height: "2.25rem"
    typography: "{typography.ui}"
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-foreground}"
    rounded: "{rounded.md}"
    padding: "0 1rem"
    height: "2.25rem"
    typography: "{typography.ui}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "0 1rem"
    height: "2.25rem"
    typography: "{typography.ui}"
  button-ghost-hover:
    backgroundColor: "{colors.accent-solid}"
    textColor: "{colors.accent-foreground}"
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.destructive-foreground}"
    rounded: "{rounded.md}"
    padding: "0 1rem"
    height: "2.25rem"
    typography: "{typography.ui}"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "0 0.75rem"
    height: "2.25rem"
    typography: "{typography.ui}"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.xl}"
    padding: "1.5rem"
  popover:
    backgroundColor: "{colors.popover}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "0.25rem"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.sm}"
    padding: "0.25rem 0.5rem"
    typography: "{typography.ui}"
  nav-item-active:
    backgroundColor: "{colors.accent-solid}"
    textColor: "{colors.foreground}"
---

# Design System: Exocortex

## 1. Overview

**Creative North Star: "Amber Instrument"**

Exocortex is a precision instrument for thinking, not a document product. The
surface is cool graphite: dark, slightly violet, deliberately inert. The light on
it is warm. A single amber signal marks everything that is interactive or
happening. Nothing else in the interface is allowed to be a colour.

That split does the work. Because the surfaces are cold and the text is warm, the
screen reads as material with light on it rather than as grey boxes. Because
amber appears only where something is live, the eye has exactly one thing to
track. This matters more here than in most products: the primary user has ADHD
and works in long sessions, so every competing call to attention is a defect, not
a feature.

The lineage is the amber-phosphor terminal and the cockpit instrument panel, not
the neon street sign. It is terminal-adjacent without being a terminal costume.
The previous palette, saturated green on near-black, was exactly that costume and
was removed.

Register: **product**. Design serves the work. See `PRODUCT.md` for users, voice
and strategic principles.

## 2. Colors: The Amber Instrument Palette

Authored in OKLCH throughout, because the perceptually uniform lightness axis is
what makes the surface ramp read as evenly spaced steps. Values live in
`packages/ui/src/tokens.css` and are exposed to Tailwind through
`packages/ui/src/styles.css`. Frontmatter carries OKLCH rather than hex on
purpose: the project has an OKLCH-only doctrine and there is one source of truth.

### Primary

`primary` `oklch(0.78 0.150 62)` — amber. The only brand colour. It marks the
focus ring, the active page in the tree, the primary action, live job progress
and your own collaboration cursor.

`primary-foreground` `oklch(0.20 0.035 62)` sits on it at 8.8:1. `primary-text`
is the same amber used as text and icon colour on dark surfaces, at 9.2:1 on the
background.

### Secondary

There is no second brand colour, and that is the point. `secondary`
`oklch(0.26 0.013 275)` is a neutral graphite chip. `accent-solid`
`oklch(0.26 0.025 62)` is the hover surface: the same amber hue at a chroma low
enough to be felt rather than seen, so that "warm" reads as "interactive"
everywhere, not only on the primary button.

`accent-strong` `oklch(0.33 0.055 62)` is the selected surface, and it is a
separate token rather than a stronger opacity of the hover. Selection answers
"where am I", which in a retrieval-first product is the state the user reads most
often; it has to survive a glance from across the desk. Foreground text sits on
it at 10.1:1, `primary-text` at 6.0:1.

### Tertiary

Status colours are a separate system from the brand signal, never decorative:

- `destructive` `oklch(0.53 0.190 25)` — fill. `destructive-text`
  `oklch(0.72 0.150 25)` — the same red as text and icons.
- `warning` `oklch(0.84 0.140 100)` — yellow-gold, held 38 degrees of hue away
  from the amber signal so a caution never reads as a primary action.
- `success` `oklch(0.72 0.140 152)`, `info` `oklch(0.74 0.110 235)`.

`presence-1…6` are the collaboration cursors, spread across hue *and* lightness
(0.66…0.86) so they survive deuteranopia and protanopia, where hue alone
collapses. Presence 1 is the amber signal: your own cursor is the one you should
find fastest.

### Neutral

A six-step surface ramp, all at hue 275 and chroma ≤ 0.016:
`background` 0.17 → `surface` 0.20 → `card` 0.21 → `popover` 0.235 →
`muted` 0.255 / `secondary` 0.26 → `border` 0.32. Elevation is this ramp. The
foreground is warm off-white `oklch(0.93 0.008 85)` at 15.6:1.

### Named Rules

**The One Signal Rule.** Amber is used on at most ~10% of any screen and only
where something is interactive or happening. If a decorative element is amber,
the element is wrong, not the rule.

**The Fill-Is-Not-Text Rule.** `primary` and `destructive` are fill colours,
sized for dark text on top of them. `primary-text` and `destructive-text` are
their text and icon counterparts. A fill colour used as a text colour is a bug.

**The Border Weight Rule.** `border` (1.5:1) separates; it never delimits a
control. Anything the user must perceive as a boundary uses `input` or
`border-strong` (3.4:1 on card, WCAG 1.4.11).

**The Never-Only-Colour Rule.** Status, validation, presence and diff state each
carry an icon or text as well. Remove all colour and the interface still works.

**The Selected-Is-Not-Hover Rule.** Hover is `accent-solid`, selection is
`accent-strong`, and selection additionally changes weight or turns an icon
amber. A selected element that differs from a hovered one only in opacity is a
bug: pointer feedback and "you are here" are different questions.

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

### Hierarchy

| Role | Size | Weight | Tracking | Use |
| ---- | ---- | ------ | -------- | --- |
| Page title | 1.75rem | 600 | -0.02em | the document's own title field |
| Section title | 1.375rem | 600 | -0.015em | H1 inside documents |
| Subsection | 1.125rem | 600 | -0.01em | H2 |
| Sub-subsection | 0.9375rem | 600 | normal | H3 |
| Body | 0.9375rem | 400 | normal | editor content, prose |
| UI | 0.875rem | 500 | normal | buttons, labels, nav |
| Meta | 0.75rem | 400 | normal | timestamps, counts, hints |

The ratio tightens on the way down (1.27 → 1.22 → 1.20) and the last step is
carried by weight alone, so H3 and body share a size. The page title clears the
document's own H1 by a full step, because the two are different things: one names
the page, the other opens a section. A knowledge tool with 3rem headings wastes
the vertical space the content needs, but a ladder whose top two rungs are the
same size has no hierarchy at all.

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
holding the line at *values only* is what keeps this instrument typography
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

Elevation is the surface ramp, not shadow. A raised surface is a lighter step of
graphite; shadows only confirm what the colour already said.

`background` (page) → `surface` (shell chrome) → `card` (raised block) →
`popover` (floating: menus, dialogs, command palette) → `overlay` (modal scrim,
`oklch(0.11 0.008 275 / 0.72)`, darker than the page so the dimmed content reads
as pushed back rather than covered in black).

### Shadow Vocabulary

- `shadow-xs` — form fields at rest
- `shadow-sm` — cards
- `shadow-md` and above — floating surfaces only (popover, dropdown, dialog,
  command palette)

### Named Rules

**The Flat-By-Default Rule.** Surfaces are flat at rest. Depth appears when
something floats above the page or responds to state, never as ornament.

**The No-Glass Rule.** No backdrop blur. Blur on a dark UI reduces text contrast
and adds a per-frame compositing cost for a decorative effect. The modal scrim is
a flat tinted colour.

## 5. Components

Built on Base UI primitives (`@base-ui-components/react`), sourced through the
shadcn registry and adapted. One primitive library, no exceptions.

### Buttons

- **Primary** — `bg-primary` / `text-primary-foreground`, `rounded-md`, height
  2.25rem, hover `bg-primary/90`. One per screen region. If a screen has two
  primary buttons, one of them is not primary.
- **Secondary** — neutral graphite fill, for the second-most-likely action.
- **Outline** — 1px `border`, transparent fill, hover to `accent-solid`.
- **Ghost** — no chrome at rest, hover to `accent-solid`. The default for
  toolbar and icon actions; the app shell is mostly ghost buttons.
- **Destructive** — `bg-destructive`, only for irreversible actions.
- **Link** — `primary-text` with underline on hover.

Sizes: `sm` 2rem, default 2.25rem, `lg` 2.5rem, `icon` 2.25rem square, `icon-sm`
1.75rem square. All focus states use `ring-ring/50` at 3px plus the 2px
`:focus-visible` outline from the base layer.

### Cards / Containers

`rounded-xl`, `bg-card`, 1px `border`, `shadow-sm`, 1.5rem padding, 1.5rem
internal gap. Used for genuinely separable blocks: a workspace in a list, an
empty state, an error state. **Never nested.** A card inside a card means the
hierarchy is wrong.

### Inputs / Fields

`rounded-md`, transparent fill, 1px `input` border (3.4:1, perceivable),
height 2.25rem, `shadow-xs`. Focus moves the border to `ring` and adds a 3px
`ring/50`. Invalid state moves the border to `destructive` and the ring to
`destructive/20`, and is always accompanied by a message.

### Navigation

The page tree is the primary navigation: `nav-item` at `muted-foreground`,
`rounded-md`, tight 0.25rem/0.5rem padding for density. The tree recedes so the
current page can come forward: it is `accent-strong` with full-strength
`foreground`, weight 500, and an amber file icon. Hover is `accent-solid` and
never approaches it. The same three-part treatment marks the active row in the
command palette and the selected tab in the context panel, so "this one" looks
identical wherever the user meets it.

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

## 6. Do's and Don'ts

### Do:

- Reach for `packages/ui/src/components/ui` before the registry, and the registry
  before a new primitive.
- Use the surface ramp for elevation and let shadow only confirm it.
- Let amber mean one thing. Focus, active, primary, live.
- Carry every status with an icon or text as well as colour.
- Keep German for everything the user reads; English for code, logs, identifiers
  and API error codes.
- Give every animation a `prefers-reduced-motion` variant that is a complete
  experience, not a degraded one.

### Don't:

- Don't hardcode a colour. Every colour is a semantic token.
- Don't use a fill colour (`primary`, `destructive`) as a text colour.
- Don't add a second accent colour. The palette is restrained on purpose.
- Don't nest cards, and don't wrap something in a card just to group it.
- Don't use a coloured left or right border as an accent on cards, list items,
  callouts or alerts.
- Don't use gradient text, backdrop blur as decoration, or a hero-metric block.
- Don't reach for a modal first. Exhaust inline and progressive alternatives.
- Don't animate layout properties, and don't use bounce or elastic easing. Ease
  out with exponential curves.
- Don't introduce a webfont without measuring the navigation cost first.
