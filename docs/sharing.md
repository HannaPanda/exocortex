# Sharing pages, and confining a credential to them

Issue #83, [ADR-044](adr/ADR-044-a-grant-is-a-row-on-a-page.md). The security
guarantees live in [security.md](security.md); this is the recipe for changing
the feature.

## The shape of it

| Thing                                             | Where                                                                                                |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| The grant row                                     | `DocumentShare` in `packages/database/prisma/schema.prisma`                                          |
| The confinement row                               | `ApiTokenPageScope`, plus `ApiToken.pageScoped`                                                      |
| Pure decisions                                    | `packages/auth/src/document-grants.ts`                                                               |
| Where every route meets them                      | `packages/auth/src/access.ts`                                                                        |
| Link tokens                                       | `packages/auth/src/share-token.ts`                                                                   |
| Who may hand a page out                           | `canManageShares`, `canShareAtMost`, `canReadShares`                                                 |
| Writing grants                                    | `apps/api/src/shares/shares.service.ts`                                                              |
| The anonymous read                                | `apps/api/src/shares/public-shares.service.ts`                                                       |
| What a shared page may say about its surroundings | `apps/api/src/documents/share-visibility.ts`                                                         |
| Telling the recipient                             | `apps/worker/src/processors/maintenance-tasks/share-notifications.ts`                                |
| Tools                                             | `packages/mcp-tools/src/tools/shares.ts`                                                             |
| Browser                                           | `share-dialog.tsx`, `workspace-shares-page.tsx`, `incoming-shares-page.tsx`, `public-share-page.tsx` |

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
4. **The route is about a whole workspace and cannot narrow** (settings, members,
   automations, anything administrative). Use `requireRole` or `findRole` and do
   nothing else. Both refuse a confined credential with `token_scope_exceeded`,
   which is the intended answer.
5. **The route creates something under a page** (a new page, an upload, an
   import). Use `requireRoleAnchoredAt(workspaceId, userId, parentId)`. It
   refuses a confined credential at the workspace root, and it is also what lets
   the holder of a `WRITE` + `SUBTREE` share add a page inside the branch.

`findMembershipRole` exists for the three questions that are about an _account_
rather than about this request: whether the person a page is being shared with
is already a member, what the realtime gateway should do with a socket, and what
the functions above build on. Reach for it only with one of those in hand.

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

- **A public link is `READ` in three places**: the contract refines it, the
  service hard-codes it, and the database refuses it. Anonymous writing is not a
  setting that defaults to off, it is absent.
- **The raw link token appears in exactly one response**, the one that created
  it. It is not in the list, not in the audit row and not in any log. Rotating a
  link means creating the new one and withdrawing the old, which is why a page
  may carry several links and only one grant per account.
- **An archived page answers a link like a missing one.** Putting a page in the
  trash says it is out of use, and a link that kept serving it would disagree.
- **`pageScoped` is a flag.** See ADR-044: the rows cascade with their pages, so
  "the list is empty" must not mean "unconfined".
- **Attachment addresses on a public page are rewritten textually** to
  `/api/share/<token>/attachments/<id>`. Teaching the Markdown serializer about
  share tokens would make it something that can write a credential into an
  exported file.
