-- Provenance per agent session: a write journal and what a bulk revert needs
-- (issue #49, ADR-022).
--
-- Two new tables, purely additive: nothing existing is dropped, no column
-- changes type, so this runs against the live deployment while it serves
-- requests.
--
-- Written by hand, like every migration here: `prisma migrate dev` wants to
-- drop and recreate the full-text search index it does not know about.

-- One connection an agent held. `externalId` is the id the client chose, and it
-- is unique per user rather than globally: naming somebody else's session id
-- has to land in a row of one's own.
CREATE TABLE "agent_session" (
  "id" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "clientLabel" TEXT,
  "transport" TEXT,
  "credentialId" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_session_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_session_userId_externalId_key"
  ON "agent_session" ("userId", "externalId");

-- The retention sweep asks for sessions nobody has written from in a while.
CREATE INDEX "agent_session_lastSeenAt_idx" ON "agent_session" ("lastSeenAt");

-- One mutation. No content: the snapshot the write already made holds the
-- previous state and this row points at it.
CREATE TABLE "agent_write_journal" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "documentTitle" TEXT,
  "actorId" TEXT,
  "action" TEXT NOT NULL,
  "snapshotBeforeId" TEXT,
  "correlationId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_write_journal_pkey" PRIMARY KEY ("id")
);

-- "What did this session touch, in order": the detail view and the revert.
CREATE INDEX "agent_write_journal_sessionId_createdAt_idx"
  ON "agent_write_journal" ("sessionId", "createdAt");

-- "Who else wrote this page since": what decides whether a revert may proceed.
CREATE INDEX "agent_write_journal_documentId_createdAt_idx"
  ON "agent_write_journal" ("documentId", "createdAt");

ALTER TABLE "agent_session"
  ADD CONSTRAINT "agent_session_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_write_journal"
  ADD CONSTRAINT "agent_write_journal_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "agent_session" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_write_journal"
  ADD CONSTRAINT "agent_write_journal_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_write_journal"
  ADD CONSTRAINT "agent_write_journal_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "user" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Deliberately no foreign key on "documentId" or "snapshotBeforeId": a page
-- deleted for good must not take the record of its deletion with it, and a
-- snapshot aged out by the retention sweep must not delete the journal row that
-- explains why it existed. Both are read defensively.
