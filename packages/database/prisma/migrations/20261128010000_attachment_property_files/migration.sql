-- A file put into a FILES column of a database row (issue #245).
--
-- The file hangs on the row's page (`documentId`), so deleting the row for
-- good deletes it, exactly like a picture in the row's body. `propertyId`
-- says it was uploaded for the column and is not part of the page's text:
-- that is what lets the maintenance sweep collect it once no value of that
-- column names it any more (a removed file, a deleted column, an upload whose
-- value write never happened). A file without the mark is never collected.
--
-- A plain column rather than a foreign key, for the same reason as
-- `outbox_event.automationRuleId`: the mark has to outlive the column it
-- names, because a deleted column is exactly when its files have to go.
--
-- The upload ticket (ADR-064) carries the same target, so an agent's script
-- can upload straight into a cell.
--
-- Written by hand, like every migration here: `prisma migrate dev` wants to
-- drop and recreate the full-text search index it does not know about.

ALTER TABLE "attachment" ADD COLUMN "propertyId" TEXT;
CREATE INDEX "attachment_propertyId_idx" ON "attachment"("propertyId");
-- A chat file belongs to its conversation and never to a cell.
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_property_not_chat" CHECK ("propertyId" IS NULL OR "conversationId" IS NULL);

ALTER TABLE "attachment_upload_ticket" ADD COLUMN "propertyId" TEXT;
