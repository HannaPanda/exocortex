# UI system

## Design tokens

`packages/ui/src/tokens.css` defines every colour, radius and layout metric as a
semantic CSS variable; `packages/ui/src/styles.css` maps them onto Tailwind 4's
`@theme`. Components use utilities such as `bg-card`, `text-muted-foreground` and
`border-border` — **never** a hexadecimal value.

Base palette — **"Amber Instrument"**, authored in OKLCH. Cool violet-tinted
graphite surfaces, a warm off-white foreground, and a single amber signal.
`DESIGN.md` at the repository root explains the system; this table is the
lookup.

| Token                         | Value                                               | Use                                       |
| ----------------------------- | --------------------------------------------------- | ----------------------------------------- |
| `--background`                | `oklch(0.145 0.012 275)`                            | app background                            |
| `--foreground`                | `oklch(0.94 0.016 85)`                              | body text (16.6:1)                        |
| `--surface`                   | `oklch(0.195 0.013 275)`                            | shell chrome: header, sidebar, panel      |
| `--card` / `--popover`        | `oklch(0.235 0.014 275)` / `oklch(0.275 0.015 275)` | raised and floating surfaces              |
| `--overlay`                   | `oklch(0.075 0.010 275 / 0.76)`                     | modal scrim                               |
| `--primary`                   | `oklch(0.78 0.150 62)`                              | primary actions, filled                   |
| `--primary-text`              | `oklch(0.78 0.150 62)`                              | amber as _text_ and icons (9.6:1)         |
| `--secondary`                 | `oklch(0.31 0.015 275)`                             | secondary actions, deliberately neutral   |
| `--signal-line`               | `oklch(0.44 0.050 62)`                              | structural rules, leaders, tree guides    |
| `--accent-solid`              | `oklch(0.315 0.038 62)`                             | hover surfaces, faintly warm              |
| `--accent-strong`             | `oklch(0.37 0.070 62)`                              | the selected surface (8.9:1)              |
| `--muted-foreground`          | `oklch(0.74 0.012 275)`                             | secondary text (8.6:1)                    |
| `--border`                    | `oklch(0.355 0.016 275)`                            | separation only (1.5:1 on card)           |
| `--border-strong` / `--input` | `oklch(0.56 0.016 275)`                             | perceivable boundaries (3.2:1 on popover) |
| `--ring`                      | `oklch(0.78 0.150 62)`                              | focus ring (9.6:1)                        |

Rules that fall out of the system:

- **Amber means "interactive or happening".** Focus, the active page, the primary
  action and your own cursor. Nothing decorative is amber. Keep it under roughly
  10% of any screen or it stops meaning anything.
- **Amber is a scale, not a switch.** `--signal-line` → `--accent-solid` →
  `--accent-strong` → `--primary`: structure, hover, selection, action. Only the
  last one is a colour you notice. A structural line never wears `--primary`,
  and a control never wears `--signal-line`.
- **Each surface step is 0.04 of lightness.** Below about 0.03 the eye stops
  resolving the step on a dark surface, and the ramp stops doing the work
  shadows are not allowed to do here.
- **Selected is not a stronger hover.** Hover is `--accent-solid`, selection is
  `--accent-strong`, and selection always changes something besides the surface
  as well (weight, or an amber icon). The page tree, the command palette and the
  context tabs use the same treatment, so "this one" looks the same everywhere.
- **The chrome sits above the canvas.** Header, sidebar and context panel are
  `--surface`; the document area stays `--background`. The darkest plane in the
  app is the one you write on.
- **Fill colours are not text colours.** `--primary` and `--destructive` are
  sized for dark text on top of them. Use `--primary-text` and
  `--destructive-text` when the colour is the text or the icon.
- **`--border` does not delimit a control.** It separates. Anything the user must
  perceive as a boundary (form fields, scrollbar thumbs, structural rules) uses
  `--input` or `--border-strong`, which clear WCAG 1.4.11 at 3:1.
- **Warning is not the signal.** `--warning` sits 38 degrees of hue away from
  `--primary` so a caution never reads as a primary action.
- **Content colours are not interface colours.** `--content-*` and `--content-bg-*`
  are the ten colours a _writer_ can apply to text (`packages/editor`'s `textColor`
  mark). They sit outside the amber signal system because the author chooses them,
  and a document only ever stores the colour _name_, never a value, so it stays
  theme-independent. The syntax highlighting theme is built from the same tokens.
- `--presence-1…6` are the collaboration cursor colours, spread across both hue
  _and_ lightness (0.66…0.86) so they stay distinguishable under deuteranopia and
  protanopia, where hue alone collapses. `--presence-foreground` is the label
  text on all six, at 5.7:1 or better.
- **Amber also marks events, not only places.** The caret carries `--primary`,
  and the save heartbeat (`apps/web/src/components/shell/save-indicator.tsx`)
  fires amber for `--duration-settle` when an edit reaches the server. Everything
  else that is amber means "you can act here".
- Status is never carried by colour alone; every status also has an icon and
  text.

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

## Values versus labels

`.exocortex-numeric` (mono, `tabular-nums`) is for **values**: timestamps,
counts, versions, IDs, keyboard keys, the search readout. Labels, headings and
prose stay in the sans stack. Holding that line is what makes the mono read as
instrument precision rather than as a terminal theme, which PRODUCT.md rules out
as an anti-reference.

`apps/web/src/app/layout.tsx` duplicates `--background` as the `themeColor`
viewport value. Browser chrome cannot read a custom property, so that is the one
place the value exists twice. Keep them in sync.

The app is dark by design: it is built for long writing sessions, and the cool
surface is what lets the warm foreground and the amber signal carry the
hierarchy. The tokens are scoped so a light theme can be added by overriding them
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
- focus is always visible (`:focus-visible` outline in the base layer, never
  removed)
- `prefers-reduced-motion` disables animations
- live regions: `role="status"` for progress and sync state, `role="alert"` for
  errors
- the command palette is a real `combobox` + `listbox` with
  `aria-activedescendant`
- colour is never the only signal — presence also shows initials, connection state
  also shows text in its tooltip
