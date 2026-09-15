-- Overview pages (issue #53, ADR-028).
--
-- A page marked as an overview says what its sub-pages are about, and says it
-- from their digests rather than from a body somebody typed once. `document`
-- gains the flag; `document_digest` is the sidecar holding the derived text and
-- the two input hashes that decide whether a refresh has anything to do.
--
-- Written by hand, like every migration here: `prisma migrate dev` wants to
-- drop and recreate the full-text search index it does not know about.

CREATE TYPE "OverviewMode" AS ENUM ('OFF', 'AUTO');

ALTER TABLE "document"
  ADD COLUMN "overviewMode" "OverviewMode" NOT NULL DEFAULT 'OFF';

-- The dispatcher asks "is this page's parent an overview" for every document
-- event, and the sweep asks "which overviews exist in this workspace".
CREATE INDEX "document_workspaceId_overviewMode_idx"
  ON "document" ("workspaceId", "overviewMode");

CREATE TABLE "document_digest" (
  "documentId"       TEXT NOT NULL,
  "summary"          TEXT,
  "summaryInputHash" TEXT,
  "summaryAt"        TIMESTAMP(3),
  "intro"            TEXT,
  "introInputHash"   TEXT,
  "introAt"          TIMESTAMP(3),
  "model"            TEXT,
  "lastError"        TEXT,
  "failedAt"         TIMESTAMP(3),
  "coverAskedAt"     TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,

  CONSTRAINT "document_digest_pkey" PRIMARY KEY ("documentId")
);

ALTER TABLE "document_digest"
  ADD CONSTRAINT "document_digest_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "document" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
