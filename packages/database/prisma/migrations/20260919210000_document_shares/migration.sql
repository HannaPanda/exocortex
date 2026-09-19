-- Issue #83: page shares, public links and page-scoped API tokens (ADR-044).

CREATE TYPE "DocumentShareKind" AS ENUM ('USER', 'PUBLIC_LINK');
CREATE TYPE "DocumentSharePermission" AS ENUM ('READ', 'WRITE');
CREATE TYPE "DocumentShareScope" AS ENUM ('PAGE_ONLY', 'SUBTREE');

CREATE TABLE "document_share" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "kind" "DocumentShareKind" NOT NULL,
    "permission" "DocumentSharePermission" NOT NULL DEFAULT 'READ',
    "scope" "DocumentShareScope" NOT NULL DEFAULT 'PAGE_ONLY',
    "granteeId" TEXT,
    "tokenHash" TEXT,
    "tokenPrefix" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_share_pkey" PRIMARY KEY ("id")
);

-- Exactly one principal per row, and no anonymous write. Prisma can describe
-- neither, and both are the kind of rule that must not depend on the service
-- layer remembering it: a public link that could carry WRITE would be anonymous
-- editing, which the product does not have.
ALTER TABLE "document_share" ADD CONSTRAINT "document_share_one_principal"
    CHECK (
        ("kind" = 'USER' AND "granteeId" IS NOT NULL AND "tokenHash" IS NULL)
        OR ("kind" = 'PUBLIC_LINK' AND "granteeId" IS NULL AND "tokenHash" IS NOT NULL)
    );
ALTER TABLE "document_share" ADD CONSTRAINT "document_share_public_is_read_only"
    CHECK ("kind" <> 'PUBLIC_LINK' OR "permission" = 'READ');

CREATE UNIQUE INDEX "document_share_tokenHash_key" ON "document_share"("tokenHash");
-- Two NULL grantees are distinct in PostgreSQL, so this constrains the account
-- shares (one per page per account) and leaves a page free to carry several
-- public links, which is what rotating one needs.
CREATE UNIQUE INDEX "document_share_documentId_granteeId_key" ON "document_share"("documentId", "granteeId");
CREATE INDEX "document_share_workspaceId_revokedAt_idx" ON "document_share"("workspaceId", "revokedAt");
CREATE INDEX "document_share_granteeId_revokedAt_idx" ON "document_share"("granteeId", "revokedAt");
CREATE INDEX "document_share_documentId_revokedAt_idx" ON "document_share"("documentId", "revokedAt");

ALTER TABLE "document_share" ADD CONSTRAINT "document_share_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_share" ADD CONSTRAINT "document_share_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_share" ADD CONSTRAINT "document_share_granteeId_fkey" FOREIGN KEY ("granteeId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_share" ADD CONSTRAINT "document_share_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Page scopes on API tokens.
ALTER TABLE "api_token" ADD COLUMN "pageScoped" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "api_token_page_scope" (
    "id" TEXT NOT NULL,
    "apiTokenId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "scope" "DocumentShareScope" NOT NULL DEFAULT 'SUBTREE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_token_page_scope_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "api_token_page_scope_apiTokenId_documentId_key" ON "api_token_page_scope"("apiTokenId", "documentId");
CREATE INDEX "api_token_page_scope_documentId_idx" ON "api_token_page_scope"("documentId");

ALTER TABLE "api_token_page_scope" ADD CONSTRAINT "api_token_page_scope_apiTokenId_fkey" FOREIGN KEY ("apiTokenId") REFERENCES "api_token"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "api_token_page_scope" ADD CONSTRAINT "api_token_page_scope_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
