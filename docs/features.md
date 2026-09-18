# The feature registry

What this deployment can do, written for the person who would use it rather
than for the client that calls it. The registry is `packages/features`, the
help page is `/hilfe`, the tool is `exo_features`, and the gate under all three
is `scripts/check-feature-coverage.mjs`. The reasoning is ADR-040 and the rule
is number 15 in `CLAUDE.md`.

## Why this exists beside the capability matrix

`docs/capability-matrix.md` is generated, complete and exact, and it says
`POST /api/workspaces/:x/clip`. The tool catalogue is complete too, and it says
what arguments `exo_clip` takes. Neither says:

> Über /teilen nimmt eXocortex Adresse, Titel und markierten Text einer
> Webseite entgegen, wahlweise als Lesezeichen oder mit dem vollständigen
> abgerufenen Artikel.

That sentence is the one somebody needs in order to find a feature they asked
for a year ago and forgot. No generator writes it, so it is written by hand,
and the gate makes sure it gets written at all.

## Adding an entry

1. **Find the file.** `packages/features/src/features/` is split by theme, not
   by area: `pages.ts`, `data.ts`, `collaboration.ts`, `ai.ts`,
   `publishing.ts`, `platform.ts`. Put the entry where its neighbours are; the
   catalogue sorts by area afterwards, so the file is only about file length.

2. **Write it.**

   ```ts
   defineFeature({
     id: 'web-clipper',
     area: 'erfassen',
     title: 'Seiten aus dem Browser clippen und teilen',
     summary:
       'Über /teilen nimmt eXocortex Adresse, Titel und markierten Text einer Webseite entgegen, …',
     since: '2026-09-18',
     references: ['#72', 'ADR-037'],
     ui: { where: 'Das Teilen-Menü des Telefons, oder ein Lesezeichen …', path: '/teilen' },
     shortcuts: ['Strg+E'],
     settings: ['automations.enabled'],
     tools: ['exo_clip'],
     claims: { screens: ['/teilen'] },
   });
   ```

   | Field        | What goes in it                                                                                                          |
   | ------------ | ------------------------------------------------------------------------------------------------------------------------ |
   | `id`         | kebab-case, stable. It is the anchor on the help page, so renaming one breaks a link somebody saved.                     |
   | `area`       | One of `FEATURE_AREAS` in `packages/contracts/src/features.ts`. Adding an area means adding its German label there too.  |
   | `title`      | What a person would call it, not what the module is called.                                                              |
   | `summary`    | One or two sentences: what it does, and why somebody would want it. German, and no em dashes.                            |
   | `since`      | `YYYY-MM-DD`, the day it goes **live**, not the day the branch was cut. This is what "new for you" is measured against.  |
   | `references` | Issues and ADRs, for the reader who wants the reasoning.                                                                 |
   | `ui`         | `where` is a sentence; `path` only when a link can be written for it. Omit the whole field for something with no screen. |
   | `shortcuts`  | As the interface writes them (`Strg+K`).                                                                                 |
   | `settings`   | Setting keys that switch it on or shape it.                                                                              |
   | `tools`      | Tool names an agent calls. Also what the gate counts, so every tool belongs to exactly one entry.                        |
   | `claims`     | What the entry accounts for that is not a tool: `screens`, `automationTriggers`, `automationActions`.                    |

3. **Run the gate.**

   ```bash
   node scripts/check-feature-coverage.mjs
   ```

   It names what is unclaimed and what is claimed and gone.

## What the gate reads, and what it does not

Three inventories, all out of the source, none of them hand-kept:

| Inventory                       | Read from                                                    | Claimed through                                         |
| ------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------- |
| MCP tools                       | `defineTool` in `packages/mcp-tools`                         | `tools`                                                 |
| Browser screens                 | every `page.tsx` under `apps/web/src/app`                    | `claims.screens`                                        |
| Automation triggers and actions | the two `z.enum`s in `packages/contracts/src/automations.ts` | `claims.automationTriggers`, `claims.automationActions` |

A screen may be claimed by several entries, because the page view hosts a dozen
capabilities and pretending one of them owns it would be a lie told to satisfy
a counter. A tool may be claimed by exactly one, which the catalogue's own test
enforces rather than the gate, since that one needs the real types.

Screens are written the way the capability matrix writes a route: route groups
are dropped and dynamic segments become `:x`, so
`apps/web/src/app/(app)/arbeitsbereich/[workspaceId]/seite/[documentId]/page.tsx`
is `/arbeitsbereich/:x/seite/:x`. One screen is exempt, with the reason next to
it in the script: `/` is a redirect.

Not counted, deliberately: editor block types (their ids are partly computed in
`packages/editor/src/block-catalog.ts`, and a text scan of them would be a
parser) and settings keys (ninety entries would read as noise). Both are
described in prose by the entries that own them, and a new block type can
therefore reach production undescribed. ADR-040 says so out loud rather than
implying the coverage is total.

And the thing no gate can do: judge whether a summary is true, current or
useful. An entry that is complete and wrong passes. That is what review is for.

## What a reader sees

`/hilfe` groups by area, searches across title, summary, access, tools and
settings, and marks everything newer than the reader's marker. `UserFeatureSeen`
holds one row per person, and an **absent row means they have seen everything**:
a new account has missed nothing and should meet a manual, not a changelog of
sixty things it never missed. "Zur Kenntnis genommen" moves the marker to the
newest `since` in the catalogue rather than to today, so a later entry
backfilled with an older date still counts as seen.

The navigation carries a dot while the count is above zero. It is the only
badge in the shell, on purpose: a list you have to remember to open does not
solve the problem the list exists for.

## Serving it elsewhere

`GET /api/features` returns the catalogue with `isNew` computed for the caller,
and `POST /api/features/seen` moves the marker. The second is exempt from the
tool catalogue (reason next to the route in `scripts/check-mcp-catalog.mjs`):
reading the list is a tool, marking it read is a statement about a human's
attention, and an agent calling it would silently clear somebody's badge.

`exo_features` takes an optional `area`, `query` and `since`, and returns
Markdown grouped by area. A session that has been asked what eXocortex can do
should call it rather than answer from what it remembers of the repository.
