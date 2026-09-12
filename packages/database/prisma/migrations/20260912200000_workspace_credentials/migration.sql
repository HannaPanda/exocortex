-- A workspace brings its own provider key (issue #52, AP7, ADR-023).
--
-- Credentials get their own table rather than a `setting` row: ADR-013 is
-- explicit that a setting is a preference and never a credential, and the
-- settings tables are plaintext JSON that the administration area reads back
-- to a browser. Everything here is AES-256-GCM output; the plaintext exists
-- only in the worker, for the length of one provider call.
--
-- Written by hand, like every migration here: `prisma migrate dev` wants to
-- drop and recreate the full-text search index it does not know about.

CREATE TYPE "WorkspaceCredentialPurpose" AS ENUM ('AI_OPENROUTER');

CREATE TABLE "workspace_credential" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "purpose"     "WorkspaceCredentialPurpose" NOT NULL,
  "ciphertext"  TEXT NOT NULL,
  "iv"          TEXT NOT NULL,
  "authTag"     TEXT NOT NULL,
  "keyVersion"  INTEGER NOT NULL DEFAULT 1,
  "hint"        TEXT NOT NULL,
  "createdById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  "lastUsedAt"  TIMESTAMP(3),

  CONSTRAINT "workspace_credential_pkey" PRIMARY KEY ("id")
);

-- One key per purpose per workspace. Replacing a key is an update of this row,
-- so a workspace can never end up with two and no way to say which one paid.
CREATE UNIQUE INDEX "workspace_credential_workspaceId_purpose_key"
  ON "workspace_credential" ("workspaceId", "purpose");

ALTER TABLE "workspace_credential"
  ADD CONSTRAINT "workspace_credential_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The key outlives the account that stored it, the same way an override does.
ALTER TABLE "workspace_credential"
  ADD CONSTRAINT "workspace_credential_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "user" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Whose money a run spent. Every run that exists today was paid for by the
-- deployment, which is exactly what the default says.
ALTER TABLE "ai_run" ADD COLUMN "usedOwnKey" BOOLEAN NOT NULL DEFAULT false;
