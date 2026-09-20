# Design and UX review, 2026-09-20

A snapshot of the interface as it stands, taken before any redesign work. It
exists to separate three things that get confused when an interface is called
"generic": what the design system already decides and holds, where the code has
drifted away from decisions the system already made, and where the system is
silent so every screen decides for itself.

Nothing here is a change. The priorities at the end are proposals, and the
branding questions are deliberately left open.

## How this was measured

- `impeccable detect` (the mechanical detector shipped with the impeccable
  skill, 61 rules) over `apps/web` and `packages/ui`.
- Counts over the 238 `.tsx` files in `apps/web/src` and `packages/ui/src`.
- Reading: `packages/ui/src/tokens.css`, `styles.css`, `apps/web/src/app/globals.css`,
  the shell, the panels, the database views, the admin and settings surfaces,
  and the shared state components.

Counts are from 2026-09-20 and will drift; each finding names the file, so the
number can be recounted rather than believed.

## What already holds

This is not a codebase that needs rescuing from generic UI, and the review is
only readable if that is said first.

- **The detector finds two warnings in 238 components.** Both are left accent
  borders (below). No gradients, no backdrop blur, no glass, no hero metrics,
  no colour outside the tokens in any component.
- **Ten `<Card>` uses in the whole application**, all on authentication screens
  and the admin overview. Lists are lists; the "card around everything" reflex
  is absent.
- **Colour is genuinely centralised.** Every component colour resolves to a
  semantic token; the only hex values outside `tokens.css` and `logo.tsx` are
  `themeColor` in `app/layout.tsx` and the offline page (see D1).
- **The three states are shared, not re-invented**: 61 `EmptyState`, 74
  `LoadingState` (44 of them skeletons rather than spinners), 45 `ErrorState`,
  against six hand-written "nothing here" paragraphs.
- **The product has its own vocabulary.** `SectionRule` and `Leader`
  (`packages/ui/src/components/instrument.tsx`) announce a section and carry a
  label to its value without a box, and `.exocortex-numeric` gives every count
  and timestamp tabular figures. This is the opposite of interchangeable.
- **The workspace overview refuses the dashboard.** It lists recency and loose
  ends rather than page counts, in sections with no cards
  (`apps/web/src/components/shell/workspace-overview.tsx`).

The rest of this document is about the gap between that and what is on screen.

## Findings

### A. Typography: the ladder is documented and not installed

**A1. The page title has four treatments.** 26 `<h1>` elements, of which 5 use
`.exocortex-page-title`. The rest: 16 `text-lg font-semibold`, 4 `text-xl
font-semibold`, one `text-2xl font-semibold`, one `text-sm font-medium`.
`DESIGN.md` states the opposite as already true: "used by every page title in
the product ... Those used to be two different sizes for the same question."
The consequence is not ugliness, it is that most screens have no typographic
anchor: a page reads as a panel that happens to be wide.

**A2. Section headings inside the chrome have eight treatments.** 12 `text-sm
font-medium`, 10 `text-base font-semibold`, 5 `text-sm font-semibold`, plus
four one-offs. Nothing tells a reader which of two headings outranks the other,
because the answer differs per panel.

**A3. There is an undocumented micro tier, and the design system itself uses
it.** 41 arbitrary font sizes: `text-[0.6875rem]` 25 times, `text-[0.625rem]`
7 times, then 11px, 0.8rem, 10px, 0.65rem. `SectionRule` is one of them
(`instrument.tsx:43`). The ladder in `DESIGN.md` stops at Meta 0.75rem, so
anything smaller has no token to reach for and each site invents one.

**A4. The ladder is prose, not tokens.** `DESIGN.md` defines Body 0.9375rem,
UI 0.875rem, Meta 0.75rem; `styles.css` exposes no font-size scale, so the
application reaches for Tailwind's defaults instead: `text-xs` 303 times,
`text-sm` 237. Two of the three rungs happen to coincide, which is why this has
stayed invisible, and A3 is what it costs.

### B. Hierarchy and structure

**B1. The admin overview is the dashboard the product rejects.** Eight
identical metric cards in a `sm:grid-cols-2 lg:grid-cols-3` grid, each with a
`text-2xl` number, all weighted the same
(`apps/web/src/components/admin/overview-cards.tsx`). `PRODUCT.md` lists
"dashboard grids of identical tiles" under anti-references, and the workspace
overview 400 lines away answers the same "how is it going" question with
sections, rules and leaders. Two overviews, two philosophies, and the generic
one is the one a new administrator sees first.

**B2. The instrument vocabulary is half adopted.** `SectionRule` appears in 4
files (12 uses). At least three other places re-implement its exact typography
inline -- `page-tree.tsx:602`, `properties-panel.tsx:242`,
`activity-panel.tsx:425` -- and the last uses `tracking-[0.12em]` where the
component uses `0.14em`. A mark that is copied rather than imported has stopped
being a system.

**B3. The empty and error states are the centred, icon-above-text pattern.**
`states.tsx` centres both, with the icon first, the title second, the
description third and an outline button last. That is the most reproduced empty
state on the web, in a product whose every other surface is left-aligned and
dense. It is also the cheapest thing to change well: 106 instances inherit from
two components.

### C. Radius and elevation

**C1. Three radius tokens, six values in use.** `--radius-sm` 0.3125rem,
`--radius` 0.5rem, `--radius-lg` 0.75rem are defined. The code also uses
`rounded` 13 times (Tailwind's 0.25rem, below the smallest token) and
`rounded-xs` 5 times (0.125rem), neither of which is in the system. And
`rounded-xl`, which `DESIGN.md` documents as 0.875rem, has no token: it falls
back to Tailwind's 0.75rem, so `Card` and a popover share a radius although the
system says they do not.

**C2. Elevation has a documented vocabulary and no tokens.** `DESIGN.md` §4
assigns `shadow-xs` to fields, `shadow-sm` to cards, `shadow-md` and above to
floating surfaces. In the code: `shadow-lg` 12, bare `shadow` 7, `shadow-xs` 5,
`shadow-sm` 3, `shadow-xl` 2, `shadow-md` 1. Bare `shadow` and `shadow-xl` are
outside the vocabulary, and all of them are Tailwind's black-based shadows on a
mid-tone slate surface, where a shadow tinted with the background hue would
read as a layer rather than as dirt.

**C3. `Card` is the one primitive that was never adapted.** It is the shadcn
default: `rounded-xl border bg-card py-6 gap-6 px-6 shadow-sm`
(`packages/ui/src/components/ui/card.tsx`). 24px padding and a 24px gap in a
product whose principle is "density over padding when the two conflict". Its
ten uses are the authentication screens and the admin overview, which is
exactly where the product looks least like itself.

### D. Colour and brand

**D1. The offline page still wears the retired palette.** `apps/web/public/sw.js`
paints `#0e0f14` on `#fd922f` in `system-ui` -- the near-black-and-orange scheme
that was replaced -- while its own comment claims "The values match
`--background` and `--foreground`". They do not: the brand is `#344955` and
`#F9AA33`. It is the only user-visible surface off-brand, and the comment above
it is why nobody noticed.

**D2. Two left accent borders, and the project forbids them.** The detector's
only two warnings: `.exocortex-commented` (`globals.css:169`, a warning-coloured
left rule on a commented block) and `.exocortex-transclusion`
(`globals.css:591`, `border-l-accent-foreground/30` on a bordered frame).
`DESIGN.md` says "Don't use a coloured left or right border as an accent on
cards, list items, callouts or alerts." The comment decoration has a real
argument -- it marks a run of prose, not a card -- and the transclusion frame
does not. Either way the rule and the code should stop disagreeing.

### E. Controls and interaction

**E1. Two controls exist only under a mouse pointer.**
`page-tree-row.tsx:220` renders the "create a child page" button as `invisible
... group-hover:visible`: `visibility: hidden` takes it out of the tab order, so
the control is unreachable by keyboard and invisible on touch.
`project-file-tree.tsx:186` uses `opacity-0 group-hover:opacity-100` with no
`focus-visible` fallback, so it is focusable but invisible while focused. The
other six hover-reveals in the application do this correctly, with
`focus-visible:` and `pointer-coarse:` -- these two were missed.

**E2. The header weighs four actions the same.** Navigation toggle, capture,
context toggle and the account menu are all ghost `icon-sm` buttons in a row.
Capture (Strg+E) is a daily writing action; the other two are furniture. Every
one of them carries an `aria-label` and a tooltip with its shortcut, so this is
a question of visual priority, not of accessibility.

**E3. Focus is stated in two vocabularies.** `styles.css` gives everything a 2px
`--ring` outline at 2px offset; 10 interactive primitives set `outline-none`
and draw a 3px `ring-ring/50` instead (26 `outline-none` sites in total). Both
are visible and both pass. But "focus states are part of the contract" is a
single promise shown two ways, and the ring and the outline do not align on a
control that sits inside a tight row.

### F. Forms

**F1. An error is visible but not attached to its field.** 123 `<Label>` uses
against 3 `aria-invalid` and 1 `aria-describedby`. The pattern everywhere is a
loose `<p className="text-xs text-destructive-text">` after the control, which a
screen reader never associates with the input and a keyboard user reaches only
by accident. Two of them use `role="status"` where `role="alert"` belongs
(`page-cover.tsx:222`, `:462`).

### G. Density and responsive behaviour

**G1. Responsiveness lives in the shell and almost nowhere else.** 22 of 205
components in `apps/web/src` carry a breakpoint prefix (29 `sm:`, 20 `md:`, 13
`lg:`, 2 `xl:`), plus four container queries. The shell handles the phone well:
below 768px the panels become sheets rather than stealing width. But the dense
surfaces inside it -- the database table, the admin tables, the settings forms
-- have no breakpoint treatment at all and simply scroll sideways.

**G2. The smallest touch targets are `size-7`.** 28px meets WCAG 2.5.8 (24px)
and is small for a finger. Combined with E1 this is where the phone actually
hurts: the controls that are hardest to hit are the ones that only appear on
hover.

### H. The context the design skills read

**H1. `PRODUCT.md` describes a palette that no longer exists.** Line 70 says
"The current palette falls into this trap and is being replaced", about
saturated green on near-black. That palette was replaced; `DESIGN.md` documents
the slate and amber system that followed. `impeccable` reads `PRODUCT.md`
before every design task, so this one stale sentence is the highest-leverage
defect in this document: it would start the next redesign from a false premise.

## Priorities

Effort is for one focused session per item, tests and review included.

### P1 -- the system says one thing and the code says another (about a day)

1. **Correct `PRODUCT.md` line 70** so the design skills stop reading a retired
   palette as current. Ten minutes, and everything else depends on it. (H1)
2. **Install the type ladder as theme tokens** (`text-title`, `text-section`,
   `text-body`, `text-ui`, `text-meta`, and a named micro tier for the 0.6875rem
   the instrument marks already use), then adopt `.exocortex-page-title` on all
   26 `<h1>`. This removes 41 arbitrary sizes and four competing title
   treatments, and it is mechanical. (A1--A4)
3. **Fix the two hover-only controls and wire form errors to their fields**
   (`aria-invalid`, `aria-describedby`, `role="alert"`). (E1, F1)
4. **Repaint the offline page** in the current brand and correct its comment.
   (D1)

### P2 -- where the product stops looking like itself (two to three days)

5. **Rebuild the admin overview** in the vocabulary the workspace overview
   already uses: sections, rules, leaders, tabular figures, and a stated
   ranking instead of eight equal tiles. (B1)
6. **Close the radius and elevation system**: define or delete `--radius-xl`,
   replace bare `rounded`/`rounded-xs`, and decide whether shadows become
   slate-tinted tokens or a documented use of three Tailwind steps. (C1, C2)
7. **Adapt `Card` to the system** -- density, radius, and whether it keeps its
   border on a surface ramp that already says where a layer sits -- or retire it
   on the seven screens that use it. (C3)
8. **Finish adopting `SectionRule`** in the three panels that re-implement it,
   and decide the second heading tier explicitly. (B2, A2)

### P3 -- needs a decision before it needs code

9. **The shape of an empty state.** Left-aligned and action-first suits a dense
   tool better than centred and icon-first, but it changes 106 places at once
   and should be designed on two real screens before it is generalised. (B3)
10. **Action priority in the header**, and whether capture earns a different
    weight from the panel toggles. (E2)
11. **One focus vocabulary**, ring or outline. (E3)
12. **A responsive strategy for dense surfaces**: what a table, a settings form
    and the admin tables do on a phone beyond scrolling sideways. (G1, G2)
13. **The two left accent borders**: keep the commented-block rule as a stated
    exception, or change both. (D2)

### Deliberately not decided here

The brand is not finished, and this review does not finish it. Left open: the
typefaces (Inter and JetBrains Mono are installed and self-hosted, and nothing
in this review depends on keeping them); whether the amber stays the only
accent; whether a light theme is built at all; and what the top of the type
ladder looks like if the product ever gets a display face. Those belong in a
direction, not in a defect list.

## Regression baseline

`impeccable detect` is the cheap way to keep this from coming back:

```bash
"$(ls -d ~/.claude/plugins/cache/impeccable/impeccable/*/skills/impeccable/scripts)/impeccable" \
  detect --json apps/web packages/ui
```

On 2026-09-20 it reports 2 warnings (D2) and 45 advisories (41 of them A3, four
of them D1). Any redesign should leave both numbers lower, and the advisories
are the ones the type tokens in P1 delete outright.
