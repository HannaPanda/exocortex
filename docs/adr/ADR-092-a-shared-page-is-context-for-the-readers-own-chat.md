# ADR-092: A shared page is context for the reader's own chat

- Status: accepted
- Date: 2026-11-26
- Relates to: ADR-044 (a grant is a row on a page), ADR-015 (the page's text
  in the prompt), ADR-030 (foreign text), ADR-071 (a profile confines a run to
  one workspace), ADR-090 and ADR-091 (who pays for a run), issue #83,
  issue #234

## Context

A page shared with an account (ADR-044) opens at `/geteilt/<documentId>`,
outside every workspace shell, because the reader is a member of none of the
page's surroundings. The chat panel took its workspace from the route, found
none there, and answered "Wähle einen Arbeitsbereich". The API would have
refused anyway: a conversation belongs to a workspace, and its open page had to
be a page of that same workspace.

A chat run is not free and not neutral. It is paid from a workspace's key and
counted against its budget (ADR-090, ADR-091), it follows that workspace's
settings and rule pages, and it is listed among that workspace's conversations.
So "where does the chat run" has exactly two answers, the page's workspace or
the reader's own, and the person answering for the deployment chose on
2026-11-25 ("Variante A"): the reader's own.

## Decision

**The chat runs in one of the reader's own workspaces, and the shared page is
its open page.** The conversation, the run row, the key, the budget, the
settings and the rule pages are the reader's workspace's. Nothing about the
run is written to, paid by or listed in the workspace the page lives in. The
browser picks the reader's first own workspace (an agent memory area is never
one) and lets them choose another when they have several; the choice is a
per-browser convenience, never an authority.

**The boundary is the grant, asked on every call.** The run's tool calls reach
the API with a service token minted for the reader (D3), and an ordinary chat
carries no workspace claim. Every page route asks
`WorkspaceAccessService.findDocumentContext`, which resolves the grant live: a
READ grant makes the reader a guest of the page and cannot write, a
`PAGE_ONLY` grant reaches neither a sub-page nor a neighbour, a workspace-wide
route (search, tree, trash, databases) refuses a non-member, and a withdrawn
grant fails the very next call of a run already in flight. Nothing new had to
be built for that; the decision is to rely on it rather than add a second
check in the prompt or the browser.

**One rule decides which page may be a conversation's open page.**
`mayBeConversationPage` in `packages/auth/src/document-grants.ts`: a page of the
conversation's own workspace, or a page the caller reached through a share. A
page of another workspace the caller is a _member_ of stays refused: a member
talks about it in that workspace, and a run that mixed two workspaces' keys,
budgets and rules would answer to neither. The API applies the rule when a
conversation is created and when a message names a page.

**The worker asks again before it names the page.** A grant can be withdrawn
between the posted message and the run. `resolveOpenPageReach`
(`apps/worker/src/open-page.ts`) asks the same `findDocumentContext` as the
reader when the prompt is built and when the page's pictures are described; no
live grant, no page in the prompt. The breadcrumb stops at the shared page,
like the one the browser shows (`visiblePath`), and a collection shared on its
own is not described row by row, because its rows are pages below it. The
prompt also tells the model what the grant allows, which is a courtesy that
saves refused calls and never the boundary.

**A pinned source stays in the conversation's workspace.** The shared page is
the open page, never a pin: pinning decides what a conversation carries from
page to page, and carrying a foreign page along is a second decision nobody
has made yet.

## Consequences

- Whoever shares a page never pays for, sees or lists the reader's chat about
  it. The reader's workspace pays even when the chat is only about somebody
  else's page.
- `ai.pageContextEnabled` and the other run settings are the reader's
  workspace's, not the page's. The text that may then reach the model is text
  the reader can read anyway.
- A run under an agent profile that confines it to its workspace (ADR-071)
  reaches no shared page: the confinement answers every other workspace as if
  the account were not a member, and a grant is no membership. That is the
  intended reading of "confined", and it is tested.
- Text from a shared page counts as `internal` for ADR-030, like any page
  written in this deployment. Whether text from another workspace should lock a
  run's writes the way an uploaded document does is an open question, recorded
  here rather than decided by default.
- A cost the reader causes on the shared page through a tool, rather than
  through the run itself, follows that tool's own rule (a cover is drawn on the
  page's workspace key, ADR-090). That is unchanged by this decision.

## Alternatives considered

**Run the chat in the page's workspace.** The sharer would pay for, and be
able to list, conversations they are not part of, and the reader would be
handed that workspace's model choice and rule pages. Rejected by the decision
of 2026-11-25.

**A separate, personal chat area for shared pages.** A conversation already
belongs to a workspace for every reason above; a second home would need its
own key, budget and settings, all of which a workspace already has.
