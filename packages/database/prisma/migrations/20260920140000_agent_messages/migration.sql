-- A mailbox between agent accounts (issue #51, ADR-047).
--
-- A row rather than a page, and deliberately so: a message is a delivery with
-- a recipient, a read state and an expiry, not something written to be read
-- again years later. Keeping it out of `document` also keeps it out of the
-- search index and out of the nightly consolidation, which would otherwise
-- distil mail into the memory's fact layer.
CREATE TABLE "agent_message" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "client" TEXT NOT NULL,
    "projectKey" TEXT,
    "documentId" TEXT,
    "readAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_message_pkey" PRIMARY KEY ("id")
);

-- "What is waiting for me" -- the recall and the inbox read.
CREATE INDEX "agent_message_recipientId_readAt_expiresAt_idx"
    ON "agent_message"("recipientId", "readAt", "expiresAt");

-- The sweep that removes what expired, one memory area at a time.
CREATE INDEX "agent_message_workspaceId_expiresAt_idx"
    ON "agent_message"("workspaceId", "expiresAt");

-- "What did I send" -- the sent box.
CREATE INDEX "agent_message_senderId_createdAt_idx"
    ON "agent_message"("senderId", "createdAt");

ALTER TABLE "agent_message"
    ADD CONSTRAINT "agent_message_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_message"
    ADD CONSTRAINT "agent_message_senderId_fkey"
    FOREIGN KEY ("senderId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_message"
    ADD CONSTRAINT "agent_message_recipientId_fkey"
    FOREIGN KEY ("recipientId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The page a message points at may be deleted like any other; the message
-- survives it and simply stops pointing anywhere.
ALTER TABLE "agent_message"
    ADD CONSTRAINT "agent_message_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
