# ADR-028: An overview page is composed from digests, and the composition is derived

- Status: accepted
- Date: 2026-09-15

## Context

A page tree grows a layer of pages whose job is not to say anything themselves
but to lead somewhere: `AI & Tools`, `Creative & Media`, `Technik`. Somebody
writes two paragraphs on such a page the day they create it, and from then on
the paragraphs are wrong. A sub-page is added, another is renamed, a third is
deleted, and nothing about the page above them notices. The page that was
supposed to make the tree navigable is the least trustworthy page in it.

Three ways to fix that were on the table, and two of them are worse:

- Leave it to whoever writes. That is the current state, and the state is stale.
- Let an agent keep the page's body up to date. A body an agent rewrites is a
  body a human cannot safely write in, and ADR-024 already refused exactly this
  for automations: an AI rule writes a comment or a child page, never the page.

## Decision

### The overview is a derived view beside the page, not its body

Marking a page as an overview writes nothing into its Yjs state, now or ever.
The composed text lives in a sidecar row and is rendered on the page, between
the title and the body. The body stays the human's: usually empty, sometimes a
paragraph of introduction, and never overwritten.

It has its own route and its own tool (`exo_page_overview_read`) rather than
joining the Markdown export. The export is what the page itself says, and a
composition mixed into it would come back in through an import as a body
somebody would then edit: a derived view that can be round-tripped into
canonical state is not derived any more. The page tree marks an overview page
instead, so an agent reading a tree knows which pages not to fill.

This is ADR-026's rule applied to text instead of to a PDF. A derived view can
be thrown away and rebuilt, so there is nothing to lose and nothing to revert,
no editor node to invent, no write through the collaboration server (ADR-016),
and no way for a refresh to land on top of a sentence somebody was typing.

### Two layers: a digest per page, a composition per overview

A digest (`DocumentDigest.summary`) is two or three sentences about one page. A
composition (`DocumentDigest.intro`) is the paragraph an overview page opens
with. Both live on the same row because both are derived text about that one
page, and they are produced by one model call: an overview page is asked for its
intro and for the summary the page above it will quote.

The composition is built from the children's **digests**, never from their
content. That is what makes the whole tree affordable: one level of the tree
costs one small prompt, a leaf that changes costs one digest, and a deployment
with a thousand pages under six overview pages does not read a thousand pages to
rebuild six paragraphs.

The cascade falls out of it. A leaf changes, its digest changes, its parent's
composition input changes, the parent is recomposed, its own summary changes,
and the grandparent follows. `Creative & Media` summarises `Fish Audio S2`;
`AI & Tools` summarises `Creative & Media`. Nobody wrote that rule; it is what
composing from digests means.

### Staleness is a hash, not a timestamp

Each half of the row carries the hash of what produced it: the page's
materialized text for a digest, the ordered list of child ids, titles and digest
hashes for a composition. A refresh whose input hash matches does nothing and
pays nothing, which is what lets the trigger be generous. A row whose hash no
longer matches the live input is shown as stale rather than hidden: an overview
from yesterday is worth more than an empty page, and the badge says which it is.

The same hash is what makes a deletion visible. A child that disappears changes
the list, and the list is the input.

### Only pages under an overview get a digest

Digesting every page in the workspace would be a paid call per save, for text
that nothing displays. A page is digested when its parent is an overview page,
or when it is one itself. Switching a page to an overview is therefore the act
that starts the spending, and switching it back stops it.

### Without a model it still works

An overview with no composed text lists its children with their titles, icons
and sub-page counts. That list is computed from the tree at read time and needs
no model, no key and no job; the model only ever adds the prose. A deployment
with AI switched off, an expired provider key, a page whose refresh has not run
yet: all three show the list, and none of them shows an empty page.

### The trigger is the outbox, like everything else

Refreshes hang off `dispatchOutbox` (ADR-010, and the same seam ADR-024 uses),
debounced per page. There is no second event path, no listener beside the
outbox, and one hourly sweep underneath for the enqueue that was lost in
silence, exactly as `rematerialize-stale-content` is the net under
materialization.

### A cover is offered once, and only for an overview

An overview page with no cover gets one drawn from its own composed intro,
through the existing cover job. Once: the picture is a page's identity in a
list, and an overview page whose picture changed every time a sub-page was
renamed would be unrecognisable. Removing the cover by hand is a decision, so
the refresh does not draw a second one; asking again is `exo_page_generate_cover`
or the button in the browser.

## Consequences

- An overview page's prose cannot be edited in place. Correcting a sentence
  means correcting the page it came from, or writing the correction into the
  page body below it, which is the human's half and is never touched. This is
  the cost of a derived view and it is deliberate; the alternative is a body two
  authors write.
- The digest of a page is visible to anyone who may read the page above it. That
  is already true of the title, and a digest says less than the title plus the
  first paragraph an excerpt would show.
- An agent that creates a collecting page is told to mark it and not to fill it.
  The instruction rides on three surfaces: the description of
  `exo_page_set_overview`, the description of `exo_page_create`, and the page
  tree, which marks an overview page on its own line. It is a
  recommendation in a tool description, not an enforcement: nothing stops a page
  from being both, and a page with a hand-written body and a composition under
  it is a legitimate result.
