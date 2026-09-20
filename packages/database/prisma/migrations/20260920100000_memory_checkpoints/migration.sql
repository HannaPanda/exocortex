-- Pre-compaction checkpoints for agent sessions (issue #92).
--
-- Holds no evidence, only the proof that a piece of it was seen: digests,
-- counts and the note that came out of it. ADR-019 keeps the raw transcript
-- out of the database, and this table does not reopen that question.
CREATE TABLE "memory_checkpoint" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "client" TEXT NOT NULL,
    "projectKey" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "messageDigests" TEXT[],
    "messageCount" INTEGER NOT NULL,
    "evidenceChars" INTEGER NOT NULL,
    "documentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_checkpoint_pkey" PRIMARY KEY ("id")
);

-- Two identical calls racing each other resolve to one row.
CREATE UNIQUE INDEX "memory_checkpoint_userId_sessionId_digest_key"
    ON "memory_checkpoint"("userId", "sessionId", "digest");

-- "What has this session already checkpointed" -- the dedup read.
CREATE INDEX "memory_checkpoint_userId_sessionId_createdAt_idx"
    ON "memory_checkpoint"("userId", "sessionId", "createdAt");

-- The retention sweep, which works one memory area at a time.
CREATE INDEX "memory_checkpoint_workspaceId_createdAt_idx"
    ON "memory_checkpoint"("workspaceId", "createdAt");

ALTER TABLE "memory_checkpoint"
    ADD CONSTRAINT "memory_checkpoint_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "memory_checkpoint"
    ADD CONSTRAINT "memory_checkpoint_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The note may be deleted like any other page; the receipt survives it and
-- simply stops pointing anywhere.
ALTER TABLE "memory_checkpoint"
    ADD CONSTRAINT "memory_checkpoint_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
