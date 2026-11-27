# ADR-095: A chat picture belongs to its conversation and is described once

- Status: accepted, amended by ADR-096 (own uploads), ADR-097 (pixels for a
  model that sees) and the section "Documents, and what a compaction keeps"
  below (2026-11-27)
- Date: 2026-11-27
- Relates to: ADR-009 and ADR-012 (the loop stays text, pictures arrive as a
  description), ADR-030 (foreign content closes writing), ADR-064 and ADR-088
  (a file always has an owner that collects it), ADR-050 (what reads an
  attachment), issue #223

## Context

A picture could reach the built-in AI only by being placed on a page first:
the open page's images are described before a run (ADR-012), and an agent can
read one by id (ADR-088). Somebody who wants to ask about a screenshot had to
create a page for it, which is a document nobody wanted, in a tree that is
meant to be curated. Every chat client people know takes a picture in the
message itself, by paste, by drop or by a file picker.

Three questions had to be answered before that could be built: who owns a file
that is on no page, what the model is given, and what that does to a run's
right to write.

## Decision

**A chat picture is an ordinary `Attachment` whose owner is the conversation.**
`Attachment.conversationId` points at `ai_conversation` with `ON DELETE
CASCADE`, and a check constraint keeps it off every page
(`attachment_chat_not_on_page`). So the upload goes through the one upload
path, with its size limit, its magic-byte sniffing and its preview, and no
second set of limits exists. Only the person who uploaded it can read it
(`findAttachmentContext`), because a conversation is private to its owner even
inside a shared workspace. A cover, an imported cover and a project asset
refuse such a file, so it can never be carried onto a page by id.

**A picture is uploaded when it is added and bound when the message is sent.**
`POST /api/ai/conversations/:id/attachments` stores it with no message; the
message names it in `attachmentIds`, and the send checks that every id is
unsent, of this conversation and the caller's own before anything is written
(`ai_chat_attachment_invalid`). The number waiting for one message is capped by
`ai.visionMaxImagesPerRun`, the setting that already caps how many pictures a
run describes, so the composer can never hold more than the next run reads
(`ai_chat_attachments_limit`). Only the image types an agent can read are
accepted (`isAttachmentImageSource`), no SVG; documents followed, see below.

**Nothing is left behind.** Deleting a conversation for good removes the rows
by cascade and the stored objects explicitly, after the transaction, and says
how many (`attachmentsDeleted`). A picture that was uploaded and never sent is
collected by the daily `collect-orphaned-covers` task after a day, row first,
objects after.

**The model is given a description, written once.** The loop's messages stay
text (ADR-009); real pixels are not sent even to a model that could read them,
because the transcript, the compaction, the replay and the provider routing
all assume text, and a second message shape would have to be carried through
every one of them. The first run that sees an undescribed picture on a message
still in the context describes it with the same describer as the page's
pictures (the main model when it sees, otherwise the companion), scaled like
ADR-088's image read, and stores the text on the row
(`imageDescription`, `imageDescribedAt`, `imageDescriptionModel`). Every later
turn reads the stored text, so a conversation pays for a picture once. A
picture that cannot be described is named as unseen, with the instruction to
say so rather than guess.

**The description is fenced, and it closes writing.** When the transcript is
loaded, a system message stands before each user message with pictures; the
descriptions in it are fenced as `attachment` content. A run whose active
transcript carries a described chat picture notes untrusted content, exactly
like a run that described the page's pictures (ADR-030). A picture is a
channel for text somebody else wrote, whoever uploaded it, and the policy is
the workspace's to loosen, not the upload's.

**Agents read the same thing.** `exo_chat_read` lists each message's pictures
with id, type and description, and `exo_attachment_read_image` reads the
pixels by that id. The upload route itself is exempt from the catalogue: an
agent that wants to show a picture to the built-in AI puts it on a page, which
the AI already reads.

## Documents, and what a compaction keeps

Added on 2026-11-27, still issue #223.

**A document is the same kind of row, read through its text.** PDFs and the
office types go through the extraction chain every attachment already has
(ADR-050), with its limits; plain text, Markdown, CSV and JSON have no engine,
so the upload stores their bytes as the text itself (`READY` at once) and
queues the screening of ADR-096. A file a browser hands over without a type is
judged by its extension (`chatAttachmentDeclaredType`), because text has no
magic bytes to sniff. The cap per message is the same setting and counts
pictures and documents together.

**The text is fenced, bounded and waited for.** In the note in front of the
message, a document's text is fenced as `attachment` content like a picture's
description, and one message carries at most 24 000 characters of it into a
turn, shared between its files (`CHAT_DOCUMENT_PROMPT_CHARS`); a cut file says
so outside the fence and names `exo_attachment_read_text` with its id for the
rest. A run waits up to 45 seconds for a text still being extracted or
screened, so the answer to the message reads the file rather than a sentence
saying it is not ready; after that it goes in with that sentence, and a file
nobody could read is named as unread, with the instruction not to guess.
Trust is ADR-096's: an own clean file keeps writing open, anything else closes
it.

**A compaction keeps the files of the messages it took in.** A summary is
written from message text and knows nothing of pictures or documents, so the
messages a compaction retires now point at it (`summarizedIntoId`), and the
transcript is followed back through every summary still active. Their files
are named in one note right after the latest summary: pictures by their
description, fenced, documents by name and id for a later read. `/clear`
retires messages without a summary, so their files leave the context with
them, which is what clearing means.

## Consequences

- The sent question shows its pictures and documents from the message, so
  they survive a reload and a second device, and the tooltip says what the
  assistant was told.
- A picture on a summarised message keeps its description in the context, but
  not its pixels: after a compaction a model that sees reads it as text
  (ADR-097).
- A long PDF costs its share of the 24 000 characters on every turn its
  message is in the context; what a reading budget for long PDFs should be is
  issue #133.
- The start page's field takes the same files (issue #288): they wait there as
  local files and are uploaded into the conversation the panel creates for the
  message.
