# ADR-044: A grant is a row on a page, and confinement travels with the credential

- Status: accepted
- Date: 2026-09-19

## Context

Until now, access to a page had exactly one source: a membership row in the
page's workspace. Everything else follows from it — `WorkspaceAccessService`
loads the document, looks up the membership, and hands a `WorkspaceRole` to one
of the functions in `policies.ts`. That single source is what has kept the
authorization story small enough to reason about, and it is also why eXocortex
could not do the three things issue #83 asks for:

1. put one page on the open internet behind an unguessable address,
2. hand one page to another account without making them a member of anything,
3. confine an agent's token to one branch of the tree.

They look like three features. They are one question — _who may read or write
this page_ — asked about three different principals, and the issue says so
outright: they belong on one authorization layer rather than as special cases in
individual endpoints.

The trap is what "individual endpoints" means here. A route that loads a page by
id is the easy half. The hard half is everything that answers with pages the
caller did not name: search, the tree, backlinks, related pages, a breadcrumb, a
path in a search hit, the trash, a filing suggestion. Every one of those is a
list of titles, and a list of titles is content. A sharing feature that protects
`GET /documents/:id` and forgets `GET /documents/:id/links` has protected
nothing.

## Decision

**A share is expressed as a role.** `DocumentShare` carries a `permission`, and
`roleForSharePermission` turns it into a `WorkspaceRole`: `READ` makes the
holder a guest of that page, `WRITE` makes them a member of it. From there every
policy in `policies.ts` applies unchanged — archived pages stay read-only,
comments follow the same bar, `resolveCollaborationAccess` hands out the same
ticket. Without this, sharing would need its own copy of every rule about pages,
and the copies would drift the first time one of them was amended. What a share
deliberately cannot stand in for is `ADMIN`: deleting a page for good, restoring
a snapshot and managing members stay with the workspace, so the worst a shared
`WRITE` grant can do is something a member can undo.

**A grant is additive and `SUBTREE` is resolved live.** `selectShareGrant` takes
the strongest grant along the page's chain of ancestors, so a `READ` grant on a
page does not take away a `WRITE` grant on the branch it sits in. The chain is
walked in SQL (`loadAncestorChain`), never against a stored list of ids: that is
what makes a page moved _inside_ a shared branch stay shared, a page moved _out_
of it stop being shared, and a page moved _into_ one become shared — with no job
to keep anything in step. The last of those three is the dangerous one, because
nothing about it looks like publishing, so it is the one the product announces:
`GET /documents/:id/inherited-shares` is asked before the move, the share dialog
puts inherited grants above everything it offers, and the page header carries a
badge whether the grant is on the page or three levels above it.

**Anonymous access is a separate, deliberately tiny surface.** A public link has
no user, so it cannot go through `WorkspaceAccessService`, which starts from a
user id — and inventing an anonymous principal to feed into it would mean every
policy in the system having to consider one. `PublicSharesService` answers three
reads and nothing else: the page, a page below it when the link covers a branch,
and a file hanging on one of them. It answers in `publicSharePageSchema`, which
is not the shape the application uses, because a field that is not in the schema
cannot be leaked by a renderer that forgot to omit it. A link is `READ` by a
check constraint in the database, not by a validation somebody has to remember.

**Confinement rides on the credential, not on the request.** An `ApiToken` may
carry `ApiTokenPageScope` rows; `SessionGuard` reads them and puts them in the
request context, and `WorkspaceAccessService` is the only reader. The
alternative — a parameter threaded through every service method that might one
day touch a page — fails the moment somebody adds a method and forgets the
parameter, and the failure is silent and in the wrong direction.

**Under a confinement, a workspace-wide question fails closed.** `findRole` and
`requireRole` refuse outright for a confined credential. There are about forty
callers of those, written before page scopes existed, and asking each to
remember a new rule is asking the wrong question. A caller that _can_ honour a
confinement says so explicitly: `requireScopedRole` when it will filter its own
answer (search, tree, link resolution, trash, filing suggestions, the share
list), `requireRoleAnchoredAt` when the operation names a page after all
(creating under a parent, uploading onto a page, importing into one).
`visibleDocumentIds` serves the routes that answer with _other_ pages. Adding a
workspace-wide route tomorrow therefore costs a confined token an honest
refusal, never a leak.

**`pageScoped` is a flag, not the length of a list.** The scope rows are deleted
with the pages they name. Without the flag, deleting the last scoped page would
widen the token back to the whole account — a privilege escalation dressed as a
cleanup. A confined token that has lost every page it was given reaches nothing
at all, and a confined token cannot mint an unconfined one.

**Withdrawal reaches open connections.** A changed or revoked grant publishes an
`document_share_changed` revocation on the channel of
[ADR-029](ADR-029-revocation-reaches-open-connections.md), for a widening as
well as a narrowing: a connection authorized under the old grant is replaced
rather than patched. A move publishes one for everybody holding a grant along
the old chain or the new one. The periodic re-authorization sweep in the
collaboration server already calls `findDocumentContext`, so it catches a
missed message without a line of new code.

## Consequences

- One page cannot be shared with the same account twice: `(documentId,
granteeId)` is unique, and two NULL grantees are distinct in PostgreSQL, so
  the same index leaves a page free to carry several public links — which is
  what rotating one needs (create the new one, then withdraw the old).
- A share cannot be passed on. Somebody who reached a page through a grant sees
  no share list, gets `canShare: false`, and is refused if they call the route
  anyway. Re-sharing would let a grant outlive the chain of people who agreed to
  it, and nobody in that chain would see the list.
- A recipient is not a member, so the page opens at `/geteilt/<documentId>`
  rather than inside the workspace shell, and their breadcrumb stops at the
  shared page. `DocumentDetail.viaShare` is what the browser uses to not ask
  three questions it will be refused.
- A confined token is refused on every workspace-wide route, including ones
  where filtering would have been possible. That is a real cost and it is the
  intended one.
- The public page renders Markdown derived from the canonical Yjs state
  ([ADR-007](ADR-007-markdown-as-derived-format.md)) through the same node
  renderer the chat uses, so there is no path from stored content to raw HTML.
  Attachment addresses inside it are rewritten to the public route; the
  rewriting is textual, because a Markdown serializer that knew about share
  tokens is one that could put a credential in a file somebody exports.

## Alternatives considered

**An ACL table with a generic `resource` column.** More general, and the
generality is the problem: a row that can name a page, a project or a calendar
cannot have a foreign key, so nothing deletes it when its target goes, and the
subtree rule has no hierarchy to hang off. `DocumentShare` names a document and
cascades.

**Giving a sharee a `GUEST` membership in the workspace.** It would have reused
the membership path entirely, and it would have handed them the workspace: the
tree, the search, the member list. Sharing one page is not a small membership.

**A list of allowed ids pushed into the search adapter.** The adapter takes no
such list, deliberately ([ADR-042](ADR-042-a-saved-query-stores-the-question.md)),
and an engine that is not PostgreSQL could not honour one. A confined search
over-fetches and filters afterwards instead.

**Page scopes as more values in `ApiTokenScope`.** What a credential may _do_
and what it may do it _to_ are different questions, and folding them together is
how a list of verbs ends up carrying page ids.

## Addendum 2026-09-24: a link's address can be seen again

The original decision treated a public link's token like an API token: the
SHA-256 stored, the raw value returned once and never again. That was the wrong
analogy. An API token authenticates a person and is never meant to leave their
hands; a link authenticates nobody and exists to be passed on. Hiding it after
creation protected nothing a person could name, and it had one visible effect:
somebody who needed the address again minted a second link to the same page,
and the first stayed live and forgotten.

So the token is now also stored sealed, AES-256-GCM under the deployment's
`CREDENTIAL_ENCRYPTION_KEY` with the page id as additional authenticated data
(`sealShareToken` in `packages/auth/src/share-token.ts`). The hash stays the
lookup key, so the anonymous read never needs the key. The address is returned
to whoever may manage the workspace's shares (`canManageShares`: ADMIN and
OWNER), in every list and in the share dialog, and to nobody else: a member
below ADMIN, a guest and a holder of a share see the prefix, because a list any
member could copy links out of would make every member a publisher. A withdrawn
link is never opened. What is kept out of the audit row and the logs is
unchanged.

Two limits follow and are stated rather than hidden. A link made before this
addendum has only its hash, so its address can never be shown again; the
contract says so with `tokenSealed: false`, and the browser offers a fresh link
with the same scope beside it, leaving the old one live until somebody
withdraws it. A deployment without the key keeps the old behaviour, hash only.
