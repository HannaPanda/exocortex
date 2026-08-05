# UI system

## Design tokens

`packages/ui/src/tokens.css` defines every colour, radius and layout metric as a
semantic CSS variable; `packages/ui/src/styles.css` maps them onto Tailwind 4's
`@theme`. Components use utilities such as `bg-card`, `text-muted-foreground` and
`border-border` — **never** a hexadecimal value.

Base palette:

| Token | Value | Use |
| ----- | ----- | --- |
| `--background` | `#191A19` | app background |
| `--foreground` | `#E4EFCE` | body text (13.6:1) |
| `--card` / `--popover` | `#1D201D` / `#20241F` | raised surfaces |
| `--primary` | `#4E9F3D` | primary actions, filled |
| `--primary-text` | `#6FBF5C` | primary green as *text* (6.5:1) |
| `--secondary` | `#1E5128` | secondary actions |
| `--accent-foreground` | `#D8E9A8` | accent text |
| `--muted-foreground` | `#A8B994` | secondary text (8.1:1) |
| `--border` / `--border-strong` | `#304332` / `#3D5540` | separators |
| `--ring` | `#4E9F3D` | focus ring |

Contrast notes:

* the brief's `--foreground: #d8e9a8` was lightened to `#E4EFCE` so long-form text
  clears AAA rather than sitting just above AA
* `--primary` is never used for body text; `--primary-text` exists for links and
  icons and is the only green used on text
* `--presence-1…6` are the collaboration cursor colours, chosen to stay legible on
  the dark background and to remain distinguishable for common colour vision
  deficiencies

The app is dark by design. The tokens are scoped so a light theme can be added by
overriding them under `:root[data-theme='light']` without touching components.

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
   * replace Radix primitives with `@base-ui-components/react`
   * replace the `asChild`/`Slot` pattern with Base UI's `useRender` and a
     `render` prop
   * drop `dark:` variants (the tokens already encode the dark theme)
   * point `@/lib/utils` imports at the relative path
   * remove the `radix-ui` dependency the CLI adds
   * export the component from `packages/ui/src/index.ts`
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

| Path | Contents |
| ---- | -------- |
| `src/tokens.css` | semantic tokens |
| `src/styles.css` | Tailwind theme mapping, base layer, focus and scrollbar styles |
| `src/components/ui/*` | installed and adapted shadcn components |
| `src/components/layout.tsx` | `AppShell`, `AppHeader`, `AppBody`, `AppMain`, `ResizablePanel`, `SkipToContentLink` |
| `src/components/states.tsx` | `LoadingState`, `EmptyState`, `ErrorState` |
| `src/components/logo.tsx` | **LOGO PLACEHOLDER** — `ExocortexLogo`, `ExocortexWordmark` |
| `src/lib/utils.ts` | `cn()` |

Domain components (page tree, document view, AI panel) live in
`apps/web/src/components`. `packages/ui` must not collect domain components.

### Logo

`packages/ui/src/components/logo.tsx` contains a clearly marked placeholder mark.
Replace the SVG there when the real asset exists; nothing else references the logo.

## Application shell

```text
┌──────────────────────────────────────────────────────────────┐
│ Workspace / Search / Actions / Presence / Connection         │
├──────────────┬────────────────────────────┬──────────────────┤
│ Navigation   │ Document editor            │ Context / AI     │
│ page tree    │ Tiptap                     │ KI (functional)  │
│ trash        │ breadcrumb, title, actions  │ Eigenschaften    │
│              │                            │ Kommentare*      │
│              │                            │ Verweise*        │
│              │                            │ Aktivität*       │
└──────────────┴────────────────────────────┴──────────────────┘
```

`*` structure only at this stage.

Implemented: collapsible left sidebar, optional right panel, both resizable by
pointer *and* keyboard (`role="separator"`, arrow keys, Shift for larger steps),
responsive layout, a skip link, visible focus rings everywhere, a command menu
(`Ctrl/⌘ K`), context menus on tree items, dialogs, tooltips, dropdown menus,
loading/empty/error states, a route-level error boundary and a live job-progress
indicator.

Keyboard shortcuts: `Ctrl/⌘ K` command menu, `Ctrl/⌘ B` sidebar,
`Ctrl/⌘ .` context panel.

## Accessibility rules

* every icon-only control has an `aria-label`
* focus is always visible (`:focus-visible` outline in the base layer, never
  removed)
* `prefers-reduced-motion` disables animations
* live regions: `role="status"` for progress and sync state, `role="alert"` for
  errors
* the command palette is a real `combobox` + `listbox` with
  `aria-activedescendant`
* colour is never the only signal — presence also shows initials, connection state
  also shows text in its tooltip
