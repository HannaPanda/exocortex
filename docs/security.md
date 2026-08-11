# Security

Every rule below is enforced on the server. Hidden UI elements are never an
authorization mechanism.

## Where each rule lives

| Rule | Enforced in | Verified by |
| ---- | ----------- | ----------- |
| Workspace access is checked server-side | `WorkspaceAccessService.requireRole`, `canReadWorkspace` | `security.spec.ts` → "a foreign workspace is not readable" |
| Document access is checked server-side | `WorkspaceAccessService.requireDocumentContext`, `canReadDocument` | "a document from another workspace is not readable" |
| WebSocket subscriptions are checked server-side | `RealtimeGateway.subscribeWorkspace` + `canSubscribeToWorkspaceRoom` | `policies.test.ts` → "realtime subscriptions"; unauthenticated sockets are disconnected in `handleConnection` |
| Hocuspocus access is checked server-side | `apps/collaboration/src/server.ts` `onAuthenticate` | `collaboration.integration.test.ts` (4 tests) |
| Object storage access is checked server-side | `AttachmentsService.download` + `canDownloadAttachment`; the bucket is private, downloads are pre-signed | "an unauthorized attachment download is rejected" |
| API keys never reach the browser | only `PUBLIC_*` values are exposed (`apps/web/next.config.ts`); `apps/web` may not import `@exocortex/ai` | `scripts/check-dependency-boundaries.mjs` |
| Collaboration tickets expire quickly | `COLLABORATION_TICKET_TTL_SECONDS` (default 60, max 600) | "a collaboration ticket is scoped to one document and expires quickly", "rejects an expired ticket" |
| Archived documents cannot be edited | `canEditDocument`, plus a second check in `DocumentPersistence.store` | "an archived document cannot be edited", "rejects a write ticket for an archived document by downgrading to read-only" |
| Read-only tickets cannot submit updates | `connectionConfig.readOnly = true` in `onAuthenticate` | "refuses updates from a read-only connection" |
| Cross-workspace moves are rejected | `canMoveDocument` | "a cross-workspace parent assignment is rejected" |
| Circular moves are rejected | `wouldCreateCycle` inside the move transaction | "a circular move is rejected" |
| All user input is validated | `ZodValidationPipe` + `packages/contracts`; job payloads in `createTypedWorker` | "request validation rejects malformed payloads" |
| Destructive operations are audited | `OutboxService.writeAudit` in the same transaction | `AuditLog` rows; audit metadata never contains content |
| Secrets are redacted from logs | `packages/logger/src/redaction.ts` | `logger.test.ts` (4 tests) |
| Document contents are not written to logs | the same redaction list covers `yjsState`, `proseMirrorJson`, `plainText`, `markdown`, `content` | `logger.test.ts` → "redacts document payloads" |
| Passwords and session tokens are never logged | redaction list + Better Auth stores only hashes | `logger.test.ts` |
| Upload size is limited | `MAX_UPLOAD_BYTES` in `@fastify/multipart` *and* a second check in the service; `client_max_body_size 32m` in nginx | `AttachmentsService.upload` |
| MIME types are inspected | `detectMimeType` reads magic bytes; the browser type is only a hint | "uploads reject a file whose real type is not allowed" |
| Rate limiting is enabled | `ThrottlerGuard` (300 req/min) plus explicit Better Auth limits | `x-ratelimit-*` response headers |
| Secure headers are configured | `@fastify/helmet` for the API, `headers()` in `next.config.ts`, plus nginx defaults | "security headers and health endpoints are in place" |

## Authentication

* Better Auth 1.6 with the Prisma adapter, email and password.
* Passwords: minimum 12 characters, scrypt-hashed by Better Auth. The seed script
  reproduces the same format so a seeded account can log in normally.
* Sessions: `httpOnly`, `sameSite=lax`, `Secure` when `APP_URL` is HTTPS, cookie
  prefix `exocortex`, 30-day lifetime with a 1-day refresh window.
* Self-registration is **off** (`emailAndPassword.disableSignUp`). This is a
  private deployment for a handful of known people, so an open `/sign-up/email`
  only ever creates accounts nobody asked for, and each one can send a
  verification mail through our SMTP credentials. `/registrieren` does not exist
  in the frontend either. Accounts come from the seed script or an administrator.
* Email verification and password reset send real mail. The relay is configured
  through `SMTP_HOST`/`SMTP_PORT`/`SMTP_FROM` plus the optional
  `SMTP_USER`/`SMTP_PASSWORD` pair; supplying credentials switches the transport
  to STARTTLS and makes it **refuse to send** rather than fall back to a
  plaintext session, so the password cannot cross the wire in the clear. Without
  credentials the mailer talks to Mailpit as before.
* `requireEmailVerification` is `false`. Verification exists to stop someone
  registering with an address they do not own, and `disableSignUp` already makes
  that impossible. Turning it on would still lock out any account whose address
  was never verified, which currently includes the only administrator.
* Sign-in, sign-up and password-reset endpoints have explicit per-IP rate limits
  (10/min, 5/min, 5 per 5 min).
* Those limits are only worth anything if the client address cannot be chosen by
  the client. Two things guarantee that, and both are load-bearing: nginx sets
  `X-Forwarded-For` to `$remote_addr` rather than appending to what the caller
  sent, and Fastify runs with `trustProxy: 1` so the address is read from the
  right-hand end of the chain. With `trustProxy: true` and an appending nginx,
  the leftmost entry -- the caller's own -- won, and rotating a fake value reset
  every limit.

## API token scopes

A persistent `exo_` token is a credential handed to a machine, so it must be able
to carry less authority than the person who issued it. Otherwise every leaked
token — a CI log, a chat message, a stolen laptop — is a full account takeover.

Three cumulative scopes, stored in `ApiToken.scopes`:

| Scope | May do |
| ----- | ------ |
| `read` | safe requests (`GET`, `HEAD`, `OPTIONS`) |
| `write` | additionally create, change and delete content |
| `admin` | additionally `/api/admin/*` and `/api/me/api-tokens` |

* `TokenScopeGuard` enforces them, running after `SessionGuard` (which resolves
  the credential and its scopes) and before `AdminGuard` (which checks the
  *user's* role). Both must pass: an administrator holding a read-only token is
  still refused the admin API, and an `admin`-scoped token grants nothing to a
  user who is not one.
* The required scope is **derived** from method and path, not declared per route.
  A `@RequiredScope()` decorator would have to be remembered on every new route,
  and the one that gets forgotten is the one a read-only token can reach.
* Token management needs `admin`, because managing tokens with a token is how a
  narrow credential widens itself into a broad one.
* An empty scope list grants **nothing**. Tokens issued before scoping have an
  empty array; migration `20260808230000_api_token_scopes` backfills the ones in
  use to `read,write`, and anything left over fails closed.
* Cookie sessions and `exos_` service tokens are not scoped. A human at a
  browser already is the account, and a service token is minted per AI run, or
  per MCP request from an OAuth client, from a credential that was itself
  authorized.

## The MCP endpoint and its OAuth server

`POST /api/mcp` ([ADR-018](adr/ADR-018-remote-mcp-over-http.md)) is the one
route in the API that authenticates itself instead of leaving it to
`SessionGuard`, and it is stricter, not looser:

* **No cookies.** Only a bearer token opens it. A cookie travels with any
  request a page can provoke; accepting one would put every mutating tool one
  cross-site request away, and there is no CSRF token to fall back on because
  MCP clients do not have one.
* **An `exo_` token is passed through** to the endpoint's loopback calls into
  the REST API, so `TokenScopeGuard` narrows a tool exactly as it narrows a
  direct request. A read-scoped token cannot write through a tool.
* **An OAuth access token** is verified against `oauth_access_token`, then
  exchanged for a 120-second `mcp-tools` service token for the loopback. It
  opens no other route. Its limit is the tool list its endpoint serves.
* **CORS is `*` on this path only**, which is sound precisely because the path
  refuses cookies: a cross-origin caller has nothing ambient to ride on and
  must present a credential a person handed it.

Being an OAuth authorization server is new surface, and the honest summary of
it is: dynamic client registration is open, as the MCP specification requires,
so anyone can create a client row. That row is worth nothing on its own. What
turns it into access is a signed-in person answering the consent screen at
`/verbinden`, and that screen is unconditional — Better Auth would only show it
when the *client* asks with `prompt=consent`, so `forceConsentPrompt` in the
API adds the parameter before the plugin sees the request. Without that, a
website could redirect a signed-in visitor to the authorization endpoint and
collect a token with nothing visible happening.

Access tokens here are stored unhashed, unlike `ApiToken`, because the plugin
looks a token up by its value. The compensations are that they live one hour,
that they unlock exactly one endpoint, and that setting `disabled` on the
client kills every token it holds at once, checked on each use.

## CSRF

The architecture is cookie-based, so CSRF protection matters:

* Better Auth validates the `Origin` header against `baseURL` and `trustedOrigins`
  for every state-changing request.
* All cookies are `sameSite=lax`, so cross-site POSTs carry no session.
* The browser only ever calls its own origin; CORS allows exactly `APP_URL` and
  `PUBLIC_API_URL` with credentials.
* The API rejects unknown origins rather than reflecting them.

## Collaboration tickets

```ts
interface CollaborationTicketClaims {
  userId: string;
  documentId: string;
  access: 'read' | 'write';
  expiresAt: number;   // unix ms
}
```

* HMAC-SHA256 over a base64url payload, compared with `timingSafeEqual`.
* Scoped to exactly one document and one access mode; the access mode is always
  derived from the server-side policy, never from the client.
* Signed with `COLLABORATION_TICKET_SECRET`, which is **not** the Better Auth
  secret. The collaboration server never receives session cookies or the auth
  secret.
* The Hocuspocus document name is the opaque document id only — no workspace id and
  no permission data.
* On connect the server re-checks membership and archival state and takes the
  minimum of the ticket claim and the current policy, so a ticket can never widen
  permissions and a revoked member cannot keep using a ticket inside its TTL.

Covered by 9 unit tests (`collaboration-ticket.test.ts`) including a tampered
`access` claim, a foreign document, expiry and malformed input.

## Error responses

```ts
interface ApiErrorResponse {
  code: string;          // machine-readable, English, from a fixed list
  message: string;       // developer-facing, English
  details?: unknown;     // validation details only
  correlationId: string;
}
```

Stack traces are never sent to clients. Unexpected errors are logged with the
correlation id at `error` level; expected rejections at `warn`. The web client maps
codes to German messages in `apps/web/src/lib/api/error-messages.ts`.

## Deployment hardening

* nginx terminates TLS (Let's Encrypt, auto-renewed) and adds HSTS, `nosniff`,
  `X-Frame-Options` and a referrer policy.
* There is **no** HTTP basic auth in front of the application. One guarded the
  deployment while it was private and was removed on 2026-08-09. It had been
  covering two holes that only became visible when removing it was considered:
  Swagger mounted outside every Nest guard, and per-IP login limits that a forged
  `X-Forwarded-For` reset. Both are fixed above; a shield that hides defects is
  worse than no shield, because nobody looks behind it.
* Repeated failed logins are banned by the `exocortex-auth` fail2ban jail, which
  reads the nginx access log (`deploy/README.md`). Rate limiting only slows an
  attacker down; this is what stops one.
* All four application processes bind to `127.0.0.1` only. PostgreSQL, Redis, MinIO
  and Mailpit are published to `127.0.0.1` only.
* systemd units run with `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full`,
  `ProtectHome=true` and a single `ReadWritePaths` entry.

## Reporting

There is no public deployment yet. Once there is, add a `SECURITY.md` with a
contact address and a disclosure window.
