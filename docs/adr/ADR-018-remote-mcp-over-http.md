# ADR-018: MCP over HTTP, with OAuth for clients that cannot hold a token

- Status: accepted
- Date: 2026-08-11

## Context

`apps/mcp` is not a network service. It is a stdio JSON-RPC bin that a client
starts as a subprocess ([ADR-014](ADR-014-single-tool-catalogue.md)), and it
authenticates to the REST API with an `exo_` token from its environment. That
shape works for Hermes and Claude Code, which run on a machine somebody
controls and can be handed a token in a config file.

Two clients do not fit it.

**ChatGPT** connects to a URL. It cannot spawn a process on this server, and
its connector configuration has no field for a bearer token: a custom connector
is either unauthenticated or it does OAuth, with the authorization server
discovered from the MCP endpoint itself and the client registering itself
(RFC 7591, RFC 8414, RFC 9728). Nothing about that can be satisfied by handing
someone a token.

**An agent on someone else's machine** can hold a token, and after the basic
auth in front of the deployment was removed on 2026-08-09 it can already reach
`https://exocortex.app/api/` and run `apps/mcp` locally. What it cannot do is
speak MCP _to_ this server, which is what a client that only knows a URL needs.

The original plan in issue #4 was a tunnel or a VPN, so that a remote client
could reach `apps/api` and run the stdio bin at its own end. That still works
and is still the right answer for Hermes. It is no answer at all for ChatGPT,
because the problem there is not reachability, it is transport.

## Decision

**MCP is served over HTTP by `apps/api`, at `POST /api/mcp`, in addition to the
stdio bin.** The protocol dispatch moves into `packages/mcp-tools` so both
transports run the same code; each transport owns only its framing.

**The tools still reach the domain through the REST API, over loopback.** The
HTTP endpoint builds an `ExocortexApiClient` pointed at `http://127.0.0.1:3211`
and the API answers its own request. This costs one extra hop per tool call and
keeps ADR-014 intact: no tool can skip a policy check, because the check is the
same request a browser would make.

**Two credentials open the endpoint, and a cookie is not one of them.**

- An `exo_` API token is passed through unchanged to the loopback call, so
  `TokenScopeGuard` narrows a tool exactly as it narrows a direct call. A
  read-scoped token can list every tool and gets `api_token_insufficient_scope`
  from the writing ones.
- An OAuth access token, issued by `@better-auth/mcp`, is verified by the API
  itself and exchanged for a two-minute service token (`purpose: 'mcp-tools'`)
  for the loopback call. Its limit is the tool list it was served, not a scope.

  Since better-auth 1.7 that token is a signed `at+jwt` (RFC 9068) rather than
  a row, so `verifyMcpAccessToken` checks the signature against the public keys
  in `jwks` -- read straight out of the database, because this process *is* the
  authorization server -- plus the issuer, the resource audience and the `typ`
  header. It then reads two things the signature cannot tell it: whether the
  client has since been switched off, and whether the subject is still an
  account here. The endpoint verifying the token itself is the part that
  matters and is unchanged; what changed underneath it is what a token is.

Cookie sessions are refused. A cookie travels with any request a page can
provoke, so accepting one would make every mutating tool reachable by
cross-site request forgery.

**Consent is unconditional.** The provider asks on its own when it holds no
recorded "yes" for a client, but the first yes would then be the last one; the
API adds `prompt=consent` to every authorization request before the plugin sees
it, in the query string and in the form body alike (`forceConsentPrompt`).
Without that, dynamic registration plus one earlier consent is enough for any
website to obtain a working token silently.

**Deep research gets its own URL.** `POST /api/mcp/research` serves exactly two
tools, `search` and `fetch`, in the shape ChatGPT's deep research connector
requires. `tools/call` resolves names against the list a connection was served,
so the research endpoint cannot reach a writing tool by naming it.

## Consequences

The deployment is now an OAuth authorization server. That is seven new tables,
a consent screen, and a class of endpoint that did not exist before. Dynamic
client registration is open -- explicitly, since better-auth 1.7 refuses it by
default -- which is what the specification asks for and what ChatGPT requires;
the consent screen and `oauth_client.disabled` are what make it survivable. A
registered client that nobody consents to can do nothing.

Access tokens are written down nowhere at all, unlike `ApiToken`. They live one
hour, refresh for thirty days, and open exactly one endpoint, named in their own
audience claim. The cost of that is real: revocation cannot reach a token that
has already been issued, so switching a client off or disabling an account is
checked on every use rather than by deleting rows, and the hour is short for
that reason.

The `jwt` plugin comes with the provider, and it brings `GET /api/auth/token`:
a route that would hand a signed-in browser a JWT from the same key set
`/api/mcp` trusts. It is refused at the door (`SESSION_JWT_PATH`), because a
credential-minting endpoint nobody asked for is surface for its own sake.

Every tool call over HTTP is one line in the log with the credential kind, the
client id and the user, which is how "two agents wrote from two systems" becomes
a question the log can answer. Domain-level auditing is unchanged and automatic:
the writes go through the REST API, so whatever `AuditLog` records for a browser
request it records for a tool.

The confirmation gate for mutating tools now lives in the API process and is
keyed per user, because over HTTP the announcement and the confirmation of a
write arrive as two unrelated requests.

The tunnel and VPN options from issue #4 are not obsolete. They remain the way
to reach the API without exposing anything new, and a remote Hermes should
still prefer running `apps/mcp` locally against `https://exocortex.app`. This
ADR adds a transport; it does not remove one.
