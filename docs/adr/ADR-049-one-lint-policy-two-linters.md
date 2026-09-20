# ADR-049: one lint policy, two linters, and the config is generated

- Status: accepted
- Date: 2026-09-20

## Context

Issue #84 asks for oxlint as the primary linter. The usual argument for that is
speed, and the speed is real: ESLint took 32 seconds to walk this repository,
oxlint takes under one. But speed on its own would not be worth touching the one
thing that enforces rule 4, rule 7 and the size policy from issue #40, so the
question is what the change does to the policy rather than to the clock.

Three facts shaped the answer.

**oxlint covers almost all of it, and "almost" is the interesting part.**
Comparing every rule ESLint had switched on against oxlint's 870 rules leaves
five that have no equivalent: `simple-import-sort`'s two rules, whose grouping
(`node:`, third party, `@exocortex/*`, aliases, relative) is the whole point of
using it; `no-restricted-syntax`, which needs an AST selector language oxlint
does not have; `react/no-deprecated`; and
`@next/next/no-location-assign-relative-destination`. Everything else — the
recommended sets, the size ratchets, the TypeScript rules, the React and Next.js
rules, and the package boundaries — is there under a different name.

**The boundaries are a list, not a rule.** `no-restricted-imports` in
`eslint.config.mjs` was built at load time from `scripts/dependency-graph.mjs`,
because a JavaScript config file can import one. oxlint reads JSON. A JSON file
with the graph copied into it is a second copy of the one list this repository
is careful to keep single.

**oxlint's `correctness` category is not ESLint's recommended set.** It is
narrower in places (nine rules from `eslint:recommended` and six from
`typescript-eslint`'s are off by default) and wider in others (it found 23
things ESLint had never looked for). Neither direction is safe to accept
silently.

## Decision

**One policy expressed in two files, and each says why it is not in the other.**
`.oxlintrc.json` carries everything oxlint can express. `eslint.config.mjs`
carries the five rules it cannot, with a comment per rule explaining what is
missing — so the day oxlint grows it, the entry and its plugin go. ESLint keeps
a parser and nothing else: `@babel/eslint-parser` instead of the
`typescript-eslint` meta package, and `@eslint/js`, `eslint-config-prettier` and
`eslint-plugin-react-hooks` are removed with the rules they carried. (The parser
was `@typescript-eslint/parser` until issue #85; the rule set had already gone,
and the parser followed it out because it loads the `typescript` package for a
compiler API that TypeScript 7 does not ship. Babel parses TypeScript itself and
so has no opinion about which compiler is installed — which is the property that
matters here: the linter must not be able to hold the compiler back.)

**`.oxlintrc.json` is generated, never authored.** The policy lives in
`scripts/generate-oxlint-config.mjs`, in JavaScript, where it can carry its
reasons and import the dependency graph — the same place the ESLint config read
it from. The JSON is a build product like `docs/capability-matrix.md`.

**The staleness check belongs to the boundary gate, not to a new one.**
`check-dependency-boundaries.mjs` already exists to keep the manifest half and
the import-site half of rule 4 reading one list. It now also runs
`generate-oxlint-config.mjs --check`, because a `.oxlintrc.json` that has not
been regenerated is precisely that gate asking last week's question.

**Every plugin is enabled repository-wide.** oxlint resolves `categories`
against the base plugin list, so a plugin that first appears in an override
contributes its explicitly named rules and none of its category ones. Scoping
`nextjs` to `apps/web` the way `eslint.config.mjs` did made
`nextjs/no-img-element` stop firing without saying so. A React rule needs JSX or
a hook call to have anything to say, so enabling them everywhere costs one
exemption (`nextjs/no-assign-module-variable` over `scripts/`) and no false
confidence.

**Both linters run from the root, and `pnpm lint` is still the one entry
point.** The per-package `eslint src` scripts and the `lint` task in
`turbo.json` are gone. They lint less than the root run does — the root scripts,
the deploy helpers, `apps/api/scripts` and `e2e` were never in any of them — and
they made linting wait for `^build`.

## Consequences

- `pnpm lint` over the whole repository: 32.3 s before, 12 s after (0.9 s of
  oxlint and 11.1 s of ESLint), and no build first.
- The lint policy is now covered by `scripts/gates.test.ts` the way the hard
  gates are: eight cases that each write a violation and expect the right
  linter to refuse it, including the NestJS constructor exemption, which is the
  one whose failure mode is "weaken the rule".
- Two rules out of oxlint's `correctness` category are off with a written
  reason. `unicorn/no-useless-spread` is wrong about
  `for (const socket of [...sockets])`, where the copy is what makes it safe to
  delete from the set inside the loop; `unicorn/no-new-array` is wrong about
  `new Array<number>(n).fill(-1)`, where the type argument removes the
  ambiguity it worries about. Between them those two account for ten of the
  23 findings; the other thirteen were fixed.
- `apps/mcp` is inside the import-site boundary rule for the first time. The
  ESLint override was built with a directory list that did not contain `mcp`,
  so it had been pointing at `packages/mcp`, which does not exist.
- The empty-catch rule was never the one anybody thought it was. The selector
  `CatchClause > BlockStatement:not(:has(*))` matches nothing, because esquery
  reads `:has(*)` as true for a childless block. What has been enforcing that
  policy all along is `no-empty`, which allows a catch block containing a
  comment — and nine of them in this repository do exactly that, on purpose.
- ESLint 10 is now held by one plugin for one rule (`eslint-plugin-react`, for
  `react/no-deprecated`), and TypeScript 7 by a parser rather than by a rule
  set. Issue #85 then swapped that parser out and took the compiler to 7; the
  parser that replaced it peers `eslint: ^7 || ^8 || ^9` too, so ESLint 10 is
  now held by two plugins rather than one. See `docs/deviations.md`.

## Alternatives considered

**Keep the boundaries in ESLint.** It would have avoided generating anything,
and it would have kept ESLint parsing every file for the one rule that matters
most — which is most of the 11 seconds. The generated file costs a `--check`
call in a gate that was already reading the graph.

**Enable oxlint's `correctness` and fix everything it finds.** Eight of the 23
findings were `unicorn/no-useless-spread` on loops that mutate what they walk;
"fixing" them would have introduced a real bug in the revocation paths of
`realtime.gateway.ts` and `mcp-streams.service.ts`. A linter is a proposal.

**Use oxlint's JavaScript plugin compatibility to keep `simple-import-sort` and
the syntax selectors inside oxlint.** It is in alpha and not under semver. A
small, boring ESLint remainder is the more robust half of the migration, and it
is the part that shrinks on its own as oxlint grows.
