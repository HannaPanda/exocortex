-- Upload tickets (ADR-064).
--
-- A one-time address an agent's script POSTs a local file to, so the bytes
-- reach this deployment without passing through the model as Base64 or
-- through a public host as a URL. Only the hash of the secret is stored; the
-- secret is handed out once, when the ticket is minted.
--
-- Everything cascades: a ticket names a workspace, a page, a user and possibly
-- the token that minted it, and it means nothing once any of them is gone.
-- The file it produced is the exception and outlives it (SET NULL).
-- CreateTable
CREATE TABLE "attachment_upload_ticket" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "documentId" TEXT,
    "filename" TEXT,
    "createdById" TEXT NOT NULL,
    "apiTokenId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "attachmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachment_upload_ticket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attachment_upload_ticket_tokenHash_key" ON "attachment_upload_ticket"("tokenHash");

-- CreateIndex
CREATE INDEX "attachment_upload_ticket_expiresAt_idx" ON "attachment_upload_ticket"("expiresAt");

-- CreateIndex
CREATE INDEX "attachment_upload_ticket_workspaceId_createdAt_idx" ON "attachment_upload_ticket"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "attachment_upload_ticket" ADD CONSTRAINT "attachment_upload_ticket_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment_upload_ticket" ADD CONSTRAINT "attachment_upload_ticket_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment_upload_ticket" ADD CONSTRAINT "attachment_upload_ticket_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment_upload_ticket" ADD CONSTRAINT "attachment_upload_ticket_apiTokenId_fkey" FOREIGN KEY ("apiTokenId") REFERENCES "api_token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment_upload_ticket" ADD CONSTRAINT "attachment_upload_ticket_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "attachment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

