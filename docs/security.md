# Security

Every rule below is enforced on the server. Hidden UI elements are never an
authorization mechanism.

## Where each rule lives

| Rule                                                       | Enforced in                                                                                                         | Verified by                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Workspace access is checked server-side                    | `WorkspaceAccessService.requireRole`, `canReadWorkspace`                                                            | `security.spec.ts` → "a foreign workspace is not readable"                                                               |
| A shared page hands over nothing around it                 | `WorkspaceAccessService.visibleDocumentIds`, `visiblePath`, `mayListChildren` (ADR-044)                             | `shares.integration.test.ts` → "a share hands over the page and nothing around it"                                       |
| A page-scoped token reaches nothing outside its branch     | `findRole` fails closed; `requireScopedRole` / `requireRoleAnchoredAt` narrow (ADR-044)                             | `shares.integration.test.ts` → "a page-scoped token"                                                                     |
| A public link is read-only and anonymous                   | `document_share_public_is_read_only` check constraint; `PublicSharesService` has no write (ADR-044)                 | `shares.integration.test.ts` → "a public link"                                                                           |
| Document access is checked server-side                     | `WorkspaceAccessService.requireDocumentContext`, `canReadDocument`                                                  | "a document from another workspace is not readable"                                                                      |
| WebSocket subscriptions are checked server-side            | `RealtimeGateway.subscribeWorkspace` + `canSubscribeToWorkspaceRoom`                                                | `policies.test.ts` → "realtime subscriptions"; unauthenticated sockets are disconnected in `handleConnection`            |
| Hocuspocus access is checked server-side                   | `apps/collaboration/src/server.ts` `onAuthenticate`                                                                 | `collaboration.integration.test.ts` (4 tests)                                                                            |
| Withdrawn access reaches connections that are already open | the revocation channel plus the re-authorization sweeps (ADR-029)                                                   | `collaboration.integration.test.ts` → "withdrawing access from an open connection" (3 tests); `realtime.gateway.test.ts` |
| Foreign text cannot make the built-in AI write             | `decideMutation` in `packages/contracts/src/ai-trust.ts`, applied in `apps/worker/src/tool-runner.ts` (ADR-030)     | `ai-trust.test.ts` (10 tests); `tool-runner.test.ts` → "the tool runner as a trust boundary" (8 tests)                   |
| Object storage access is checked server-side               | `AttachmentsService.download` + `canDownloadAttachment`; the bucket is private, downloads are pre-signed            | "an unauthorized attachment download is rejected"                                                                        |
| API keys never reach the browser                           | only `PUBLIC_*` values are exposed (`apps/web/next.config.ts`); `apps/web` may not import `@exocortex/ai`           | `scripts/check-dependency-boundaries.mjs`                                                                                |
| Collaboration tickets expire quickly                       | `COLLABORATION_TICKET_TTL_SECONDS` (default 60, max 600)                                                            | "a collaboration ticket is scoped to one document and expires quickly", "rejects an expired ticket"                      |
| Archived documents cannot be edited                        | `canEditDocument`, plus a second check in `DocumentPersistence.store`                                               | "an archived document cannot be edited", "rejects a write ticket for an archived document by downgrading to read-only"   |
| Deleting a page for good needs ADMIN, and the trash first  | `canDeleteDocument`                                                                                                 | "refuses a member without the ADMIN role", "refuses to delete a page that is not archived"                               |
| Read-only tickets cannot submit updates                    | `connectionConfig.readOnly = true` in `onAuthenticate`                                                              | "refuses updates from a read-only connection"                                                                            |
| Cross-workspace moves are rejected                         | `canMoveDocument`                                                                                                   | "a cross-workspace parent assignment is rejected"                                                                        |
| Circular moves are rejected                                | `wouldCreateCycle` inside the move transaction                                                                      | "a circular move is rejected"                                                                                            |
| All user input is validated                                | `ZodValidationPipe` + `packages/contracts`; job payloads in `createTypedWorker`                                     | "request validation rejects malformed payloads"                                                                          |
| Destructive operations are audited                         | `OutboxService.writeAudit` in the same transaction                                                                  | `AuditLog` rows; audit metadata never contains content                                                                   |
| Secrets are redacted from logs                             | `packages/logger/src/redaction.ts`                                                                                  | `logger.test.ts` (4 tests)                                                                                               |
| Document contents are not written to logs                  | the same redaction list covers `yjsState`, `proseMirrorJson`, `plainText`, `markdown`, `content`                    | `logger.test.ts` → "redacts document payloads"                                                                           |
| Passwords and session tokens are never logged              | redaction list + Better Auth stores only hashes                                                                     | `logger.test.ts`                                                                                                         |
| Upload size is limited                                     | `MAX_UPLOAD_BYTES` in `@fastify/multipart` _and_ a second check in the service; `client_max_body_size 32m` in nginx | `AttachmentsService.upload`                                                                                              |
| MIME types are inspected                                   | `detectMimeType` reads magic bytes; the browser type is only a hint                                                 | "uploads reject a file whose real type is not allowed"                                                                   |
| Rate limiting is enabled                                   | `ThrottlerGuard` (300 req/min) plus explicit Better Auth limits                                                     | `x-ratelimit-*` response headers                                                                                         |
| Secure headers are configured                              | `@fastify/helmet` for the API, `headers()` in `next.config.ts`, plus nginx defaults                                 | "security headers and health endpoints are in place"                                                                     |

## Authentication

- Better Auth 1.7 with the Prisma adapter, email and password.
- Passwords: minimum 12 characters, scrypt-hashed by Better Auth. The seed script
  reproduces the same format so a seeded account can log in normally.
- Sessions: `httpOnly`, `sameSite=lax`, `Secure` when `APP_URL` is HTTPS, cookie
  prefix `exocortex`, 30-day lifetime with a 1-day refresh window.
- Self-registration is **off** (`emailAndPassword.disableSignUp`). This is a
  private deployment for a handful of known people, so an open `/sign-up/email`
  only ever creates accounts nobody asked for, and each one can send a
  verification mail through our SMTP credentials. `/registrieren` does not exist
  in the frontend either. Accounts come from the seed script or from an
  **invitation** (see below); there is no third way in.
- Email verification and password reset send real mail. The relay is configured
  through `SMTP_HOST`/`SMTP_PORT`/`SMTP_FROM` plus the optional
  `SMTP_USER`/`SMTP_PASSWORD` pair; supplying credentials switches the transport
  to STARTTLS and makes it **refuse to send** rather than fall back to a
  plaintext session, so the password cannot cross the wire in the clear. Without
  credentials the mailer talks to Mailpit as before.
- `requireEmailVerification` is `false`. Verification exists to stop someone
  registering with an address they do not own, and `disableSignUp` already makes
  that impossible: a seeded account is created by whoever runs the deployment,
  and an invited one proves the address by the token arriving there and coming
  back (which is why redemption sets `emailVerified` itself). Turning the flag on
  would add nothing and would still lock out any account whose address was never
  verified, which includes the only administrator.
- Sign-in, sign-up and password-reset endpoints have explicit per-IP rate limits
  (10/min, 5/min, 5 per 5 min).
- The sign-in form says when the limiter is what refused it
  (`apps/web/src/lib/auth/sign-in-error.ts`). It used to report every refusal as
  wrong credentials, which sent a throttled person back to retype a password
  that was right and to spend their next attempts on the limiter. Naming it
  leaks nothing, because the count is per client address and not per account:
  the answer is the same whether or not the address belongs to anybody. Which
  half of the credentials was wrong stays unsaid, and that is the part that
  would enumerate accounts.
- Those limits are only worth anything if the client address cannot be chosen by
  the client. Two things guarantee that, and both are load-bearing: nginx sets
  `X-Forwarded-For` to `$remote_addr` rather than appending to what the caller
  sent, and Fastify runs with `trustProxy: 'loopback'`, so a forwarded header is
  only read at all when the connection itself comes from the reverse proxy, and
  the chain is then read from the right-hand end. With `trustProxy: true` and an
  appending nginx, the leftmost entry -- the caller's own -- won, and rotating a
  fake value reset every limit.
- The hop count this used to name (`trustProxy: 1`) is gone, and replacing it was
  not cosmetic. Fastify 5.12 made a numeric `trustProxy` trust nothing, on the
  grounds that a hop count never checks who the immediate peer is. Left as a
  number, `request.ip` would have fallen back to the socket address and every
  per-IP limit above would have keyed on nginx: one bucket for the whole
  internet.

## Invitations

Registration being closed leaves one question: how does anybody else get in? By
invitation, and by nothing else (issue #3).

An `Invitation` row carries the address, the SHA-256 of a token, who sent it,
optionally a workspace and role, an expiry, and the three timestamps that make up
its state (`acceptedAt`, `revokedAt`, plus the expiry). The status shown anywhere
is derived from those, never stored.

The token itself is `exoinv_` plus 32 random bytes, hashed exactly like an `exo_`
API token (`packages/auth/src/invitation-token.ts`): returned once in the
response, never stored, never logged. A database dump therefore cannot be
replayed into accounts.

Properties worth stating:

- **The address is not an input.** `POST /api/invitations/accept` takes the token,
  a name and a password. The address comes from the invitation, so a valid token
  cannot be used to register somebody else's address.
- **One use.** Redemption claims the row with an `updateMany` that only matches
  while `acceptedAt` is null, inside the same transaction that creates the account
  and the membership. Two simultaneous redemptions produce one account and one
  `invitation_already_used`.
- **Every wrong token looks the same.** Unknown, revoked and malformed tokens all
  answer `invitation_invalid` (404). Only expiry gets its own code, because that
  one is actionable by the person holding it.
- **The token stays out of URLs on the API side.** Both public routes are POSTs
  with the token in the body, so it does not reach nginx's access log twice. Once
  is unavoidable: the link a person clicks is a URL. That is why it expires and
  works once.
- **Own rate limits.** `preview` 10/min, `accept` 5/min per address, far below the
  global 300/min. These are the only routes an anonymous request can use to create
  a row, and a redemption costs a scrypt hash.
- **Re-sending rotates the token.** The usual reason to re-send is that the first
  mail went astray, and a link that went astray should stop working.
- **A failed mail does not roll the invitation back.** `emailSent: false` comes
  back with a working link to hand over directly. The alternative would leave an
  administrator with a broken relay and no way to invite anybody, which is the
  situation the feature exists to escape.

Who may invite:

| Caller                    | Where                    | Global admin rights |
| ------------------------- | ------------------------ | ------------------- |
| global `ADMIN`            | any workspace, or none   | may grant           |
| workspace `OWNER`/`ADMIN` | their own workspace only | never               |

The second row does create an instance account as a side effect. That is
deliberate: in a deployment for a handful of friends, a workspace owner who cannot
add a collaborator without the operator turns the operator into a ticket queue.
The authority is bounded to one workspace, carries no global role, and every
invitation is listed with its sender under `/admin/nutzer`.

Expired, unredeemed invitations are deleted by the `prune-invitations`
maintenance sweep 30 days after expiry. Accepted ones stay: that row is the
answer to "where did this account come from".

## Switching an account off

`User.disabledAt` is how somebody stops having access without their history being
rewritten. Pages point at their author through a required `createdById`, so
deleting the account would take the pages with it.

Disabling is not a flag that has to be checked on every request. It takes effect
by removing what the account can act with, in one transaction:

- every `Session` row is deleted,
- every unrevoked `ApiToken` is revoked,
- every `OauthAccessToken` is deleted, so a connector stops working immediately
  rather than at the end of its hour.

What is left is making a _new_ session, and `databaseHooks.session.create.before`
in `packages/auth/src/auth.ts` refuses that while `disabledAt` is set. Every path
that creates a session goes through it: the sign-in form, the OAuth authorization
flow, auto-sign-in after verification. So `SessionGuard` needs no per-request
lookup — the state cannot exist rather than being filtered out afterwards.

Two exceptions are checked on use instead, both for free because the row is
already loaded: an `exo_` API token (belt and braces, it was revoked above) and an
HMAC service token, which is not revocable at all and would otherwise keep working
for the few minutes it lives.

A WebSocket that was authenticated an hour ago has no credential left to lose, so
disabling also publishes an account-wide revocation; see the next section but one.
The collaboration handshake additionally refuses a disabled account outright,
because a collaboration ticket outlives the session that bought it.

The sign-in failure is Better Auth's generic one, not "this account is disabled".
The sign-in form is unauthenticated, and an error that distinguishes "wrong
password" from "account exists but is off" tells anybody who asks which addresses
have accounts here.

Deleting an account is offered only when it authored nothing — no pages, comments
or uploads. Otherwise the API answers `user_has_content` and the UI offers only
disabling. What deletion is for is the invitation that went to the wrong address.
Neither route lets an administrator act on their own account, and neither lets the
last global admin be removed.

## Withdrawing access from an open connection

Everything above is decided per request, which is why a removed member is refused
on their next click. Two channels are decided once and then live for hours: the
application realtime socket and the Yjs collaboration socket. Without a second
mechanism a removed member would keep receiving workspace events, and an editing
session that was writable when it opened would stay writable (issue #62,
ADR-029).

The mechanism is a Redis channel of its own, `exocortex:revocations`, carrying
`{ userId, workspaceId | null, reason }`:

- the API publishes after a role change, a member removal, an account being
  disabled and an account being deleted; `workspaceId: null` means the account
  itself, so every workspace is affected;
- the realtime gateway takes the socket out of that workspace's room and tells
  the browser, which subscribes again and is authorized from scratch. An
  account-scoped revocation disconnects the socket instead;
- the collaboration server marks the connection `readOnly` — which takes effect
  on the very next message, before any close can be acknowledged — and then
  closes the socket, so the client reconnects with a fresh ticket.

Nothing is ever _granted_ into a live connection: a promotion publishes a
revocation exactly like a demotion does, and the wider rights arrive through the
new handshake. A server that quietly upgraded an open connection would be an
authorization path with no handshake to audit.

Redis pub/sub is at-most-once, so the channel is the fast path rather than the
guarantee. Both processes re-authorize their open connections on a timer as well
— every 60 seconds in the gateway, every 30 in the collaboration server — asking
the database what the message would have said. A missed message costs latency,
not correctness.

Removing somebody is `DELETE /api/workspaces/:id/members/:userId`, audited as
`workspace.member_removed`. It is deliberately not an agent tool: access is
handed out and taken away by people.

## API token scopes

A persistent `exo_` token is a credential handed to a machine, so it must be able
to carry less authority than the person who issued it. Otherwise every leaked
token — a CI log, a chat message, a stolen laptop — is a full account takeover.

Three cumulative scopes, stored in `ApiToken.scopes`:

| Scope   | May do                                               |
| ------- | ---------------------------------------------------- |
| `read`  | safe requests (`GET`, `HEAD`, `OPTIONS`)             |
| `write` | additionally create, change and delete content       |
| `admin` | additionally `/api/admin/*` and `/api/me/api-tokens` |

- `TokenScopeGuard` enforces them, running after `SessionGuard` (which resolves
  the credential and its scopes) and before `AdminGuard` (which checks the
  _user's_ role). Both must pass: an administrator holding a read-only token is
  still refused the admin API, and an `admin`-scoped token grants nothing to a
  user who is not one.
- The required scope is **derived** from method and path, not declared per route.
  A `@RequiredScope()` decorator would have to be remembered on every new route,
  and the one that gets forgotten is the one a read-only token can reach.
- Token management needs `admin`, because managing tokens with a token is how a
  narrow credential widens itself into a broad one.
- An empty scope list grants **nothing**. Tokens issued before scoping have an
  empty array; migration `20260808230000_api_token_scopes` backfills the ones in
  use to `read,write`, and anything left over fails closed.
- Cookie sessions and `exos_` service tokens are not scoped. A human at a
  browser already is the account, and a service token is minted per AI run, or
  per MCP request from an OAuth client, from a credential that was itself
  authorized.

## Page shares and page-scoped tokens

Issue #83, [ADR-044](adr/ADR-044-a-grant-is-a-row-on-a-page.md). Three things
that look separate are one grant on one resource: a link anybody may open, a
page handed to another account, and the branch an agent's token is confined to.

**A share is a role.** `DocumentShare` carries `READ` or `WRITE`;
`roleForSharePermission` turns it into `GUEST` or `MEMBER`, and every policy in
`policies.ts` then applies unchanged. A share can never stand in for `ADMIN`, so
deleting a page for good, restoring a snapshot and managing members stay with
the workspace.

**`SUBTREE` is resolved against the hierarchy on every request**
(`loadAncestorChain`), never against a stored list of ids. A page moved inside
the shared branch stays shared, one moved out stops being shared, and one moved
_in_ becomes shared — which is the dangerous direction, so it is announced:
`GET /documents/:id/inherited-shares` before the move, inherited grants at the
top of the share dialog, and a badge on the page whether the grant is on it or
above it.

**A public link is read-only by a check constraint**, not by a validation
somebody has to remember, and `PublicSharesService` has no write path at all. Its
token is 32 random bytes. A request is looked up by its SHA-256; since the
ADR-044 addendum of 2026-09-24 the raw value is also kept, AES-256-GCM under
`CREDENTIAL_ENCRYPTION_KEY` and bound to the page, and returned to ADMIN and
OWNER of the workspace only, never to a member below that and never for a
withdrawn link. A database dump alone still yields no link. The token is never
logged and never written into an audit row — an audit log holding link tokens
would be a list of working links. Unknown, revoked and expired all answer
`share_link_invalid` with the same 404, so a guessed token cannot be told from a
withdrawn one.

**A share cannot be passed on.** Somebody who reached a page through a grant
gets `canShare: false`, sees no share list, and is refused if they call the
route anyway.

**A page-scoped token is confined by the credential, not by the request.**
`ApiTokenPageScope` rows are read by `SessionGuard` into the request context and
consulted only by `WorkspaceAccessService`. Under a confinement, `findRole` and
`requireRole` refuse outright (`token_scope_exceeded`): a route that answers
about a whole workspace has no answer that stays inside one branch. The readers
that _can_ narrow opt in — `requireScopedRole` for search, the tree, link
resolution, the trash and filing suggestions, `requireRoleAnchoredAt` for
creating under a parent or uploading onto a page, `visibleDocumentIds` for
backlinks and related pages. A new workspace-wide route therefore costs a
confined token a refusal, never a leak.

`ApiToken.pageScoped` is a flag rather than "the list is non-empty", because the
scope rows cascade with the pages they name: without it, deleting the last
scoped page would widen the token back to the whole account. A confined token
also cannot mint an unconfined one, and every page it names is checked as a read
by its owner at issue time _and_ against their membership on every request.

**Withdrawal reaches open connections.** A changed, revoked or newly inherited
grant publishes `document_share_changed` on the revocation channel of
[ADR-029](adr/ADR-029-revocation-reaches-open-connections.md), for a widening as
well as a narrowing; the collaboration server's re-authorization sweep already
re-reads `findDocumentContext`, so a missed message costs at most 30 seconds.

## The MCP endpoint and its OAuth server

`POST /api/mcp` ([ADR-018](adr/ADR-018-remote-mcp-over-http.md)) is the one
route in the API that authenticates itself instead of leaving it to
`SessionGuard`, and it is stricter, not looser:

- **No cookies.** Only a bearer token opens it. A cookie travels with any
  request a page can provoke; accepting one would put every mutating tool one
  cross-site request away, and there is no CSRF token to fall back on because
  MCP clients do not have one.
- **An `exo_` token is passed through** to the endpoint's loopback calls into
  the REST API, so `TokenScopeGuard` narrows a tool exactly as it narrows a
  direct request. A read-scoped token cannot write through a tool.
- **An OAuth access token** is a signed `at+jwt`: its signature is checked
  against the keys in `jwks`, together with the issuer, the resource audience
  and the client's `disabled` flag, and then exchanged for a 120-second
  `mcp-tools` service token for the loopback. It opens no other route. Its
  limit is the tool list its endpoint serves.
- **CORS is `*` on this path only**, which is sound precisely because the path
  refuses cookies: a cross-origin caller has nothing ambient to ride on and
  must present a credential a person handed it.

Being an OAuth authorization server is new surface, and the honest summary of
it is: dynamic client registration is open, as the MCP specification requires,
so anyone can create a client row. That row is worth nothing on its own. What
turns it into access is a signed-in person answering the consent screen at
`/verbinden`, and that screen is unconditional — the provider would remember
the first yes and wave every later authorization through, so
`forceConsentPrompt` in the API adds `prompt=consent` before the plugin sees
the request, to the query string and the form body alike. Without that, a
website could redirect a signed-in visitor to the authorization endpoint and
collect a token with nothing visible happening.

Access tokens here are stored nowhere at all, unlike `ApiToken`: since
better-auth 1.7 they are signed `at+jwt` tokens (RFC 9068) bound to the
resource `https://exocortex.app/api/mcp`, verified against the public keys in
`jwks`. That removes a table of plaintext secrets and takes revocation-by-
deletion with it, so the compensations carry more weight than before: they live
one hour, they unlock exactly one endpoint and only that one, and setting
`disabled` on the client — or `disabledAt` on the account — kills every token
it holds at once, because both are checked on each use.

`GET /api/auth/token` is refused. The `jwt` plugin that signs the OAuth tokens
brings it along, and it would hand a signed-in browser a JWT from the same key
set `/api/mcp` trusts.

## CSRF

The architecture is cookie-based, so CSRF protection matters:

- Better Auth validates the `Origin` header against `baseURL` and `trustedOrigins`
  for every state-changing request.
- All cookies are `sameSite=lax`, so cross-site POSTs carry no session.
- The browser only ever calls its own origin; CORS allows exactly `APP_URL` and
  `PUBLIC_API_URL` with credentials.
- The API rejects unknown origins rather than reflecting them.

## Collaboration tickets

```ts
interface CollaborationTicketClaims {
  userId: string;
  documentId: string;
  access: 'read' | 'write';
  expiresAt: number; // unix ms
}
```

- HMAC-SHA256 over a base64url payload, compared with `timingSafeEqual`.
- Scoped to exactly one document and one access mode; the access mode is always
  derived from the server-side policy, never from the client.
- Signed with `COLLABORATION_TICKET_SECRET`, which is **not** the Better Auth
  secret. The collaboration server never receives session cookies or the auth
  secret.
- The Hocuspocus document name is the opaque document id only — no workspace id and
  no permission data.
- On connect the server re-checks membership, the account's `disabledAt` and the
  archival state, and takes the minimum of the ticket claim and the current
  policy, so a ticket can never widen permissions and neither a revoked member
  nor a switched-off account can keep using a ticket inside its TTL.
- A connection that is already open is covered by the revocation channel and the
  sweep below, not by the ticket.

Covered by 9 unit tests (`collaboration-ticket.test.ts`) including a tampered
`access` claim, a foreign document, expiry and malformed input.

## Error responses

```ts
interface ApiErrorResponse {
  code: string; // machine-readable, English, from a fixed list
  message: string; // developer-facing, English
  details?: unknown; // validation details only
  correlationId: string;
}
```

Stack traces are never sent to clients. Unexpected errors are logged with the
correlation id at `error` level; expected rejections at `warn`. The web client maps
codes to German messages in `apps/web/src/lib/api/error-messages.ts`.

## Deployment hardening

- nginx terminates TLS (Let's Encrypt, auto-renewed) and adds HSTS, `nosniff`,
  `X-Frame-Options` and a referrer policy.
- There is **no** HTTP basic auth in front of the application. One guarded the
  deployment while it was private and was removed on 2026-08-09. It had been
  covering two holes that only became visible when removing it was considered:
  Swagger mounted outside every Nest guard, and per-IP login limits that a forged
  `X-Forwarded-For` reset. Both are fixed above; a shield that hides defects is
  worse than no shield, because nobody looks behind it.
- Repeated failed logins are banned by the `exocortex-auth` fail2ban jail, which
  reads the nginx access log (`deploy/README.md`). Rate limiting only slows an
  attacker down; this is what stops one.
- All four application processes bind to `127.0.0.1` only. PostgreSQL, Redis, MinIO
  and Mailpit are published to `127.0.0.1` only.
- systemd units run with `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full`,
  `ProtectHome=true` and a single `ReadWritePaths` entry.

## Reporting

There is no public deployment yet. Once there is, add a `SECURITY.md` with a
contact address and a disclosure window.
