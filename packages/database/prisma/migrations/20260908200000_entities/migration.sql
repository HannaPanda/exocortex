-- The entity layer (issue #47).
--
-- Three tables and one enum, purely additive. An entity itself gets no table:
-- it is a row in an ordinary ADR-011 database. What is new here is the edge
-- between an entity and the pages that talk about it, and the evidence for a
-- name that is not an entity yet.
--
-- Written by hand, like every migration here: `prisma migrate dev` wants to
-- drop and recreate the full-text search index it does not know about.

CREATE TYPE "EntityMentionSource" AS ENUM ('EXTRACTED', 'MANUAL');

-- One page talks about one entity.
CREATE TABLE "entity_mention" (
  "id" TEXT NOT NULL,
  "entityDocumentId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "alias" TEXT NOT NULL,
  "aliasKey" TEXT NOT NULL,
  "occurrences" INTEGER NOT NULL DEFAULT 1,
  "context" TEXT NOT NULL,
  "source" "EntityMentionSource" NOT NULL DEFAULT 'EXTRACTED',
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "entity_mention_pkey" PRIMARY KEY ("id")
);

-- One edge per pair: twelve occurrences are a counter, not twelve rows.
CREATE UNIQUE INDEX "entity_mention_entityDocumentId_documentId_key"
  ON "entity_mention" ("entityDocumentId", "documentId");

-- "What does this page talk about?", and the delete before a re-extraction.
CREATE INDEX "entity_mention_documentId_idx" ON "entity_mention" ("documentId");

-- The profile query: the pages about this entity, most recent first.
CREATE INDEX "entity_mention_entityDocumentId_lastSeenAt_idx"
  ON "entity_mention" ("entityDocumentId", "lastSeenAt");

-- Both ends cascade: an entity row and a page are both ordinary documents, and
-- an edge to a deleted document is not an unresolved reference, it is nothing.
ALTER TABLE "entity_mention"
  ADD CONSTRAINT "entity_mention_entityDocumentId_fkey"
  FOREIGN KEY ("entityDocumentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "entity_mention"
  ADD CONSTRAINT "entity_mention_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A name that keeps turning up and that no entity answers to yet.
CREATE TABLE "entity_candidate" (
  "id" TEXT NOT NULL,
  "phrase" TEXT NOT NULL,
  "phraseKey" TEXT NOT NULL,
  "dismissedAt" TIMESTAMP(3),
  "promotedDocumentId" TEXT,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "entity_candidate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "entity_candidate_phraseKey_key" ON "entity_candidate" ("phraseKey");

CREATE INDEX "entity_candidate_dismissedAt_lastSeenAt_idx"
  ON "entity_candidate" ("dismissedAt", "lastSeenAt");

-- One page on which a candidate phrase was seen. The reason the threshold
-- counts pages and not edits.
CREATE TABLE "entity_candidate_sighting" (
  "id" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "occurrences" INTEGER NOT NULL DEFAULT 1,
  "context" TEXT NOT NULL,
  "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "entity_candidate_sighting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "entity_candidate_sighting_candidateId_documentId_key"
  ON "entity_candidate_sighting" ("candidateId", "documentId");

CREATE INDEX "entity_candidate_sighting_documentId_idx"
  ON "entity_candidate_sighting" ("documentId");

ALTER TABLE "entity_candidate_sighting"
  ADD CONSTRAINT "entity_candidate_sighting_candidateId_fkey"
  FOREIGN KEY ("candidateId") REFERENCES "entity_candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "entity_candidate_sighting"
  ADD CONSTRAINT "entity_candidate_sighting_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
