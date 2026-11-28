# Sharing pages, and confining a credential to them

Issue #83, [ADR-044](adr/ADR-044-a-grant-is-a-row-on-a-page.md). The security
guarantees live in [security.md](security.md); this is the recipe for changing
the feature.

## The shape of it

| Thing                                             | Where                                                                                                                                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The grant row                                     | `DocumentShare` in `packages/database/prisma/schema.prisma`                                                                                                                |
| The confinement row                               | `ApiTokenPageScope`, plus `ApiToken.pageScoped`                                                                                                                            |
| Pure decisions                                    | `packages/auth/src/document-grants.ts`                                                                                                                                     |
| Where every route meets them                      | `packages/auth/src/access.ts`                                                                                                                                              |
| Link tokens                                       | `packages/auth/src/share-token.ts`                                                                                                                                         |
| Who may hand a page out                           | `canManageShares`, `canShareAtMost`, `canReadShares`                                                                                                                       |
| Writing grants                                    | `apps/api/src/shares/shares.service.ts`                                                                                                                                    |
| The anonymous read                                | `apps/api/src/shares/public-shares.service.ts`                                                                                                                             |
| What a shared page may say about its surroundings | `apps/api/src/documents/share-visibility.ts`                                                                                                                               |
| Telling the recipient                             | `apps/worker/src/processors/maintenance-tasks/share-notifications.ts`                                                                                                      |
| Tools                                             | `packages/mcp-tools/src/tools/shares.ts`                                                                                                                                   |
| Browser                                           | `share-dialog.tsx`, `workspace-shares-page.tsx`, `shares-page.tsx` (`my-shares-list.tsx`, `incoming-shares-list.tsx`), `share-revoke-confirm.tsx`, `public-share-page.tsx` |
| The navigation of a recipient                     | `shared-with-me-nav.tsx` (in the page tree and as the whole navigation of `/geteilt`), `shared-with-me-commands.tsx` in the palette                                        |

## Adding a route that answers with pages

This is the only part of the feature that is easy to get wrong, so it has a
checklist rather than a paragraph. Pick the one that fits and the rest follows.

1. **The route names one page and acts on it.** Use
   `requireDocumentContext(documentId, userId)`. Nothing else to do: a share, a
   confinement and a membership all resolve there, and the answer is `null` for
   all three failure modes so the caller answers 404 without saying which.
2. **The route names one page and answers with others too** (backlinks, related
   pages, an export's child list). Also call
   `access.visibleDocumentIds(context)` and filter by it. `null` means the whole
   workspace; anything else is a set already closed over the hierarchy.
3. **The route is about a whole workspace and can narrow its answer** (a search,
   a tree, a list). Use `requireScopedRole(workspaceId, userId)` and filter by
   `documentIds` — hits, counts _and_ paths, because a path is a list of titles.
   A route whose whole answer is a set of pages (the tree, link resolution)
   may use `requireScopedReach` instead: it answers a member exactly like
   `requireScopedRole`, and a non-member with page grants with the pages those
   grants reach, `SUBTREE` resolved live, `PAGE_ONLY` as the page alone
   (`throughGrants: true`, role `GUEST`). Never for a search or anything that
   reads text out of the workspace: that stays the member's (issue #327).
4. **The route is about a whole workspace and cannot narrow** (settings, members,
   automations, anything administrative). Use `requireRole` or `findRole` and do
   nothing else. Both refuse a confined credential with `token_scope_exceeded`,
   which is the intended answer.
5. **The route creates something under a page** (a new page, an upload, an
   import). Use `requireRoleAnchoredAt(workspaceId, userId, parentId)`. It
   refuses a confined credential at the workspace root, and it is also what lets
   the holder of a `WRITE` + `SUBTREE` share add a page inside the branch.

One page-level answer carries a little of what sits above the page: a row of a
database (`GET /api/documents/:id/row`, `exo_database_row_get`) comes with the
columns of its database, names, types and options, because a value is
unreadable without them and the page header shows them (issue #254). That is
the schema of the row the reader may already read, nothing more: the
database's other rows, its views and its own title stay behind
`requireDocumentContext` on the database, which a `PAGE_ONLY` grant on the row
does not pass. A relation's linked rows are named only when the reader may read
their database, otherwise the header shows their ids.

A database shared as `PAGE_ONLY` hands over its rows with it, on purpose
(issue #264): the rows are what a database is, so `GET` on its rows and views
passes `requireDocumentContext` on the database and answers every row with its
values. What stays behind the grant is each row as a page of its own: opening
a row, reading its body, changing its values and reaching anything under it
asks `requireDocumentContext` on the row, which only a `SUBTREE` grant
passes. The share dialog says so under the scope whenever the page is a
database (`scopeDatabaseRows` in the `shares` catalogue). A public link is
different, because it serves the page's own body and no rows.

`findMembershipRole` exists for the three questions that are about an _account_
rather than about this request: whether the person a page is being shared with
is already a member, what the realtime gateway should do with a socket, and what
the functions above build on. Reach for it only with one of those in hand.

## The chat on a shared page

Issue #234, [ADR-092](adr/ADR-092-a-shared-page-is-context-for-the-readers-own-chat.md).
A page shared with an account can be talked about in the chat panel at
`/geteilt/<id>`. The conversation belongs to one of the reader's own
workspaces (`resolveChatWorkspace` in `apps/web/src/components/ai/chat-workspace.ts`
picks it, `shared-chat-note.tsx` says so above the transcript), and the shared
page is its open page.

| Where                                        | What it decides                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------- |
| `mayBeConversationPage` (`document-grants`)  | a page of the conversation's workspace, or one reached through a share        |
| `ConversationsService.create`, `postMessage` | refuse any other page with `document_access_denied`                           |
| `resolveOpenPageReach` (`apps/worker`)       | the grant is asked again when the run starts; no grant, no page in the prompt |
| every tool route                             | `findDocumentContext` as the reader, so the grant decides each call, live     |

Two things to keep in mind when changing it: the run's workspace is the
reader's, so anything that reads `run.workspaceId` to find the open page has to
go through `resolveOpenPageReach` instead; and a pinned source is still a page
of the conversation's workspace, so a shared page is never offered as a pin.

Three decisions of issue #264 (ADR-092's addendum) belong here too:

- **The shared page's text is the reader's own material** for ADR-030: it does
  not lock the run's writes, and a `WRITE` grant lets the reader's assistant
  write on the page. The residual risk (whoever may write on the page can put
  text in front of the reader's assistant) is carried knowingly and described
  as a class in ADR-092; it is bounded by the reader's own rights on every call.
- **A cover is paid for by whoever asks**, when they reached the page through
  a share: the asking run's workspace (from the signed run id), otherwise the
  reader's first own workspace, and never the page's workspace
  (`resolveCoverPayer`, ADR-090's addendum). A reader with no workspace of
  their own gets `ai_image_no_own_workspace`. Members pay as before. Installing
  the picture is an upload onto the page, and `requireRoleAnchoredAt` lets a
  grant carry a file only when it is a `WRITE` grant on the branch; the cover
  route asks that before it queues anything, so a `PAGE_ONLY` grant is refused
  up front instead of paying for a picture that could not be set.
- **A database shares its rows, even as "only this page".** See the paragraph
  after the access checklist above.

## Adding a kind of grant

`DocumentShareKind` has two members and a check constraint that says exactly one
principal column is set. A third kind means:

1. a column for its principal, and that constraint extended in the migration,
2. a branch in `WorkspaceAccessService.findDocumentContext` (or a separate
   service, if the principal is not a user — that is what
   `PublicSharesService` is),
3. a row in the share dialog and in the workspace overview,
4. `formatShare` in the tool file, because a grant nobody can read out loud is a
   grant nobody audits.

## Telling the person it concerns

A grant on an account is post, not a push (issue #103): it is still true
tomorrow, and the person it concerns is usually not in eXocortex when it
happens. `SharesService` writes a `document.share.changed` row into the outbox
inside the same transaction as the grant, and the outbox dispatcher turns it
into a mail. Which change sends which mail, and the three cases that send none,
are in [mail.md](mail.md); the shape of the mails is in
`packages/mail/src/templates/share.ts`.

Two things to keep in mind when changing this feature:

- **A new field on `DocumentShare` is not automatically worth a mail.**
  `changesTheGrant` lists the ones that are: what the holder may do, how far it
  reaches, how long it lasts. Adding a field there is a decision to write to
  somebody about it.
- **The event carries ids and nothing else.** The address, the name and the
  title are read when the mail is enqueued, minutes later, from the state that
  holds then. That is what keeps a withdrawn account, a renamed page and a
  grant revoked in between from being announced as they were rather than as
  they are.

## Things that are deliberate

- **What was shared with you stands in the navigation** (issue #232). Every
  workspace's navigation ends, above the trash, with "Mit mir geteilt": the
  incoming grants, each with its title and its origin (who shared it, out of
  which workspace), from the same `GET /api/me/shares` the list on `/geteilt`
  reads. It names the shared page and nothing above it, because that answer
  carries no parent. Inside a workspace the section is absent while the list
  is empty, still loading or failing: it is a second way in, and an empty
  heading under every tree would teach nothing. On `/geteilt` and
  `/geteilt/<id>` the reader is in no workspace of theirs, so the navigation
  there is that list plus their own workspaces, and it says every state out
  loud. A grant that is given, changed or withdrawn reaches the list at once:
  `SharesService.announce` runs on creation too now, and the gateway answers
  a `document_share_changed` revocation with `exocortex.grants.changed` on
  every socket of the grantee, subscribed or not, because a grantee is in no
  workspace room the ordinary drop could reach. A grant that simply expires
  sends nothing and leaves on the next read (returning to the tab reads again).
- **A `SUBTREE` grant unfolds like a tree, and starts at the grant** (issue
  #327). The entry carries a chevron; unfolded, it reads the branch through
  the ordinary `GET /api/workspaces/:id/documents/tree?parentId=<shared page>`,
  which for a recipient answers through `requireScopedReach`: the pages below
  the shared page, never one above it or beside it, and no trash. `PAGE_ONLY`
  has no chevron and its branch would be empty anyway. Opening a shared page
  unfolds the way to it from its breadcrumb, which the API already cuts at the
  grant. On `/geteilt/<id>` every page link (editor links, mentions, section
  links, the breadcrumb, the overview, backlinks, database rows) is built by
  `useDocumentHrefs()` from `lib/document-href-context.tsx` and leads to
  `/geteilt/<id>`, so a click on a page of the same share stays in the shared
  view; a link to a page outside it gets the same refusal there as anywhere.
  `exocortex.grants.changed` also drops the cached branches.
- **A shared row names its people, and lists nobody else.** A row answer
  carries the names of the accounts its Person and created-by cells name
  (`people`, issue #314), so a guest reads the same names a member does. The
  member list a Person picker offers (`GET /api/workspaces/:id/members`) is a
  membership question through `requireRole`, so a guest, and a page-confined
  token, gets none: they can take somebody out of a cell they may edit and add
  nobody. A write can only add a member, which is what keeps `people` from
  becoming a way to read the name behind an arbitrary account id.

- **A public link is `READ` in three places**: the contract refines it, the
  service hard-codes it, and the database refuses it. Anonymous writing is not a
  setting that defaults to off, it is absent.
- **A link's address can be seen again, by those who may manage it.** Since
  the ADR-044 addendum of 2026-09-24 the token is stored sealed
  (`tokenCiphertext`, `tokenIv`, `tokenAuthTag`, `tokenKeyVersion`, all four or
  none by a check constraint), and `toContract` opens it only when the caller
  may manage the workspace's shares and the link is not withdrawn. A member
  below ADMIN gets `tokenPrefix` alone. `tokenSealed` says whether a copy
  exists at all: links made before that day have only their hash, and the
  browser offers to create a fresh one with the same scope beside them
  (`share-link-address.tsx`). The token is still in no audit row and no log. A
  deployment without the key stores the hash alone, as before.
- **An archived page answers a link like a missing one, and so do its files.**
  Putting a page in the trash says it is out of use, and a link that kept
  serving it would disagree. The rule is one check in
  `PublicSharesService.requireInScope`, which the page read and the file
  download both go through (issue #179): the page, the shared root and every
  page between them must be unarchived. For a `SUBTREE` link that means
  archiving a sub-page takes it and everything under it off the link, files
  included, while the rest of the branch stays readable; archiving the shared
  page itself takes everything the link covered off it until the page is
  restored (the link is not withdrawn by that). Pages above the shared
  root are not part of the share and are not consulted. Restoring a page brings
  it back onto the link only if it lands inside the branch again: a page
  restored under an archived parent moves to the top level and is outside it.
- **Withdrawing a grant is asked about before it happens**, in the share dialog
  and in both lists alike (`share-revoke-confirm.tsx`), and the question
  names what it costs: a public link's address stops working for everyone and
  cannot be brought back, while an account can be invited again in the row
  above. The question is inline in the share row rather than a second dialog on
  top of the first: the sentence belongs beside the grant it is about, and
  DESIGN.md rules out reaching for a modal while an inline answer works. The
  safe half of the choice takes focus, so a second Return never destroys
  anything.
- **There are two outgoing lists, and they answer different questions.**
  `GET /api/workspaces/:id/shares` is "what did anybody hand out from here" and
  needs the person to remember the workspace. `GET /api/me/outgoing-shares`
  (`/geteilt`, tab „Von mir geteilt“, `exo_share_mine`) is "what did I hand
  out", across every workspace the caller is still a member of: only the
  caller's own grants, each with its workspace's name and `canRevoke`, because
  withdrawing needs ADMIN there and a role may have changed since. A grant in a
  workspace the caller has left is not listed; the row would name a page they
  may no longer see. A confined credential gets the grants on its branch
  through `requireScopedRole`, one workspace at a time.
- **`pageScoped` is a flag.** See ADR-044: the rows cascade with their pages, so
  "the list is empty" must not mean "unconfined".
- **Attachment addresses on a public page are rewritten textually** to
  `/api/share/<token>/attachments/<id>`. Teaching the Markdown serializer about
  share tokens would make it something that can write a credential into an
  exported file.
