# ADR-002: shadcn/ui components on Base UI primitives

* Status: accepted
* Date: 2026-08-04

## Context

The application needs an owned, auditable component layer: no runtime registry
dependency, no second general-purpose UI framework, full control over styling and
accessibility. The brief requires shadcn/ui as the component source and Base UI as
the primitive layer.

## Decision

shadcn/ui is the source-code supplier; components are installed with the official
CLI into `packages/ui` and then adapted. Base UI (`@base-ui-components/react`) is the
only primitive library.

The public shadcn registry currently ships Radix-based sources and no Base UI
registry was reachable, so adaptation is part of the workflow rather than optional:

* `Slot`/`asChild` becomes Base UI's `useRender` with a `render` prop,
* interactive components (dialog, menu, tooltip, tabs, scroll area, separator,
  context menu, avatar) are written directly against Base UI,
* the `radix-ui` dependency the CLI adds is removed again.

## Consequences

* The repository owns every component file; nothing is fetched at runtime.
* One primitive library means one set of accessibility semantics and no duplicated
  focus-management logic.
* Upgrading a shadcn component is a deliberate re-install plus re-adaptation, not an
  automatic dependency bump. The workflow is documented in `docs/ui-system.md`.
* `Button` uses `render` instead of `asChild`. This differs from upstream shadcn and
  is documented at the call site.
