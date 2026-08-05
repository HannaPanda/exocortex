# AGENTS.md — rules for automated agents in this repository

This file applies to any coding agent (Claude Code, Codex CLI, or another).
`CLAUDE.md` contains the same rules plus Claude-Code-specific tooling notes.

## Hard rules

1. Visible UI text is **German**. Code, identifiers, comments, logs, commit
   messages and API error codes are **English**.
2. TypeScript strict mode everywhere. No `any`. If a dependency forces it,
   isolate it in one place and write a comment explaining why.
3. Respect the package boundaries in `scripts/dependency-graph.mjs`.
   `pnpm lint` fails if you break them.
4. The canonical document state is the binary Yjs update in
   `DocumentContent.yjsState`. Never treat ProseMirror JSON, HTML or Markdown as
   the source of truth, and never rebuild the Yjs state from them on load.
5. Business logic belongs in services. Controllers, WebSocket gateways and React
   components stay thin.
6. Never run Claude Code, Codex CLI or any other agent process inside `apps/api`,
   `apps/web` or `apps/collaboration`. Use `apps/worker` with an isolated sandbox.
7. Never add a second general-purpose UI component framework. Primitives come from
   `@base-ui-components/react`; components come from the shadcn registry and are
   adapted.
8. Never commit secrets. `.env` is ignored; `.env.example` documents every
   variable.
9. Every user input is validated at runtime with the zod schemas in
   `packages/contracts`.
10. Errors are either handled or rethrown, never swallowed. An empty `catch` block
    fails lint.

## Before you finish a change

```bash
pnpm lint
pnpm typecheck
pnpm test
```

For UI or flow changes also run `pnpm test:e2e` against a running deployment.

## Where to look first

* `docs/architecture.md` — how the pieces fit together
* `docs/adr/` — why they fit together that way
* `IMPLEMENTATION_PLAN.md` — what has been built and in which order
* `docs/deviations.md` — known gaps and deliberate deviations

## Conventions

* file names `kebab-case.ts`, React components `PascalCase`
* one exported concern per file where practical; `index.ts` re-exports the
  public surface of a package
* imports are sorted by `simple-import-sort` (`pnpm lint --fix`)
* database identifiers are `cuid(2)` and generated server-side
* every workspace-scoped operation resolves the caller's role through
  `WorkspaceAccessService` and asserts a policy from `@exocortex/auth`
