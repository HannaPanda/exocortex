# ADR-001: Monorepo structure

* Status: accepted
* Date: 2026-08-04

## Context

eXocortex is four cooperating processes (frontend, API, collaboration server,
worker) that share contracts, an editor schema, a database schema and a design
system. Splitting them into separate repositories would make every contract change a
multi-repository release; keeping everything in one application would couple the
editing hot path to the REST API.

## Decision

A single pnpm workspace orchestrated by Turborepo, with `apps/*` as composition
roots and `packages/*` as libraries. Dependencies between packages are declared
explicitly in `scripts/dependency-graph.mjs` and enforced twice:

* `scripts/check-dependency-boundaries.mjs` validates every package manifest and
  detects cycles (run first by `pnpm lint`),
* `no-restricted-imports` in `eslint.config.mjs` blocks the import at source level.

The graph is layered: `config`, `logger`, `contracts`, `editor`, `ui` are leaves;
`database`, `storage`, `queue`, `ai` are infrastructure; `auth` builds on `database`;
apps compose. `apps/web` may only depend on `ui`, `editor` and `contracts`.

## Consequences

* A contract change is one commit and one CI run.
* The browser bundle cannot import Prisma, BullMQ, the S3 client or the logger — the
  check fails the build.
* Turborepo caches per package, so a change in `packages/ui` does not rebuild the
  API.
* New packages must be added to the graph deliberately, which keeps the architecture
  visible rather than emergent.
