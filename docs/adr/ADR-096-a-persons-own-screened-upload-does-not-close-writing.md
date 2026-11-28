# ADR-096: A person's own upload, screened clean, does not close writing

- Status: accepted
- Date: 2026-11-27
- Amends: ADR-030 (foreign content closes the door on mutating tools), for one
  origin and one reader
- Relates to: ADR-050 (what reads an attachment), ADR-089 (the decision model),
  ADR-095 (a chat picture belongs to its conversation), issues #223 and #133

## Context

ADR-030 treats every attachment as foreign: a run that reads an extracted PDF,
or the description of a picture, may not change anything afterwards. That was
right for the case it was written for, a document somebody else wrote. It is
wrong for the most ordinary case there is: a person uploads their own file and
asks the assistant to work with it. "Summarise my PDF onto this page" read the
PDF and then refused to write, and a screenshot pasted into the chat did the
same. Johanna decided on 2026-11-27: "Wenn der User was hochlädt, darf der
Agent das normal nutzen. Das ist ja im Prinzip Absicht." Uploading is the
intent; a file the person chose is not a stranger talking.

What the upload does not prove is that the file is harmless. A person can
upload a document written by somebody else that hides a paragraph addressed to
a model. So the trust needs a check in front of it, and the check has to fail
closed.

## Decision

**Trust is a property of a file for one reader, decided from four facts.**
`attachmentTrustFor` (`packages/contracts/src/ai-trust.ts`) answers
`own_screened` (trusted) only when the reader uploaded the file, nobody else
corrected its text, the server did not fetch it from the web for them
(`Attachment.fetchedFromUrl`, set by `uploadFromUrl`), and its screening came
back `clean`. Everything else keeps ADR-030 exactly: `not_own`, `fetched`,
`unscreened`, `flagged`, `screen_failed`. A file another member uploaded, or a
page shared with the reader (ADR-092), stays foreign however clean it is.

**The screening is one question, asked once, by the decision model.** When an
extraction succeeds (`attachment-text`), when a person corrects the text (the
job is enqueued with reason `screen`), and when a chat picture is described,
`screenForAiInstructions` (`packages/ai/src/injection-screen.ts`) asks Jev
through the Decisions API (ADR-089) whether the text addresses instructions to
an AI, in windows of 60,000 characters, and the highest probability decides
(`0.5` and above is a finding). The answer is written on the row: `screening`,
`screenedAt`, `screenModel`, `screenScore`. A decision model answers with a
probability rather than prose, so there is no reply the file can talk its way
into, and it costs about four cents per million input tokens. No key, a
timeout or an error is written as `FAILED`, which is foreign. A correction
clears the answer until it has been asked again. Rows from before the column
are unscreened and stay foreign until the `screen-attachments` sweep has asked
about them; a failed screening is asked again after a day.

**The fence stays; only the lock goes.** A trusted file's text is still fenced
as attachment content, because it is still a document and not a request. What
changes is that reading it does not note an untrusted origin. For a tool, the
API computes the answer for the caller (`trust` on
`GET /api/attachments/:id/text`, the service token carries the requester) and
`exo_attachment_read_text` copies it into `ToolResult.ownScreenedSource`; the
tool runner reads nothing else, never the arguments and never the text. For a
chat picture the worker asks the same predicate about the requester. A file
that is the person's own but stays foreign carries a sentence outside the
fence saying why (`attachmentTrustNote`), so the assistant can tell the person
rather than just stopping, and the picture's tooltip in the chat says the same.

**The run inspector tells the two apart.** A tool call whose answer was a
trusted own file records `ownScreenedSource` instead of an untrusted origin.

## Consequences

- "Summarise my PDF onto the page" writes again, for the person who uploaded
  it. For anybody else, and for a file whose screening found something or
  could not run, nothing changes.
- The screening is a filter, not a proof. A clean answer means nothing obvious
  addressed a model; the system prompt's paragraph about foreign text and the
  fence still apply to a trusted file.
- The open page's pictures, described afresh for every run by the vision
  companion (ADR-012), and pictures a tool returns, are still foreign: their
  description is not stored, so there is nothing that was screened. That
  changes when page pictures are stored or sent as pixels (issue #207).
  Since ADR-102 they are: a page picture's description is stored and, for
  its uploader's own picture on a page of the run's workspace, screened, so
  this predicate now decides it like any other file.
- `exo_context_compile` still leaves attachment text out (ADR-061).
- `ai.untrustedContentPolicy` keeps its meaning: `deny` still refuses every
  write, `allow` still allows them after any foreign text.

## Alternatives considered

- **Trust every own upload without a check.** Simplest, and what Johanna's
  sentence says literally, but a document from a stranger becomes the
  person's own by being uploaded, and that is the case ADR-030 exists for.
- **A chat model reads the file and judges it.** It would answer in prose, and
  prose is what an injected paragraph can steer. A probability is not.
- **Trust per workspace instead of per uploader.** A member's upload is not
  the reader's intent, and ADR-023 lets a workspace only tighten.
