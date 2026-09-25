# The feature registry

What this deployment can do, written for the person who would use it rather
than for the client that calls it. The registry is `packages/features`, its
words are the `features` namespace of the message catalogue
(`packages/i18n/src/messages/de/features.json`, German first), the help page is
`/hilfe`, the tool is `exo_features`, and the gate under all of them is
`scripts/check-feature-coverage.mjs`. The reasoning is ADR-040 and the rule is
number 15 in `CLAUDE.md`; why the words sit in the catalogue is ADR-062.

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

2. **Write it, in two halves.** The facts go into the registry:

   ```ts
   defineFeature({
     id: 'web-clipper',
     area: 'erfassen',
     since: '2026-09-18',
     references: ['#72', 'ADR-037'],
     ui: { path: '/teilen' },
     shortcuts: ['Strg+E'],
     settings: ['automations.enabled'],
     tools: ['exo_clip'],
     claims: { screens: ['/teilen'] },
   });
   ```

   The words go into `packages/i18n/src/messages/de/features.json`, under the
   same id:

   ```json
   "web-clipper": {
     "title": "Seiten aus dem Browser clippen und teilen",
     "summary": "Über /teilen nimmt eXocortex Adresse, Titel und markierten Text einer Webseite entgegen, …",
     "details": {
       "p1": "Am Telefon installierst du eXocortex als App über das Browsermenü; danach steht es …",
       "p2": "Der Clip ist eine gewöhnliche Erfassung mit einer Herkunftszeile obendrüber, also …",
       "p3": "Für das Abrufen gilt dieselbe Adressprüfung wie für die Web-Recherche, interne …"
     },
     "where": "Das Teilen-Menü des Telefons, oder ein Lesezeichen …"
   }
   ```

   The catalogue holds nested objects of strings and no arrays, so the
   paragraphs are `p1`, `p2` and on, without a gap: the API reads them in that
   order and stops at the first one missing. Ids keep their hyphens; only a dot
   separates keys. The text is ICU MessageFormat, so an apostrophe is the
   typographic `’`, and a literal `<`, `{` or `}` that could read as syntax is
   quoted (`'<id>'`). Then `pnpm i18n:catalog` for the types and
   `pnpm i18n:translate --all` for the other locales, in the same commit
   series (`docs/i18n.md`).

   | Field        | What goes in it                                                                                                                                                          |
   | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | `id`         | kebab-case, stable. It is the anchor on the help page, so renaming one breaks a link somebody saved.                                                                     |
   | `area`       | One of `FEATURE_AREAS` in `packages/contracts/src/features.ts`. Adding an area means adding its label and one-sentence description to `help.areas` in the catalogue too. |
   | `title`      | Catalogue. What a person would call it, not what the module is called.                                                                                                   |
   | `summary`    | Catalogue. One or two sentences: what it does, and why somebody would want it. German, and no em dashes.                                                                 |
   | `details`    | Catalogue, `p1` … `pN`. The long form, one paragraph each. Two or three: how it works, how you use it, where it stops.                                                   |
   | `since`      | `YYYY-MM-DD`, the day it goes **live**, not the day the branch was cut. This is what "new for you" is measured against.                                                  |
   | `references` | Issues and ADRs, for the reader who wants the reasoning.                                                                                                                 |
   | `ui`         | A door in the browser: `ui: {}`, or `ui: { path }` when a link can be written. Its sentence is `where` in the catalogue. Omit both for something with no screen.         |
   | `shortcuts`  | As the interface writes them (`Strg+K`).                                                                                                                                 |
   | `settings`   | Setting keys that switch it on or shape it.                                                                                                                              |
   | `tools`      | Tool names an agent calls. Also what the gate counts, so every tool belongs to exactly one entry.                                                                        |
   | `claims`     | What the entry accounts for that is not a tool: `screens`, `automationTriggers`, `automationActions`.                                                                    |

3. **Write the paragraphs for the person, not for the reviewer.**

   `details` is the part a reader learns something from, and the three
   questions it answers are always the same:

   - **How does it work, in the words of somebody using it?** Not the module,
     not the table: "eine Vorlage ist eine ganz normale Seite mit einer
     Markierung daran".
   - **How do you actually use it?** The keystroke, the menu item, the order
     of the two clicks, what you see afterwards.
   - **Where does it stop?** The limit, the deliberate omission, the thing it
     will not do for you. A copy that keeps no link back, an action that never
     overwrites the body, a list that is not exhaustive.

   The gate insists on at least two paragraphs, more than four hundred
   characters, and prose that is not the summary pasted twice. That is
   a floor, not a target: it cannot tell a real explanation from four hundred
   characters of restatement. Apply the house rules while writing: German, du,
   and no em dashes in running text.

4. **Run the gate.**

   ```bash
   node scripts/check-feature-coverage.mjs
   ```

   It names what is unclaimed and what is claimed and gone, and holds the
   registry and the German catalogue together: an entry without a title, a
   summary or `details.p1`, a `ui` without its `where` (or a `where` without a
   `ui`), and words for an id the registry no longer has all go red.

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

`/hilfe` is one area at a time. The fourteen areas are a side navigation with
a count each, and "Alle Funktionen" sits above them for the reader who wants
the whole thing in one column; below `md` the same selection is a `Select`,
because fourteen rows above the content push the content off a phone. Each
area carries its one-line description from `help.areas` in the catalogue, and
each entry shows the summary as a lead, then the `details` paragraphs, then a
box with the doors: where to find it, the shortcut, the tools, the settings
and the references.

The search spans every area, over title, summary, details, access, tools,
settings and references. When it matches nothing in the open area, the page
falls back to "Alle Funktionen" instead of jumping to whichever area matched
first: a tab that moves under you while you type is worse than a list that
grew. The fallback is derived, not stored, so the reader's chosen area comes
back as soon as it has entries again.

Everything newer than the reader's marker is marked. `UserFeatureSeen`
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
and `POST /api/features/seen` moves the marker. The words are rendered per
request in the caller's language (`readerLocale`: the account's choice, then
the cookie, then `Accept-Language`, then German), entries of one area and one
day are ordered by that rendered title with `Intl.Collator`, and the response
carries `areas`, each area's label and description from `help.areas`, so a
client without a catalogue of its own can print the headings. The namespace
stays out of the browser's message payload (`apps/web/src/i18n/namespaces.ts`):
the help page gets its entries from the API, already translated. The second is exempt from the
tool catalogue (reason next to the route in `scripts/check-mcp-catalog.mjs`):
reading the list is a tool, marking it read is a statement about a human's
attention, and an agent calling it would silently clear somebody's badge.

`exo_features` takes an optional `area`, `query`, `since` and `detailed`, and
returns Markdown grouped by area, in the language of the account that owns the
token (an MCP client sends no cookie and no `Accept-Language`). A session that has been asked what eXocortex
can do should call it rather than answer from what it remembers of the
repository.

`detailed` decides whether the `details` paragraphs come along. Left out, it
is on for up to three matches and off above that: below that line the caller
asked about something specific and wants the whole entry, above it the
paragraphs would be tens of thousands of characters nobody asked for. The
navigation's badge is a person's marker, so `isNew` is computed for whoever
owns the token and the tool does not move it.
