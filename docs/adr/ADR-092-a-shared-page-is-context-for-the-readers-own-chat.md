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
  written in this deployment. Decided on 2026-11-26 (issue #264), see below.
- A cover the reader causes on the shared page is paid for by the reader, not
  by the page's workspace (issue #264, below, and ADR-090's addendum).

## Addendum 2026-11-28: what the reader's chat trusts, and who pays for a cover

Issue #264 settled the two questions this record had left open. Both were
decided by the person answering for the deployment on 2026-11-26.

**A shared page's text is the reader's own material in the chat.** It is not
foreign text in the sense of ADR-030: reading it does not mark the run, and a
mutating tool call after it is not refused on that account. A `WRITE` grant
means the reader's assistant may write on the page, as the reader could. That
is how #234 built it (`resolveOpenPageReach` and the page tools hand the text
over unfenced, and the tool runner learns nothing about grants), and it stays
that way. The reasoning: a share is a deliberate act between two accounts of
this deployment, comparable to a membership for the one page, and treating it
as untrusted would make every shared page a place where the assistant cannot
help the person who was invited to work on it.

**The risk carried with it, named as a class.** Whoever may write on a page
can put text there that the reader's assistant reads as part of its context,
and a model can follow instructions it finds in its context. Through a shared
page that is a person outside the reader's own workspace: anybody holding
write access to the page, including the sharer and other grant holders. The
reach of such text is bounded by what the reader's run may do anyway (the
reader's own rights on every call, ADR-092 above, the write mode and the
agent profile), and its writes can be reviewed and taken back (ADR-094); the
bound is the reader's rights, not the page. This is the same class of risk a
page written by another member of one's own workspace carries, which ADR-030
also counts as internal; the decision is to accept it for shares on the same
terms rather than to fence a whole category of collaboration. A reader who
does not trust a page's other writers can chat about it from a workspace whose
`ai.writeMode` is `propose` or `read_only`, so nothing is written without
their decision, and a sharer who does not trust a reader gives a `READ`
grant.

**A cover the reader asks for is the reader's to pay.** A cover requested by
somebody who reached the page through a share, and not through a membership
of its workspace, is drawn on one of the reader's own workspaces: the asking
run's workspace when an AI run asks (read from the run id signed into the
service token, never from the request), otherwise the first workspace in the
reader's own order that is not an agent memory area, which is the one the
chat panel picks on a shared page by default. That workspace's settings
decide whether a picture may be drawn, its key draws it (ADR-090, ADR-091:
an unreadable key ends the cover, nothing steps in) and the `ai_run` row of
kind `IMAGE` is written there. A reader without any workspace of their own
is refused with `ai_image_no_own_workspace`: there is no key that could be
asked, and the page's workspace does not pay for somebody else's picture. A
member, and the page's owner, pay on the page's workspace exactly as before.
The decision lives in `resolveCoverPayer`
(`apps/api/src/documents/cover-payer.ts`) and travels to the worker as the
job's `billingWorkspaceId`. Because the finished picture is installed as an
upload onto the page, which ADR-044 grants a share holder only with `WRITE`
on the branch, the request is refused before anything is drawn when the
grant could not carry it; a `PAGE_ONLY` grant cannot set a cover today.

## Alternatives considered

**Run the chat in the page's workspace.** The sharer would pay for, and be
able to list, conversations they are not part of, and the reader would be
handed that workspace's model choice and rule pages. Rejected by the decision
of 2026-11-25.

**A separate, personal chat area for shared pages.** A conversation already
belongs to a workspace for every reason above; a second home would need its
own key, budget and settings, all of which a workspace already has.
