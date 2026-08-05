# Deviations from the original brief

Every deviation below is deliberate. Where a requirement could not be met exactly,
the reason and the replacement are documented.

## 1. shadcn components are Radix-based in the public registry

**Brief:** "Use Base UI primitives for new shadcn components."

**Reality:** the public shadcn registry (`https://ui.shadcn.com/r/...`) only ships
Radix-based sources today; no Base UI registry was reachable
(`base-ui.shadcn.com`, `/r/base-ui/...` and `/r/styles/base-ui-v4/...` all fail).

**What was done:** components were installed with the official CLI
(`pnpm dlx shadcn@4.16.1 add …`), then adapted to Base UI:

* `button.tsx` and `badge.tsx`: Radix `Slot` replaced with Base UI `useRender`
  (`render` prop instead of `asChild`)
* `label.tsx`: the Radix primitive only rendered a `<label>`, so the native
  element is used
* every interactive component (`dialog`, `dropdown-menu`, `tooltip`, `tabs`,
  `scroll-area`, `separator`, `context-menu`, `avatar`) is written directly against
  `@base-ui-components/react`
* the `radix-ui` dependency the CLI added was removed again

The result contains no Radix code. See `docs/ui-system.md`.

## 2. Prisma 6 instead of Prisma 7

Prisma 7 is the newest release. Prisma 6.19.3 was chosen because it is the version
Better Auth's Prisma adapter is tested against and because its `prisma-client-js`
generator works unchanged in both the CJS server builds and the ESM browser build.
Upgrading is a contained change: regenerate the client and adjust
`packages/database/prisma/schema.prisma`.

## 3. TypeScript 5.9 instead of TypeScript 7

TypeScript 7.0 (the native port) is available but `typescript-eslint`, NestJS
decorator metadata and `next`'s type plugin are not yet validated against it.
5.9.3 is the newest release the whole toolchain supports.

## 4. ESLint 9 instead of ESLint 10

`typescript-eslint@8` supports ESLint 9; the ESLint 10 peer range is not yet
covered by all plugins used here.

## 5. Redis event bus instead of the Socket.IO Redis adapter

**Brief:** "Create a Redis adapter boundary for future horizontal scaling."

**What was done:** `packages/queue/src/event-bus.ts` implements a validated Redis
pub/sub bus. Every process publishes application events to one channel and every
API instance re-emits them into its local Socket.IO rooms. This covers the same
scaling boundary, additionally lets the *worker* publish events (which the
Socket.IO adapter cannot), and validates payloads on both ends. Using both
mechanisms at once would double-deliver events.

## 6. Block identifiers in Markdown are opt-in

**Brief:** "preserves IDs during export where the format allows it."

Markdown has no attribute syntax. `serializeMarkdown(doc, { includeBlockIds: true })`
writes an Obsidian-compatible `^id` suffix, and the parser reads it back.
The default export omits identifiers so exported files stay clean. Round-tripping
with identifiers is covered by
`packages/editor/src/markdown/markdown.test.ts` → "preserves block ids when they
are included in the export".

Container nodes (lists, tables) do not carry an id in Markdown; paragraphs,
headings, code blocks, list items, task items and callouts do.

## 7. MIME detection is implemented locally

`file-type` is ESM-only, which does not combine with the CommonJS builds of the
API and worker. `packages/storage/src/mime.ts` implements a short, auditable
signature table for exactly the formats Exocortex allows, plus a UTF-8 text check.
It is covered by 11 unit tests, including "rejects an executable disguised as an
image".

## 8. `packages/ui` and `packages/editor` are consumed as source by the browser

Both are listed in `transpilePackages`. For `packages/ui` this lets Tailwind see
the class names. For `packages/editor` it is a correctness requirement: mixing its
CommonJS build into the ESM browser bundle produces two ProseMirror module
instances, which makes ProseMirror reject plugins with
"Adding different instances of a keyed plugin". Server processes keep using the
compiled CommonJS output through the `require` condition.

## 9. Explicit authentication rate limits

Better Auth's defaults were replaced with an explicit policy
(`packages/auth/src/auth.ts`): 10 sign-ins/minute, 5 sign-ups/minute and
5 password-reset requests per 5 minutes per client IP. Explicit limits are
documented, testable and still block credential stuffing.

## 10. Playwright covers the API security scenarios

The required security scenarios are verified with Playwright's `APIRequestContext`
against the running API rather than with mocked unit tests, because that is where
the rules are enforced. See `e2e/tests/security.spec.ts` (13 tests).

## 11. `.env` is symlinked into `apps/web`

Next.js only reads env files from its own project directory. `apps/web/.env` is a
symlink to the repository root `.env` so a single file configures every process.
Both paths are git-ignored.
