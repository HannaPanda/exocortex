-- Distilled facts above the session notes (issue #46).
--
-- Three new tables and one new enum. Purely additive: nothing existing is
-- dropped, no column changes type, so this runs against the live deployment
-- while it serves requests.
--
-- Written by hand, like every migration here: `prisma migrate dev` wants to
-- drop and recreate the full-text search index it does not know about.

CREATE TYPE "MemoryFactStatus" AS ENUM ('CURRENT', 'SUPERSEDED', 'CONFLICTED');

-- One distilled statement. The wording lives in the page it points at; this row
-- is only what a page cannot carry.
CREATE TABLE "memory_fact" (
  "id" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "projectKey" TEXT NOT NULL,
  "status" "MemoryFactStatus" NOT NULL DEFAULT 'CURRENT',
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  "confirmations" INTEGER NOT NULL DEFAULT 1,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastConfirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "supersededById" TEXT,
  "promotedDocumentId" TEXT,
  "promotedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "memory_fact_pkey" PRIMARY KEY ("id")
);

-- One page, one fact. The page is the fact's identity; deleting it deletes this.
CREATE UNIQUE INDEX "memory_fact_documentId_key" ON "memory_fact" ("documentId");

-- The recall query: the current facts of one project, best first.
CREATE INDEX "memory_fact_workspaceId_projectKey_status_confidence_idx"
  ON "memory_fact" ("workspaceId", "projectKey", "status", "confidence");

-- The decay sweep, which asks for facts nobody has confirmed in a while.
CREATE INDEX "memory_fact_status_lastConfirmedAt_idx"
  ON "memory_fact" ("status", "lastConfirmedAt");

CREATE INDEX "memory_fact_supersededById_idx" ON "memory_fact" ("supersededById");

ALTER TABLE "memory_fact"
  ADD CONSTRAINT "memory_fact_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A superseded fact outlives its successor being deleted; it just stops
-- pointing anywhere, which reads as "current again" and is the safe direction.
ALTER TABLE "memory_fact"
  ADD CONSTRAINT "memory_fact_supersededById_fkey"
  FOREIGN KEY ("supersededById") REFERENCES "memory_fact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The cursor: a note listed here has been read by a consolidation run, whether
-- or not it produced anything.
CREATE TABLE "memory_consolidation" (
  "id" TEXT NOT NULL,
  "noteId" TEXT NOT NULL,
  "factsProduced" INTEGER NOT NULL DEFAULT 0,
  "consolidatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "memory_consolidation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "memory_consolidation_noteId_key" ON "memory_consolidation" ("noteId");

ALTER TABLE "memory_consolidation"
  ADD CONSTRAINT "memory_consolidation_noteId_fkey"
  FOREIGN KEY ("noteId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The evidence, by identity rather than by title.
CREATE TABLE "memory_fact_source" (
  "id" TEXT NOT NULL,
  "factId" TEXT NOT NULL,
  "noteId" TEXT NOT NULL,
  "confirming" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "memory_fact_source_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "memory_fact_source_factId_noteId_key"
  ON "memory_fact_source" ("factId", "noteId");

CREATE INDEX "memory_fact_source_noteId_idx" ON "memory_fact_source" ("noteId");

ALTER TABLE "memory_fact_source"
  ADD CONSTRAINT "memory_fact_source_factId_fkey"
  FOREIGN KEY ("factId") REFERENCES "memory_fact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A note ageing out of the memory workspace takes its evidence rows with it.
-- The fact stays: it was distilled precisely so it would outlive the notes.
ALTER TABLE "memory_fact_source"
  ADD CONSTRAINT "memory_fact_source_noteId_fkey"
  FOREIGN KEY ("noteId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
