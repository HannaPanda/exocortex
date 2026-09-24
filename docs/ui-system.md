# UI system

This is the technical lookup. The rules and their reasons are in `DESIGN.md`;
which implementation of each component and pattern is canonical, duplicated or
still undecided is in `docs/design-system-inventory.md`. What they look like is
`/design-system`, drawn by the components themselves
(`apps/web/src/components/design-system`); a new token has to be given a role
in `foundations/token-catalog.ts` or `design-tokens.test.ts` goes red.
Undecided variants are on the same page under "Experimente" and follow the
lifecycle in the inventory (§6, "Experiment lifecycle"); product code never
imports from `design-system/experiments`. The first four (P9, P11, P12, P13)
were decided on 2026-09-24 and have left it: one focus ring from the base
layer, one `EmptyState` shape, `Table narrow="list"` plus the narrow
`SettingRow`, and no left accent borders in the editor. A styleguide example
that needs a phone-width window is drawn in an iframe onto
`/design-system/rahmen/<probe>` (`design-system/narrow/`).

## Design tokens

`packages/ui/src/tokens.css` defines every colour, radius and layout metric as a
semantic CSS variable; `packages/ui/src/styles.css` maps them onto Tailwind 4's
`@theme`. Components use utilities such as `bg-card`, `text-muted-foreground` and
`border-border` — **never** a hexadecimal value.

Base palette — **"Schiefer & Signal"**, authored in OKLCH. A mid-tone slate
sheet (`#344955`), light ink (`#E7E9EB`) and a single amber signal (`#F9AA33`).
`DESIGN.md` at the repository root explains the system; this table is the
lookup. Contrast figures are against the surface each colour appears on; the
full list is the comment at the top of `tokens.css`.

| Token                         | Value                           | Use                                         |
| ----------------------------- | ------------------------------- | ------------------------------------------- |
| `--sunken`                    | `oklch(0.270 0.029 234)`        | wells cut into the page: code, readouts     |
| `--surface`                   | `oklch(0.320 0.031 234)`        | shell chrome: header, sidebar, panel        |
| `--popover`                   | `oklch(0.355 0.032 234)`        | floating surfaces: menus, dialogs, palette  |
| `--background`                | `oklch(0.393 0.033 234)`        | the page, `#344955`                         |
| `--card`                      | `oklch(0.437 0.034 234)`        | a block raised off the page                 |
| `--overlay`                   | `oklch(0.160 0.020 234 / 0.78)` | modal scrim                                 |
| `--foreground`                | `oklch(0.933 0.003 248)`        | body text (7.7:1 on the page)               |
| `--muted-foreground`          | `oklch(0.832 0.013 240)`        | secondary text (5.6:1 on the page)          |
| `--primary`                   | `oklch(0.796 0.155 72)`         | primary actions, filled                     |
| `--primary-text`              | `oklch(0.860 0.145 74)`         | amber as _text_ and icons (4.9:1 on a card) |
| `--secondary`                 | `oklch(0.478 0.030 234)`        | secondary actions, deliberately neutral     |
| `--signal-line`               | `oklch(0.585 0.065 72)`         | structural rules, leaders, tree guides      |
| `--accent-solid`              | `oklch(0.445 0.045 72)`         | hover surfaces, faintly warm                |
| `--accent-strong`             | `oklch(0.505 0.080 72)`         | the selected surface (4.9:1 for foreground) |
| `--border`                    | `oklch(0.510 0.024 234)`        | separation only (1.4:1 on card)             |
| `--border-strong` / `--input` | `oklch(0.725 0.022 234)`        | perceivable boundaries (3.2:1 on card)      |
| `--ring`                      | `oklch(0.796 0.155 72)`         | focus ring (4.9:1 on the page)              |

Rules that fall out of the system:

- **Amber means "interactive or happening".** Focus, the active page, the primary
  action and your own cursor. Nothing decorative is amber. Keep it under roughly
  10% of any screen or it stops meaning anything.
- **Amber is a scale, not a switch.** `--signal-line` → `--accent-solid` →
  `--accent-strong` → `--primary`: structure, hover, selection, action. Only the
  last one is a colour you notice. A structural line never wears `--primary`,
  and a control never wears `--signal-line`.
- **Each surface step is at least 0.035 of lightness.** Below about 0.03 the eye
  stops resolving the step, and the ramp stops doing the work shadows are not
  allowed to do here. A new surface that cannot afford a clear step is not a new
  surface.
- **Selected is not a stronger hover.** Hover is `--accent-solid`, selection is
  `--accent-strong`, and selection always changes something besides the surface
  as well (weight, or an amber icon). The page tree, the command palette and the
  context tabs use the same treatment, so "this one" looks the same everywhere.
- **The chrome sits below the sheet.** Header, sidebar and context panel are
  `--surface` at 0.320; the page is `--background` at 0.393, the brightest large
  surface in the product, so the eye lands on the writing before anyone decides
  to look there. `--popover` is the one break in the ramp and sits _below_ the
  page: a menu belongs to the housing, not to the sheet, and climbing instead
  would push the lightest surface past the point where the amber signal still
  clears 4.5:1.
- **Fill colours are not text colours.** `--primary` and `--destructive` are
  sized for dark text on top of them. Use `--primary-text` and
  `--destructive-text` when the colour is the text or the icon.
- **`--border` does not delimit a control.** It separates. Anything the user must
  perceive as a boundary (form fields, scrollbar thumbs, structural rules) uses
  `--input` or `--border-strong`, which clear WCAG 1.4.11 at 3:1.
- **Warning is not the signal.** `--warning` sits 28 degrees of hue away from
  `--primary` so a caution never reads as a primary action.
- **Content colours are not interface colours.** `--content-*` and `--content-bg-*`
  are the ten colours a _writer_ can apply to text (`packages/editor`'s `textColor`
  mark). They sit outside the amber signal system because the author chooses them,
  and a document only ever stores the colour _name_, never a value, so it stays
  theme-independent. The syntax highlighting theme is built from the same tokens.
- `--presence-1…6` are the collaboration cursor colours, spread across both hue
  _and_ lightness (0.775…0.915) so they stay distinguishable under deuteranopia
  and protanopia, where hue alone collapses. The band sits high because every one
  of them has to clear 3:1 on `--card`. `--presence-foreground` is the label text
  on all six, at 5.7:1 or better.
- **Amber also marks events, not only places.** The caret carries `--primary`,
  and the save heartbeat (`apps/web/src/components/shell/save-indicator.tsx`)
  fires amber for `--duration-settle` when an edit reaches the server. Everything
  else that is amber means "you can act here".
- Status is never carried by colour alone; every status also has an icon and
  text.

## Radius and elevation

Four radii and four shadows, and in both cases the step is what carries the
information. Full values and reasoning in `DESIGN.md`; this is the lookup.

| Radius | Value     | Wears it                                                        |
| ------ | --------- | --------------------------------------------------------------- |
| `xs`   | 0.125rem  | a tint over text or a graphic: a diff span, a chart bar         |
| `sm`   | 0.3125rem | a mark smaller than a control: a chip, a key cap, a tree button |
| `md`   | 0.5rem    | a control: button, input, select                                |
| `lg`   | 0.75rem   | a surface: popover, dialog, sheet, card                         |

Never write a bare `rounded` (Tailwind's 4px) or `rounded-xl`. Both were in use
against no token, one pixel under `sm` and two pixels over `lg` respectively,
which is a tier nobody can see.

| Shadow      | Job                                                 |
| ----------- | --------------------------------------------------- |
| `shadow-xs` | a field at rest                                     |
| `shadow-sm` | a block raised off the page: a card, a PDF page     |
| `shadow-md` | a floating surface: menu, popover, toolbar, tooltip |
| `shadow-lg` | a modal surface: dialog, sheet                      |

All four are tokens in `tokens.css` and are tinted with the slate hue, because
a black shadow on a mid-tone page reads as dirt. There is no `shadow-xl`.

## Motion

One curve and two durations live in `tokens.css`: `--ease-out-quint`,
`--duration-fast` (120ms) and `--duration-settle` (480ms). `styles.css` maps the
curve and the fast duration onto Tailwind's `--default-transition-timing-function`
and `--default-transition-duration`, so **every `transition-*` utility in the
repository already has them**. Only reach for an explicit `duration-*` when a
transition genuinely needs a different length, and never introduce a second
easing curve.

Motion always reports a state change. No entrance choreography, no scroll
effects, no decorative movement. Reduced motion is handled globally in the base
layer, so anything that animates must also be readable while standing still.

## Type

The ladder is theme tokens in `packages/ui/src/styles.css`, so a size is chosen
by naming its role. Reach for a rung; never write `text-[0.6875rem]`.

| Utility           | Size      | Carries                       | Use                                        |
| ----------------- | --------- | ----------------------------- | ------------------------------------------ |
| `text-title`      | 1.75rem   | leading, weight 720, tracking | the name of whatever you are looking at    |
| `text-section`    | 1.375rem  | leading, weight 600, tracking | H1 inside a document                       |
| `text-subsection` | 1.125rem  | leading, weight 600, tracking | H2                                         |
| `text-body`       | 0.9375rem | leading                       | editor content, prose (H3 adds weight 600) |
| `text-ui`         | 0.875rem  | leading                       | buttons, labels, nav                       |
| `text-meta`       | 0.75rem   | leading                       | timestamps, counts, hints                  |
| `text-micro`      | 0.6875rem | size only                     | section-rule labels, key caps, chip counts |
| `text-nano`       | 0.625rem  | size only                     | avatar initials, a count inside a dot      |

Two things about the split. The top three rungs carry a full treatment because a
heading is a treatment and not a size; the rest set size and leading only, so
adopting `text-ui` somewhere never silently re-weights it. And the bottom two
set no leading at all: they live inside rows and chips whose height the row
already decides.

A page title wears `.exocortex-page-title`, which is `text-title` plus the two
things a title needs beyond its type: it breaks inside a long word rather than
leaving the page, and it balances when it wraps. Every `<h1>` in the product
uses it, with one stated exception — `projects/project-toolbar.tsx`, where the
project name sits inside a toolbar among controls.

Three arbitrary sizes survive on purpose and are not rungs: `text-[2.75rem]`
sizes an emoji glyph to its box, `text-[0.85em]` and `text-[0.7em]` are relative
because inline code and a footnote marker scale with what they sit in, and the
CodeMirror pane in `projects/project-code-editor.tsx` sizes source code rather
than interface text.

## The instrument marks

Three primitives in `packages/ui/src/components/instrument.tsx` carry the
structure of every dense screen, and they are what this product reaches for
before a card.

| Primitive               | What it is                                    | Use                                                     |
| ----------------------- | --------------------------------------------- | ------------------------------------------------------- |
| `SectionRule`           | square, label, short hairline                 | announcing a section without enclosing it               |
| `Leader`                | the dotted rule between a label and its value | inside a `flex items-baseline` row                      |
| `Readout`               | label, leader, value, optional note           | a figure and its name; the alternative to a metric tile |
| `sectionLabelClassName` | the mark's typography alone                   | a control or a sub-heading that belongs to the family   |

`SectionRule` takes a `trailing` slot for a count (set in the numeric face, and
never given a zero) and an `action` slot for something you can press. `Readout`
takes `tone="live"` for a figure about what just happened rather than what is
stored.

Do not draw the square-label-hairline by hand. It was drawn by hand in three
places, with the comment "the same mark the overview uses", and by the time
anybody compared them one was at a different tracking.

## Values versus labels

`.exocortex-numeric` (mono, `tabular-nums`) is for **values**: timestamps,
counts, versions, IDs, keyboard keys, the search readout. Labels, headings and
prose stay in the sans stack. Holding that line is what makes the mono read as
instrument precision rather than as a terminal theme, which PRODUCT.md rules out
as an anti-reference.

`apps/web/src/app/layout.tsx` duplicates `--background` as the `themeColor`
viewport value. Browser chrome cannot read a custom property, so that is the one
place the value exists twice. Keep them in sync.

The app is dark by design: it is built for long writing sessions, and the slate
surface is what lets the light foreground and the amber signal carry the
hierarchy. It is a mid-tone rather than a near-black, so the interface is dark
without hiding. The tokens are scoped so a light theme can be added by overriding them
under `:root[data-theme='light']` without touching components.

## Component workflow (mandatory)

1. **Search first.** `packages/ui/src/components/ui` and
   `packages/ui/src/components`. If it exists, use it.
2. **Search the registry through MCP.** The shadcn MCP server is configured in
   `.mcp.json` and runs with `-c packages/ui`:
   `get_project_registries`, `list_items_in_registries`,
   `search_items_in_registries`, `view_items_in_registries`,
   `get_item_examples_from_registries`, `get_audit_checklist`.
3. **Read the docs:** `pnpm dlx shadcn@4.16.1 docs <component>`.
4. **Install with the official CLI:**
   ```bash
   cd packages/ui
   pnpm dlx shadcn@4.16.1 add <component>
   ```
5. **Adapt the installed source:**
   - replace Radix primitives with `@base-ui/react`
   - replace the `asChild`/`Slot` pattern with Base UI's `useRender` and a
     `render` prop
   - drop `dark:` variants (the tokens already encode the dark theme)
   - point `@/lib/utils` imports at the relative path
   - remove the `radix-ui` dependency the CLI adds
   - export the component from `packages/ui/src/index.ts`
6. **Preserve accessibility behaviour.** Keyboard navigation, focus management,
   `aria-*` and `role` come from the primitive; keep them.
7. **Only write a custom primitive when no suitable option exists**, and say why in
   a file comment (see `layout.tsx` for `ResizablePanel`).

### Checklist for third-party registry components

License (MIT or compatible), accessibility, dependency quality, Base UI
compatibility, React 19 / Next 16 compatibility, no external services at runtime,
readable code. Registry components are **source suppliers only** — the repository
owns the code and nothing is fetched at runtime.

## What is where

| Path                            | Contents                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/tokens.css`                | semantic tokens                                                                                 |
| `src/styles.css`                | Tailwind theme mapping, base layer, focus and scrollbar styles                                  |
| `src/components/ui/*`           | installed and adapted shadcn components                                                         |
| `src/components/ui/toolbar.tsx` | custom primitive: `role="toolbar"` with a roving tabindex, on Base UI                           |
| `src/components/layout.tsx`     | `AppShell`, `AppHeader`, `AppBody`, `AppMain`, `AppPage`, `ResizablePanel`, `SkipToContentLink` |
| `src/components/instrument.tsx` | `SectionRule` (the section mark), `Leader` (the dotted leader)                                  |
| `src/components/states.tsx`     | `LoadingState`, `EmptyState`, `ErrorState`                                                      |
| `src/components/logo.tsx`       | `ExocortexLogo` (square mark), `ExocortexWordmark` (full lockup)                                |
| `src/assets/*.svg`              | the brand assets the two components are inlined from                                            |
| `src/lib/utils.ts`              | `cn()`                                                                                          |

Domain components (page tree, document view, AI panel) live in
`apps/web/src/components`. `packages/ui` must not collect domain components.

### Logo

`packages/ui/src/components/logo.tsx` exports the two brand marks and is the only
place that draws them:

- `ExocortexWordmark` is the full lockup (mark plus wordmark, about 3.4:1). It has
  no intrinsic width, so size it by height — `h-8` by default.
- `ExocortexLogo` is the same mark cropped square, for tight spots.

Both inline their path data from `packages/ui/src/assets`, which holds the
canonical brand files: `exocortex-logo.svg` and `exocortex-mark.svg` carry dark
ink for light surfaces, `*-dark.svg` light ink for dark ones. The four files share
one geometry and differ only in the colour of the ink, so the components inline
the geometry once and let the ink follow `currentColor`. That makes the theme
switch the logo in CSS: there is no JavaScript state that could flash the wrong
variant while the page hydrates. The amber stays fixed at `#FD922F`, the one
hardcoded colour in the design system.

The browser tab icon is `apps/web/src/app/icon.svg` and the home-screen icon is
`apps/web/src/app/apple-icon.png` (Next.js picks both up by file name). The tab
icon drops the four synapse stems of the mark on purpose: they blur below 32px,
and the amber X is what carries the brand at that size.

If the assets are ever redrawn, run them through SVGO before checking them in —
the traced paths shrink by about 60%.

## Application shell

```text
┌──────────────────────────────────────────────────────────────┐
│ Workspace / Search / Actions / Presence / Connection         │
├──────────────┬────────────────────────────┬──────────────────┤
│ Navigation   │ Document editor            │ Context / AI     │
│ page tree    │ Tiptap                     │ KI (functional)  │
│ trash        │ breadcrumb, title, actions  │ Eigenschaften    │
│              │                            │ Kommentare       │
│              │                            │ Verweise         │
│              │                            │ Aktivität*       │
└──────────────┴────────────────────────────┴──────────────────┘
```

`*` structure only at this stage.

Implemented: collapsible left sidebar, optional right panel, both resizable by
pointer _and_ keyboard (`role="separator"`, arrow keys, Shift for larger steps),
responsive layout, a skip link, visible focus rings everywhere, a command menu
(`Ctrl/⌘ K`), context menus on tree items, a draggable page tree, dialogs,
tooltips, dropdown menus, loading/empty/error states, a route-level error boundary
and a live job-progress indicator.

Keyboard shortcuts: `Ctrl/⌘ K` command menu, `Ctrl/⌘ B` sidebar,
`Ctrl/⌘ .` context panel. On a page-tree row, `Alt ↑/↓` moves it among its
siblings and `Alt →/←` changes which page it belongs to.

### The topbar on a narrow screen

The bar has a fixed part and a part that gives way, and the order is written
into the classes rather than measured at runtime. Giving way, in this order:
the workspace name (`min-w-0 shrink` plus `truncate`, so it shortens and stays
readable), then the search field (`w-40` until `lg`, truncating). Never giving
way: the icon buttons and the right-hand group, which carries `shrink-0`.

Below `lg` the deployment-wide links (`global-links.tsx`) stop being a row of
icons and become one button that opens a menu carrying the same entries with
their words, signing out included. Above `lg` nothing changes. Both shapes are
in the markup and one is hidden by a media query: a width the client measures
would make the first painted frame the wrong one, and this bar is the first
thing on screen.

Two rules follow from issue #100, where ten icons at 360 CSS pixels simply hung
out of the viewport. A new deployment-wide surface goes into that list and
nowhere else in the bar, so the row cannot grow again. And a count that the row
shows without being opened has to survive the collapse: the dot moves onto the
menu button, because a hint hidden inside a menu is a hint nobody gets.

### The page tree

Rows are dragged with native HTML5 drag and drop (deviation 23). The row under
the pointer has three zones: the top and bottom quarters mean "between", drawn as
an amber line on that edge, and the middle half means "into", drawn as an amber
ring around the row. A folded row that is hovered for 700ms opens under the
pointer, and a drop area appears at the end of the list while a nested page is
being dragged, because otherwise a page three levels down can be dragged onto any
row but never simply out.

Order is never computed here. The client names the sibling to land before or
after and the server turns that into a fractional `orderKey`. The one exception to
the app's "no optimistic updates" rule lives in `useMoveDocument`: a dragged row
that snaps back for a round trip reads as a drag that failed.

### The symbol picker

`PageIconPicker` offers every emoji (1,914) and every Lucide icon (1,756), but
opens on neither. What is on screen before anyone types is the curated shortlist
in `DOCUMENT_ICON_NAMES` / `CURATED_EMOJI_GROUPS` and the symbols this browser
picked last; the rest is reached by searching or by scrolling into "Alle Symbole".
German search words for icons that only have an English name live in
`icon-search.ts`.

Both datasets are loaded through a dynamic `import()` when the picker opens, never
in the first bundle. `DocumentIcon` keeps a static component map of the curated
icons so a freshly loaded page tree paints without waiting for anything.

## Editor chrome

The editor's own surfaces live in `apps/web/src/components/editor` and are listed in
`docs/editor-extensions.md`. Three rules hold there:

- **the block catalog is the single source.** The slash menu, the "Umwandeln in"
  menu and the block action menu all read `buildBlockCatalog()`; none of them keeps
  its own list.
- **floating chrome is React, in-document rendering is not.** Menus and toolbars are
  React components here; node views that render inside the document are plain DOM in
  `packages/editor`, so the schema stays usable without a DOM on the server.
- **`useEditor` does not re-render on every transaction** in Tiptap 3. Anything that
  shows editor state (a pressed formatting button, the current block type) subscribes
  with `useEditorState` and one selector for the whole surface, not one per control.

### The interaction gutter

Everything the editor puts left of a block shares one reserved strip, defined in
`globals.css` on `.exocortex-page` and split into two lanes:

```text
[ + ][ ⋮⋮ ]   [ ▾ ] Überschrift
└── handle ──┘ └ collapse ┘
```

`--gutter-collapse` is the inner lane and belongs to the disclosure button of a
collapsible heading, which sits right beside the text. `--gutter-handle` is the
outer lane, and `block-handle.tsx` positions the drag handle into it by giving
floating-ui an `offset` of exactly the inner lane. That offset is the whole
reason the two controls no longer cover each other (issue #88); a `z-index`
would have settled which one is drawn on top without moving either.

The sum is reserved as real page padding rather than borrowed from the margin
around the reading measure, because there is no margin left on a `wide` or
`full` page with both side panels pulled open: the handle then ended up under
the navigation or was cut off by `AppMain`, which clips on purpose. The padding
grows outside the measure and symmetrically, so reserving it neither narrows the
text nor pushes the column off centre, and it collapses back to the plain
`--page-pad` once the editor column gets too narrow to give the text 20rem. For
that case, and for it only, the handle carries floating-ui's `shift` as a safety
net, which keeps it inside its clipping ancestors.

## Accessibility rules

- every icon-only control has an `aria-label`
- focus is always visible and looks the same everywhere: the 3px
  `ring-ring/50` ring from `:focus-visible` in the base layer, `ring-inset`
  where a container clips, a `CanvasText` outline under forced colours; never
  removed, and no second shape (P11)
- `prefers-reduced-motion` disables animations
- live regions: `role="status"` for progress and sync state, `role="alert"` for
  errors. A refusal that appears in place of nothing is an alert, not a status
- **a field owns its help text and its refusal.** Both get an `id` and the
  control points at them with `aria-describedby`; an invalid control also
  carries `aria-invalid`, which is what draws the red border on `Input`,
  `Textarea`, `Checkbox` and `SelectTrigger`. A paragraph that merely sits after
  the control is a paragraph a screen reader never connects to it.
  `settings/setting-row.tsx` is the worked example: one `described` object, six
  control branches. Where the refusal moves focus to the offending field, the
  message carries no `role="alert"` as well — focusing the control already reads
  its description, and an alert per field would say it twice
- **a `<th>` says what it heads.** `TableHead` sets `scope="col"` by default;
  a row header passes `scope="row"`. Without it a screen reader guesses, and
  every table in the administration and settings areas inherits the guess
- **a tooltip is a hover affordance.** On a device with no hover it is hidden,
  because a tap opens it through focus and nothing closes it again. The name
  lives on the control's `aria-label`, not in the tooltip. The exception opts in
  with `onTouch="show"`, and there is one: `TruncatedText`, which hands over the
  half of a title the row cut off
- **a control revealed by hover is revealed by focus and by touch too.**
  `opacity-0 group-hover:opacity-100 focus-visible:opacity-100
pointer-coarse:opacity-100`, never `invisible`: `visibility: hidden` takes the
  control out of the tab order, so it stops existing for a keyboard and for a
  phone alike. The one exception is a control inside a composite widget, where
  the widget owns the tab stop and the command has a second way in — see the
  tree below
- **a composite widget hands out one tab stop.** The page tree is a WAI-ARIA
  `tree`: `role="tree"` on the list, `role="treeitem"` on each `<li>` (which is
  what owns the nested `role="group"`), one item with `tabIndex={0}` and the
  rest at `-1`. `use-tree-keyboard.ts` answers the arrows, Home and End, Enter,
  and Shift + F10 for the row's menu; `Alt` plus an arrow stays the keyboard
  half of dragging and is checked first. A treeitem states its name with
  `aria-label`, or the name would be composed from the four labels inside the
  row. The three buttons in a row are pointer shortcuts with `tabIndex={-1}`,
  and every command they carry is in the row menu, which is the only reason
  taking them out of the tab order is allowed at all. A treeitem sits inside
  its parent's, and React's focus and key events bubble, so each row's handler
  stops them; otherwise the ancestors claim the tab stop after the child did
- **text on `bg-muted` is `text-foreground/90`, never `text-muted-foreground`.**
  That pair measures 3.9:1 and fails AA; the tab track, the muted badge, the
  avatar fallback and the embed header all had it until the axe scan found them
- the command palette is a real `combobox` + `listbox` with
  `aria-activedescendant`
- colour is never the only signal — presence also shows initials, connection state
  also shows text in its tooltip

## Regression gate

The styleguide is also the test surface (issue #127). `pnpm test:styleguide`
runs in `build.sh --full-tests`, and therefore in CI, against the fresh web
build:

- **screenshots** of a curated set of canonical examples at 1280 px and, where a
  pattern has its own breakpoint contract, at 390 px
  (`e2e/styleguide/visual.spec.ts`). A section needs a shot when it carries a
  decision somebody would be unhappy to lose, not because it exists
- **axe** against WCAG 2.2 A and AA on the whole page at both widths, on the
  phone-width frames and on an open dialog, with the exceptions listed and
  reasoned in `a11y.spec.ts`
- **keyboard smoke tests**: a dialog takes, keeps and returns focus; a menu opens
  from the keyboard and returns focus; the tree keeps one roving tab stop; the
  hover-only row actions open with Shift + F10; every stop of the focus example
  draws the ring

A changed screenshot is a difference to review. When it was meant, the new
baseline is committed on its own with the decision it records;
`docs/local-development.md` has the commands. `impeccable detect` stays a manual
check beside it: it finds patterns in code, the screenshots find what changed
on screen, and neither replaces the other.
