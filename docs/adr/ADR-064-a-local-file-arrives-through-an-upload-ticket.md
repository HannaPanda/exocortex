# ADR-064: a local file arrives through an upload ticket, never through a third host

- Status: accepted
- Date: 2026-09-25
- Relates to: ADR-014 (one tool catalogue), ADR-025 (capability parity),
  ADR-044 (page-scoped credentials), issue #117 (pictures on a page)

## Context

An agent that holds a file on its own disk -- a photo it was sent in a chat, a
PDF it produced, a screenshot -- had two ways to get it into a workspace, and
both were wrong for that case:

- `exo_attachment_upload` takes the file as Base64 inside the tool call. The
  model has to write every byte into its output. A 330 KB photograph is about
  440,000 characters of Base64, which is far beyond what a model can emit in
  one answer.
- `exo_attachment_upload_url` fetches an address. It needs the file to be
  public somewhere first.

Agents chose the second and solved "somewhere public" with whatever they could
write to. On 2026-09-25 an agent copied a photo into the web root of an
unrelated project on this host and linked the page to it. The picture then
lived on a site it had nothing to do with, was world-readable, and did not
even show, because the page carried the foreign address rather than an
attachment (`img-src 'self'`). The agent reported that it had used the URL
upload; it had not.

The gap is structural: there was no way for bytes to go from an agent's disk to
this deployment without passing through either the model or a third host.

## Decision

**A ticket is an address the agent's own script uploads to.**
`exo_attachment_upload_ticket` (`POST /api/workspaces/:id/attachments/upload-tickets`)
returns a one-time `uploadUrl`; the script sends the file there as ordinary
`multipart/form-data` (`POST /api/attachments/upload/:secret`) and gets the
usual `UploadAttachmentResponse` with `embedUrl` back. The bytes never enter a
tool call and never touch another host. `exo_attachment_upload_ticket_get`
reads a ticket's state and its `embedUrl` for an agent that did not see its
script's output.

**The secret names one upload into one place for ten minutes.** 256 random
bits, stored only as a domain-separated SHA-256 hash (`packages/auth/src/upload-ticket.ts`),
returned once, carried in a path segment and never in an `Authorization`
header, so it cannot be mistaken for a bearer credential. It is bound to the
workspace, the page and the optional filename chosen when it was minted; the
upload cannot redirect it.

**Redeeming acts as the credential that minted it.** The ticket records the
user and, when an `exo_` token minted it, that token. On redemption the token
is checked exactly as `SessionGuard` checks one in a header -- the same
function, `assertApiTokenUsable` in `apps/api/src/auth/api-token-credential.ts` --
and must still carry `write`. Its page confinement is installed in the request
context, and the upload's own `requireRoleAnchoredAt` then applies it. So a
revoked token, a narrowed scope, a lost page or a lost membership all close
the ticket, even inside its ten minutes. The ticket grants nothing the
credential could not do itself; it only moves where the request comes from.

**The lifetime never exceeds the minting credential, except a service token's.**
A ticket from an `exo_` token or a browser session expires at the earlier of
ten minutes and the credential's own expiry. A service token is the exception:
the one an OAuth MCP client's call runs on is minted per request and lives two
minutes, from a grant that was itself just verified, and capping at it would
hand out tickets that expire before a script runs. Such a ticket stands on the
account, which redemption re-checks.

**Claim before reading, release on failure.** The redeem route claims the row
with an `updateMany` that only matches an unused, unexpired ticket, before it
reads the body, so an anonymous caller without a valid ticket never makes the
API buffer an upload. If the upload then fails -- no file part, empty file, a
type that is not allowed -- the claim is released and the ticket stays usable
until it expires, because a script's first mistake should not cost the agent
its ticket. Unknown, used and expired tickets answer the same
`upload_ticket_invalid` (404), for the reason `share_link_invalid` does.

**After the claim, the upload is an ordinary upload.** The file goes through
`AttachmentsService.upload` with the same access check, magic-byte detection,
size limit and preview. An attachment that arrived through a ticket is not a
different kind of attachment.

**MCP only.** The built-in AI runs in the worker with no files and no shell, so
both tools are exempt from the AI surface with that reason
(`SURFACE_EXEMPT` in `scripts/check-capability-parity.mjs`). The redeem route
is exempt from the catalogue because a script calls it, not an agent, and the
tools cover minting and reading.

**The descriptions carry the rule.** `exo_attachment_upload`,
`exo_attachment_upload_url` and `exo_page_create` now say which tool fits which
case and that a file is never put on another server to be fetched. The warning
a write gets for a foreign picture names the ticket, and creating a page with
Markdown now returns that warning too: it used to be given only by
`exo_page_write`, which is how the case above went unreported.

## Consequences

- One more public route, throttled to 30 requests a minute per address and
  rejecting malformed secrets before any query.
- A ticket row per mint, deleted by the daily `prune-upload-tickets` sweep a day
  after it expired. The file a ticket produced does not depend on the row.
- A ticket minted by a browser session is not re-checked against a logout
  within its ten minutes; there is no browser flow that mints one, and the
  account and its membership still are checked.
- Base64 upload stays for small content an agent generates itself, and the URL
  upload for a file that is already public. Neither is deprecated; each tool
  now says which case is its own.
