# Overview pages

A page that collects sub-pages can describe them itself, and keep describing
them after the tree has changed. Issue #53, and the reasoning is in
[ADR-028](adr/ADR-028-overview-pages-are-derived.md).

## What a reader sees

Marking a page as an overview adds a section between the title and the body:

- a composed paragraph about what lies underneath the page
- one line per sub-page, with its icon, its own two-sentence digest and how many
  pages hang under it
- a footer with the date of the composition, a "veraltet" badge when the
  children have changed since, and a button that recomposes now

The page body is untouched by all of it. Writing an introduction by hand still
works, and the composition never lands in the editor. Switching the mark off
takes the section away and leaves everything a human wrote exactly where it was.

## Switching it on

Per page: "Seiteneigenschaften" in the page menu, the **Übersichtsseite**
switch. Through the catalogue: `exo_page_set_overview`.

Six settings govern the rest, and the first one decides whether anything is
composed at all:

| Setting                    | Scope      | Why                                                                               |
| -------------------------- | ---------- | --------------------------------------------------------------------------------- |
| `overview.enabled`         | workspace  | The main switch. Off means the child list without the prose, which costs nothing. |
| `overview.modelSlug`       | workspace  | Null falls back to the default model. A small model is the right one here.        |
| `overview.debounceSeconds` | deployment | How long a page stays quiet before its overview is recomposed. Default 300.       |
| `overview.maxChildren`     | deployment | Beyond this the list stays complete and no paragraph is written. Default 40.      |
| `overview.maxPageChars`    | deployment | How much of a page's own text reaches its digest prompt. Default 6000.            |
| `overview.generateCovers`  | workspace  | Draws a cover for an overview page that has none, once. Needs an image model.     |

`overview.enabled` is a ceiling (ADR-023): a workspace may switch its overviews
off, never on against a deployment that said no.

## How it stays current

Two rows of derived text and two hashes, both on `DocumentDigest`:

- `summary` is the page's own digest, what the overview above it quotes. Its
  hash covers the page's title and materialized text.
- `intro` is the paragraph an overview page opens with. Its hash covers the
  title, the page's own body and the ordered list of child ids, titles and
  digest hashes.

A refresh whose hash is unchanged does nothing and pays nothing. That is what
lets the trigger be generous, and it is why a burst of edits costs one
composition rather than twenty.

The chain up the tree is not a special case: recomposing an overview changes its
own `summary`, which changes its parent's input, which recomposes the parent.
`Creative & Media` summarises `Fish Audio S2`, `AI & Tools` summarises
`Creative & Media`, and nobody wrote that rule.

Only pages under an overview are digested. A page whose parent is an ordinary
page never reaches a model, which is what keeps the whole feature affordable.

## What triggers a refresh

`dispatchOutbox` (`apps/worker/src/processors/maintenance-tasks/overviews.ts`),
the same seam automations hang off. `document.created`, `document.updated`,
`document.materialized`, `document.content.replaced`, `document.moved`,
`document.archived` and `document.restored` reach it; the structural ones also
enqueue the parent directly, because a page created a second ago has no digest
to cascade with.

Underneath it, hourly at :45, `refresh-stale-overviews` hands overview pages
back to the queue, oldest composition first. It is the net under a lost enqueue
and the only thing that notices a permanently deleted page: a deleted row takes
its `parentId` with it, so no event can name the overview it hung under.

## When there is no model

Nothing breaks. The child list is read from the tree and is always there; the
paragraph is the only part that needs a model. The panel says which silence it
is showing: never composed yet, switched off for this workspace, or a run that
failed. A failed run keeps the previous composition, because yesterday's
overview beats an empty page.

An overview with more children than `overview.maxChildren` keeps the full list
and says why there is no paragraph.

## The cover

An overview page with no cover gets one drawn from its own composed intro, once
(`coverAskedAt`). The prompt asks for a quiet abstract banner and forbids text
in the image, because every image model spells badly and a misspelt page title
on a cover is worse than no words at all.

It needs `ai.imageGenerationEnabled` and an `ai.imageModelSlug`, so a deployment
that has not decided to pay for pictures gets none. A cover removed by hand
stays removed; asking again is `exo_page_generate_cover` or the button in the
browser.

## Agents

An agent that creates a collecting page should mark it rather than fill it. The
instruction is in three places, because an agent reads whichever it meets first:
the description of `exo_page_set_overview`, the description of
`exo_page_create`, and the page tree, which marks an overview page on its own
line.

The three tools:

- `exo_page_set_overview` marks a page or unmarks it
- `exo_page_overview_read` reads the composition and the children's digests,
  which is the cheapest way to find out what is under a page without opening
  every sub-page
- `exo_page_overview_refresh` recomposes now

## Extending it

The prompts and the answer parsing are one pure module
(`apps/worker/src/processors/overview/compose.ts`) with a test beside it. A
changed prompt needs `OVERVIEW_COMPOSITION_VERSION` in
`packages/database/src/overview-source.ts` bumped in the same commit: the
version is part of both hashes, so bumping it recomposes everything once
instead of leaving text nobody can explain.
