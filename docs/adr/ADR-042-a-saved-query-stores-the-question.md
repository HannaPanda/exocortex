# ADR-042: a saved query stores the question, and three surfaces answer it

- Status: accepted
- Date: 2026-09-19

## Context

Issue #74 asks for saved searches, smart views and query blocks: "alle offenen
Aufgaben mit hoher Priorität", "alles Verwandte zu einem Projekt", "alle neuen
Notizen der letzten 30 Tage zu TYPO3". Today a search is a keystroke and an
answer, and the answer is gone the moment the palette closes.

The issue names three surfaces and then says the important thing out loud:
this must not become a second database system. That warning is the whole
design constraint, because the obvious implementation of "a list that stays"
is a list -- a table of document ids, refreshed by a job. Four things go wrong
with that, all of them quietly:

- it is stale between refreshes, and nobody can tell how stale,
- it freezes the permissions of whoever saved it, so a guest opening it sees
  rows they may not read,
- it needs a job, a failure mode and a backlog for something a query answers
  in twenty milliseconds,
- and it owns rows, which makes it a database with all of ADR-011's questions
  reopened.

A second question: how do the words and the filters meet? Full-text and vector
search are answered by `SearchAdapter` (ADR-020), which knows about ranking and
nothing about the document tree. The structural half -- a subtree, a document
type, a property value, a time window -- is SQL over `document`, which knows
about the tree and nothing about relevance. Neither can answer the other's
half, and the adapter interface deliberately takes no list of allowed ids,
because a vector index could not use one.

## Decision

**A saved query stores a question and never an answer.** `SavedQuery` holds a
name, a definition and how to lay the answer out. No document ids, no counts,
no cached rows, no refresh job. The definition is JSON validated by
`savedQueryDefinitionSchema` on every write _and_ on every read, so a
definition written by an older build is reported rather than silently reduced
to the fields that still parse.

**The query runs as the caller, every time.** Membership is checked on the run,
not on the save, and the workspace is part of every statement. A query saved by
an owner and opened by a guest is answered against what the guest may read.
This is the property that makes a shared smart view safe, and it is the one a
stored result list cannot have.

**Three surfaces, one row.** A saved search is the row; a smart view is the row
with `inSidebar`; a query block is a page holding the row's id. They are not
three features, and they are not three tables. The block keeps the id, the name
frozen at insertion and its own row limit, exactly the way `databaseEmbed`
keeps a database id and a title (ADR-011): the answer is fetched when the block
is rendered and never written into the document, because a written answer is a
copy that rots.

**Deliberately not a `Document`.** A database is a document because it owns its
rows. A saved query owns nothing: it names pages that exist for their own
reasons. Making it a page would give it a place in a tree it has no business
being in, an empty Yjs state, and a search index entry that would match its own
results.

**The adapter proposes, SQL disposes.** With a text, the search adapter is
asked for a generous candidate list and one SQL statement decides which of
those candidates survive the structural half; the adapter's order is the
relevance order and its snippet is the one shown, because only it knows what
matched. Without a text, SQL alone answers, ordered and limited in the
database. `textMode: 'KEYWORD'` asks for the full-text adapter on its own, so a
question about an exact word costs no embedding call -- which matters when a
page carries three query blocks that re-run on every visit.

**A property filter is the database view's filter, compiled by the database
view's engine.** `compileFilterGroup` already refuses a property id that is not
in the schema of the collection being queried, which is what keeps a filter
from reaching across workspaces. So a property filter requires a
`collectionId`, the contract enforces the pair, and "Status ist Offen" means
exactly one thing in this workspace.

**A window is relative by default and an ancestor is resolved at run time.**
"Die letzten 30 Tage" has to still mean the last thirty days next month, so
`withinDays` is counted back from now rather than turned into a date at save
time. A subtree is a recursive walk performed by the query, so a page moved
into the subtree appears in the answer without the query being edited.

**The answer says when it is incomplete.** `truncated` is set when the limit
cut the list, and also when the adapter itself stopped at its candidate
ceiling. Reporting it slightly too eagerly is the safe direction: acting on
"there are three of these" when there are forty is the failure this prevents,
and every surface says so in words.

## Consequences

- One new table, `saved_query`, and one new application event,
  `saved-query.changed`, so a smart view appears in every member's navigation
  without a reload. The payload carries the id and what happened, never the
  definition: a workspace's stored questions do not belong on a socket every
  member is on.
- Eight MCP tools, all on both agent surfaces. `exo_saved_query_preview` runs a
  definition without storing it, which also makes it the filtering sibling of
  `exo_search`.
- A saved query names pages inside JSON, so no foreign key protects those
  references. A query naming a page that has been deleted answers with nothing
  rather than failing; a property filter whose property is gone is reported as
  `saved_query_invalid`, because that one cannot be answered at all and the
  query has to be edited.
- Writing needs MEMBER (`canManageSavedQueries`). Reading the list needs only
  membership, because the answers are filtered by the reader's own access
  anyway.
- There is no notification when an answer changes, and no history of what a
  query used to return. Both would need exactly the stored result list this
  decision refuses.
