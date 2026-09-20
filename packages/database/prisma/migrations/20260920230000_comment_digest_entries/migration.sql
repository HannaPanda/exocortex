-- Comment mail, collected rather than sent one letter at a time (issue #106,
-- ADR-053).
--
-- The digest needs a persistent, inspectable source, and the two candidates
-- were a checkpoint per person ("everything since 07:00 yesterday") and a row
-- per owed comment. A checkpoint would have to re-derive who a recipient was
-- from comments it reads later -- the same recipient logic in a second place,
-- reading a world that has moved on. A row instead records the decision at the
-- moment the outbox passed the comment, which is where it is already being
-- made for push, and carries nothing but a pointer: what the mail says is read
-- fresh when it is sent.
CREATE TABLE "comment_digest_entry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- When the mail carrying it was handed to the queue. Null means owed, and
    -- stays null however often a send fails: an entry is never lost by a relay
    -- having a bad five minutes.
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "comment_digest_entry_pkey" PRIMARY KEY ("id")
);

-- One entry per person per comment. A redelivered outbox row must not buy
-- somebody a second line in the same mail.
CREATE UNIQUE INDEX "comment_digest_entry_userId_commentId_key"
    ON "comment_digest_entry" ("userId", "commentId");

-- The sweep's query: who is owed something, oldest first. `sentAt` leads
-- because every run asks about the nulls and never about the history.
CREATE INDEX "comment_digest_entry_sentAt_userId_createdAt_idx"
    ON "comment_digest_entry" ("sentAt", "userId", "createdAt");

ALTER TABLE "comment_digest_entry"
    ADD CONSTRAINT "comment_digest_entry_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Cascades on purpose: a deleted comment owes nobody a mail, and a pointer to
-- a row that is gone is exactly the leak this design exists to prevent.
ALTER TABLE "comment_digest_entry"
    ADD CONSTRAINT "comment_digest_entry_commentId_fkey"
    FOREIGN KEY ("commentId") REFERENCES "comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "comment_digest_entry"
    ADD CONSTRAINT "comment_digest_entry_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "comment_digest_entry"
    ADD CONSTRAINT "comment_digest_entry_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
