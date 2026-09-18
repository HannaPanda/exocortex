-- Issue #79 (ADR-039): a template is an ordinary page plus this sidecar.
CREATE TABLE "document_template" (
    "documentId" TEXT NOT NULL,
    "description" TEXT,
    "titlePattern" TEXT,
    "targetParentId" TEXT,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_template_pkey" PRIMARY KEY ("documentId")
);

CREATE INDEX "document_template_targetParentId_idx" ON "document_template"("targetParentId");

ALTER TABLE "document_template" ADD CONSTRAINT "document_template_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Deleting the suggested target costs the suggestion, not the template.
ALTER TABLE "document_template" ADD CONSTRAINT "document_template_targetParentId_fkey" FOREIGN KEY ("targetParentId") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
