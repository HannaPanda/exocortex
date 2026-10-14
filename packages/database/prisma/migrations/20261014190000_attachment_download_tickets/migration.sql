-- Download tickets (issue #204).
--
-- The mirror of the upload tickets (ADR-064): a one-time address an agent's
-- script GETs one attachment from, so a file that should not pass through the
-- model reaches the agent's disk without its bearer token going into a shell.
-- Only the hash of the secret is stored.
--
-- Everything cascades: a ticket names a file, a user and possibly the token
-- that minted it, and it means nothing once any of them is gone.
-- CreateTable
CREATE TABLE "attachment_download_ticket" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "apiTokenId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachment_download_ticket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attachment_download_ticket_tokenHash_key" ON "attachment_download_ticket"("tokenHash");

-- CreateIndex
CREATE INDEX "attachment_download_ticket_expiresAt_idx" ON "attachment_download_ticket"("expiresAt");

-- AddForeignKey
ALTER TABLE "attachment_download_ticket" ADD CONSTRAINT "attachment_download_ticket_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "attachment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment_download_ticket" ADD CONSTRAINT "attachment_download_ticket_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment_download_ticket" ADD CONSTRAINT "attachment_download_ticket_apiTokenId_fkey" FOREIGN KEY ("apiTokenId") REFERENCES "api_token"("id") ON DELETE CASCADE ON UPDATE CASCADE;
