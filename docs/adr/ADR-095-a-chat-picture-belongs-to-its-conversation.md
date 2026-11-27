# ADR-095: A chat picture belongs to its conversation and is described once

- Status: accepted
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
accepted (`isAttachmentImageSource`): no SVG, no PDF yet.

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

## Consequences

- The sent question shows its pictures from the message, so they survive a
  reload and a second device, and the tooltip says what the assistant was told.
- A summary written by compaction is built from message text and does not
  carry the descriptions; a picture on a summarised message is no longer in
  the context.
- PDF and text files in the chat would go through ADR-050's engines and are a
  separate step.
