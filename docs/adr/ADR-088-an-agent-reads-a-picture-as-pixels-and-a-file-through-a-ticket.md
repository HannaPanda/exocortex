# ADR-088: an agent reads a picture as pixels and a file through a ticket

- Status: accepted
- Date: 2026-10-14
- Relates to: ADR-009 and ADR-012 (text-only chat path, vision preprocessing),
  ADR-014 (one tool catalogue over the REST API), ADR-030 (foreign content is
  fenced), ADR-044 (page-scoped credentials), ADR-064 (upload tickets),
  issue #177 (stored files and active content), issue #204

## Context

An agent could find a picture on a page -- `exo_page_read` names it as
`/api/attachments/<id>/download` -- and could not look at it.
`exo_attachment_read_text` answers a PNG with metadata and `not_applicable`,
and the download route streams bytes, which no tool can carry because every
tool speaks JSON to the API. The case that made it visible: a page with the
before, after and diff screenshots of a styleguide change, which a multimodal
agent could only judge from somebody's description of them.

The same gap exists for every other file: an agent that wants a PDF on its own
disk had no way to get it there except putting its bearer token into a shell
command.

## Decision

**A picture is read as pixels, by id, one per call.**
`exo_attachment_read_image` calls `GET /api/attachments/:id/image?maxEdge=`,
a JSON route that answers the bytes as Base64 with their facts. Over MCP the
bytes become an `image` content element after the text and stay out of
`structuredContent`, so a client never carries them twice.

- A PNG, JPEG or WebP that fits (`maxEdge`, default 1568, at most 2048, and
  3.75 MB before Base64) is passed through byte for byte. A screenshot diff is
  only worth reading if every pixel is the stored one, which is also why the
  stored preview (a lossy WebP) is never used.
- A larger one is scaled down in its own format, and the edge is halved until
  it fits the byte limit or would be too small to say anything. GIF (first
  frame) and AVIF become PNG, because not every provider takes them.
- SVG is refused (`attachment_not_image`), as is everything that is not a
  raster image: an SVG is a document that can carry script (issue #177), and
  rasterizing foreign XML on the server is a parser in front of somebody
  else's input for a picture a ticket can deliver anyway.
- `exo_page_read` does not inline pictures. Reading one is a decision, because
  each costs the caller a megabyte of context.
- The access check is the download's own (`findAttachmentContext`,
  `canDownloadAttachment`), so a page-confined token reads no picture it could
  not download. The tool carries the attachment fence (`untrustedOutput`).

**The built-in AI is told what a vision model saw.** Its messages stay text
(ADR-009); changing that would reach persistence, compaction and token
estimation for a capability the default model does not have. The worker hands
the picture to a vision model and replaces it with the description, which is
then fenced as attachment content and closes writing under the run's policy
(ADR-030) like any extracted PDF. The describer is the run's own model when it
sees images, otherwise its companion as the conversation or the model row
chose it (ADR-012). With `ai.visionEnabled` off, or no model to ask, the call
fails with a sentence saying so, so the model says it saw nothing rather than
guessing. Seeing the pixels in the main model is a separate decision, should
a default model ever be multimodal.

**Any file reaches an agent's disk through a download ticket.**
`exo_attachment_download_ticket` (`POST /api/attachments/:id/download-tickets`)
returns a one-time address the agent's script GETs
(`GET /api/attachments/download/:secret`). It mirrors ADR-064 in every
property that matters: 256-bit secret, only a purpose-separated hash stored,
ten minutes and never past the minting credential, one fetch, and the redeem
acts as the minting credential, re-checking the token and installing its page
confinement before the ordinary download runs. It is a read by request class,
so a `read` token can mint one. MCP only: the built-in AI has no disk.

## Consequences

- An external multimodal agent can compare before, after and diff pictures by
  reading exactly those three, without loading the page's other images.
- The built-in AI sees a picture through a second model's words. That costs a
  call and loses detail; it is the honest version of what it can do today.
- A new table, `attachment_download_ticket`, pruned by the daily task that
  already prunes upload tickets.
- An image answer can be up to five megabytes of JSON. The route is bounded by
  `MAX_UPLOAD_BYTES` on the way in and by the byte limit on the way out.
