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
   `@base-ui/react`; components come from the shadcn registry and are
   adapted.
8. Never commit secrets. `.env` is ignored; `.env.example` documents every
   variable.
9. Every user input is validated at runtime with the zod schemas in
   `packages/contracts`.
10. Errors are either handled or rethrown, never swallowed. An empty `catch`
    block fails lint; a comment saying why nothing is done is what makes it not
    empty.
11. **Documentation is part of the change, not a follow-up.** See the checklist
    below. `scripts/check-docs-current.mjs` is a hard gate and fails the build
    when a central document stops naming something the repository defines.
12. **UI changes follow the design system workflow in `DESIGN.md` §7**: search
    the existing system before inventing, reuse before extending, colours only
    as tokens (a hard gate refuses a literal), two plausible visual answers go
    into "Experimente" on `/design-system` instead of into the product, the
    canonical example moves with a changed contract, and `pnpm test:styleguide`
    runs before the change is finished. The rules are in `DESIGN.md`, not here.
13. The licence is **PolyForm Noncommercial 1.0.0**. Call the project _source
    available_, never _open source_. No GPL or AGPL dependency may enter `apps/`
    or `packages/`: copyleft would force the combined work to be something this
    licence cannot be. Contributions carry the grant in `CONTRIBUTING.md`.

## Documentation, and when it has to change with the code

Agents read `README.md`, `CLAUDE.md`, this file and `docs/` as their picture of
the system before touching anything. Stale documentation therefore does not just
look old, it produces wrong decisions: a README that still calls semantic search
"deferred" tells the next session to build something that has been live for
weeks (issue #58). Nobody files a bug about a paragraph, so the rule is
mechanical rather than a matter of judgement.

Change one of the things on the left, update the documents on the right **in the
same commit series**:

| If the change touches                                                            | Update                                                                                                    |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| a capability a human can use                                                     | `docs/capability-matrix.md` (regenerate), an entry in `packages/features`, the recipe doc for that area   |
| a queue, a processor, a maintenance task, a schedule                             | `docs/background-jobs.md`                                                                                 |
| a package, an application, a package boundary                                    | `README.md` layout, `CLAUDE.md` repository map                                                            |
| a process, a socket, the outbox, the event flow                                  | `docs/architecture.md`                                                                                    |
| a setting, its scope, its ceiling                                                | `docs/admin.md`, `.env.example` if it has a bootstrap fallback                                            |
| a deployment unit, a container, an nginx route, a backup                         | `deploy/README.md`                                                                                        |
| a token, a control variant, a reusable UI pattern, focus or responsive behaviour | `DESIGN.md`, its example on `/design-system`, `docs/design-system-inventory.md`, the screenshot baselines |
| a hard gate, a check in `build.sh`, the CI workflow                              | `deploy/README.md`, the command tables in `README.md` and `CLAUDE.md`                                     |
| the licence, or what a contribution may be used for                              | `LICENSE`, `CONTRIBUTING.md`, `LICENSE-GRANTS.md`, `README.md`                                            |
| a compose service or a host port                                                 | `docs/local-development.md`                                                                               |
| an MCP or AI tool                                                                | `docs/mcp.md`                                                                                             |
| a mail template, or what may send mail                                           | `docs/mail.md`                                                                                            |
| a notification occasion, a channel, a delivery mode                              | `docs/notifications.md`                                                                                   |
| a span, a trace attribute, what is recorded about a run                          | `docs/observability.md`                                                                                   |
| who may reach a page, or what a credential may reach                             | `docs/sharing.md`, `docs/security.md`                                                                     |
| where a kind of behaviour is tested, a new test suite                            | `docs/local-development.md`                                                                               |
| a decision that contradicts an ADR                                               | a new ADR in `docs/adr/`, and the ADR list in `CLAUDE.md`                                                 |
| what the product can and cannot do                                               | the "What works today" and "Not built" sections of `README.md`                                            |

Three of these are enforced and cannot be forgotten:
`scripts/check-capability-parity.mjs` and `scripts/check-feature-coverage.mjs`
for the first row -- the one asks whether all three clients reach the
capability, the other whether anybody described it in a person's words -- and
`scripts/check-docs-current.mjs` for the inventories (packages, queues,
maintenance tasks, compose services, systemd units, the documents under `docs/`)
plus a short list of claims the tree disproves. The rest is this table.

A document that describes a feature as planned, deferred or unimplemented is a
claim about today, and it ages worse than anything else in the repository.
Deleting such a sentence counts as updating it.

## Before you finish a change

```bash
bash scripts/build.sh
```

That is the one entry point: the hard gates (including the documentation gate),
the build, lint, formatting, typecheck and the tests that need no database. The
same script is all `.github/workflows/build.yml` runs, so a green run here and a
green run in CI mean the same thing — and a new check belongs in the script, not
in the workflow. The individual commands still exist while iterating:

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
```

For UI or flow changes also run `pnpm test:e2e` against a running deployment,
and `pnpm test:styleguide` for anything the styleguide shows; the checklist at
the end of `DESIGN.md` §7 is what a UI change is finished against.

Tests come in two halves, told apart by the file name and kept apart by the
test-split gate. `*.integration.test.ts` may open a database or Redis
connection and runs only under `pnpm test:integration`, which gives it a
throwaway Postgres and Redis and refuses to let it reach any other; every other test runs
under `pnpm test:unit`, which is what `build.sh` and CI run. A test that needs
infrastructure is named accordingly, and a workspace that gains tests gains the
two scripts as well — without them `turbo run test:unit` walks past it and the
tests run nowhere.

Frontend logic has two homes, and putting a case in the wrong one is how a suite
becomes slow or a bug becomes invisible: pure state and transformation logic goes
into `apps/web`'s own Vitest suite (it runs in `node`, so it never sees a DOM),
and anything that needs a browser — the editor, drag-and-drop, collaboration, a
whole page flow — stays in `e2e/`. `docs/local-development.md` has the rule and
the examples.

## Where to look first

- `README.md` — what the product does today and what it deliberately does not
- `docs/architecture.md` — how the pieces fit together, and the index to every
  subsystem's own document
- `docs/adr/` — why they fit together that way
- `docs/deviations.md` — known gaps and deliberate deviations
- `IMPLEMENTATION_PLAN.md` — the original greenfield build, finished 2026-08-04.
  A historical record of how the foundation was laid, **not** a list of what
  exists now; everything since is in the git history and in `README.md`.

## Conventions

- file names `kebab-case.ts`, React components `PascalCase`
- one exported concern per file where practical; `index.ts` re-exports the
  public surface of a package
- imports are sorted by `simple-import-sort` (`pnpm lint:fix`)
- database identifiers are `cuid(2)` and generated server-side
- every workspace-scoped operation resolves the caller's role through
  `WorkspaceAccessService` and asserts a policy from `@exocortex/auth`
