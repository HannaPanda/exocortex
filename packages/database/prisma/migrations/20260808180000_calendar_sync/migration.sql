-- Calendar synchronisation: accounts, per-collection links, per-object state.
--
-- Purely additive: three new tables and three new enums, no existing table
-- touched. Nothing here runs until a `calendar_account` row exists, so applying
-- this migration changes no behaviour on its own.
--
-- No credential column anywhere. `calendar_account.credentialRef` names the
-- environment key that holds the secret (Infisical is the source of truth, see
-- deploy/README.md); the database never sees the password.

CREATE TYPE "CalendarProvider" AS ENUM ('CALDAV', 'GOOGLE');
CREATE TYPE "CalendarSyncDirection" AS ENUM ('PULL', 'PUSH', 'BOTH');
CREATE TYPE "CalendarEventOrigin" AS ENUM ('LOCAL', 'REMOTE');

CREATE TABLE "calendar_account" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "provider" "CalendarProvider" NOT NULL,
  "displayName" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "credentialRef" TEXT NOT NULL,
  "baseUrl" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "lastSyncedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "calendar_account_pkey" PRIMARY KEY ("id")
);

-- One account per login per provider and workspace: adding the same mailbox
-- twice would sync every event twice.
CREATE UNIQUE INDEX "calendar_account_workspaceId_provider_username_key"
  ON "calendar_account" ("workspaceId", "provider", "username");

ALTER TABLE "calendar_account"
  ADD CONSTRAINT "calendar_account_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "calendar_link" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "remoteHref" TEXT NOT NULL,
  "remoteDisplayName" TEXT NOT NULL,
  "component" TEXT NOT NULL DEFAULT 'VEVENT',
  "documentId" TEXT NOT NULL,
  "propertyMap" JSONB NOT NULL DEFAULT '{}',
  "direction" "CalendarSyncDirection" NOT NULL DEFAULT 'PULL',
  "syncToken" TEXT,
  -- False for a collection the server reports no sync-token for, such as
  -- mailbox.org's generated "Geburtstage". Those can only be read in full.
  "supportsSyncCollection" BOOLEAN NOT NULL DEFAULT true,
  "ctag" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "lastSyncedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "calendar_link_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "calendar_link_accountId_remoteHref_component_key"
  ON "calendar_link" ("accountId", "remoteHref", "component");

CREATE INDEX "calendar_link_documentId_idx" ON "calendar_link" ("documentId");

ALTER TABLE "calendar_link"
  ADD CONSTRAINT "calendar_link_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "calendar_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Deleting the mirror database deletes the link: without a target there is
-- nothing left to sync into.
ALTER TABLE "calendar_link"
  ADD CONSTRAINT "calendar_link_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "calendar_object_state" (
  "id" TEXT NOT NULL,
  "linkId" TEXT NOT NULL,
  "remoteHref" TEXT NOT NULL,
  "etag" TEXT,
  -- The iCalendar UID. Stable across servers, so the same invitation arriving in
  -- two accounts is recognised as one event.
  "icsUid" TEXT NOT NULL,
  "rowDocumentId" TEXT,
  "origin" "CalendarEventOrigin" NOT NULL DEFAULT 'REMOTE',
  "organizer" TEXT,
  "partStat" TEXT,
  "lastPushedHash" TEXT,
  "remoteUpdatedAt" TIMESTAMP(3),
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Tombstone rather than a DELETE: with remote creation allowed, absence is no
  -- longer a delete signal, so the sync has to remember that this UID *was*
  -- deleted or a later full read recreates it.
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "calendar_object_state_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "calendar_object_state_linkId_remoteHref_key"
  ON "calendar_object_state" ("linkId", "remoteHref");

-- Dedup by UID and tombstone lookups both scan exactly this pair.
CREATE INDEX "calendar_object_state_linkId_icsUid_idx"
  ON "calendar_object_state" ("linkId", "icsUid");

CREATE INDEX "calendar_object_state_rowDocumentId_idx"
  ON "calendar_object_state" ("rowDocumentId");

ALTER TABLE "calendar_object_state"
  ADD CONSTRAINT "calendar_object_state_linkId_fkey"
  FOREIGN KEY ("linkId") REFERENCES "calendar_link"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Deleting the row by hand does not delete what we know about the remote object:
-- the state row survives with a null rowDocumentId, so the next sync can decide
-- whether to recreate it rather than blindly re-adding it.
ALTER TABLE "calendar_object_state"
  ADD CONSTRAINT "calendar_object_state_rowDocumentId_fkey"
  FOREIGN KEY ("rowDocumentId") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
