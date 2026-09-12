-- Automations: rules that react to page changes (issue #50, ADR-024).
--
-- Two tables and one pair of columns. The columns on `outbox_event` are the
-- interesting half: they are what stops a rule whose action writes a page from
-- triggering itself for ever. The dispatcher reads them before it matches a
-- rule, so a chain that gets past `AUTOMATION_MAX_DEPTH` simply stops instead
-- of being noticed afterwards in a log.
--
-- Written by hand, like every migration here: `prisma migrate dev` wants to
-- drop and recreate the full-text search index it does not know about.

CREATE TYPE "AutomationTrigger" AS ENUM (
  'DOCUMENT_CREATED',
  'DOCUMENT_UPDATED',
  'DOCUMENT_CONTENT_CHANGED',
  'DOCUMENT_MOVED',
  'DOCUMENT_ARCHIVED',
  'DOCUMENT_DELETED',
  'DATABASE_ROW_CHANGED'
);

CREATE TYPE "AutomationScope" AS ENUM ('WORKSPACE', 'SUBTREE', 'DATABASE');

CREATE TYPE "AutomationAction" AS ENUM ('WEBHOOK', 'AI_RUN');

CREATE TYPE "AutomationOutput" AS ENUM ('COMMENT', 'CHILD_PAGE');

CREATE TYPE "AutomationRunStatus" AS ENUM (
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'SKIPPED'
);

CREATE TABLE "automation_rule" (
  "id"                  TEXT NOT NULL,
  "workspaceId"         TEXT NOT NULL,
  "name"                TEXT NOT NULL,
  "enabled"             BOOLEAN NOT NULL DEFAULT true,
  "scope"               "AutomationScope" NOT NULL DEFAULT 'WORKSPACE',
  "scopeDocumentId"     TEXT,
  "triggers"            "AutomationTrigger"[],
  "debounceSeconds"     INTEGER NOT NULL DEFAULT 60,
  "action"              "AutomationAction" NOT NULL,
  "webhookUrl"          TEXT,
  "secretCiphertext"    TEXT,
  "secretIv"            TEXT,
  "secretAuthTag"       TEXT,
  "secretKeyVersion"    INTEGER,
  "prompt"              TEXT,
  "modelSlug"           TEXT,
  "output"              "AutomationOutput" NOT NULL DEFAULT 'COMMENT',
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "disabledReason"      TEXT,
  "disabledAt"          TIMESTAMP(3),
  "lastTriggeredAt"     TIMESTAMP(3),
  "createdById"         TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,

  CONSTRAINT "automation_rule_pkey" PRIMARY KEY ("id")
);

-- The dispatcher's query, on every domain event: the enabled rules of one
-- workspace. This is the hot path of the whole feature.
CREATE INDEX "automation_rule_workspaceId_enabled_idx"
  ON "automation_rule" ("workspaceId", "enabled");
CREATE INDEX "automation_rule_scopeDocumentId_idx"
  ON "automation_rule" ("scopeDocumentId");

ALTER TABLE "automation_rule"
  ADD CONSTRAINT "automation_rule_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- A rule scoped to a page that is deleted for good has no scope left, and a
-- rule with no scope would silently widen to the whole workspace. It goes.
ALTER TABLE "automation_rule"
  ADD CONSTRAINT "automation_rule_scopeDocumentId_fkey"
  FOREIGN KEY ("scopeDocumentId") REFERENCES "document" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The rule outlives the account that made it, so a colleague leaving leaves a
-- visible rule rather than a missing one. It stops acting: the processor needs
-- an owner to act as.
ALTER TABLE "automation_rule"
  ADD CONSTRAINT "automation_rule_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "user" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "automation_run" (
  "id"            TEXT NOT NULL,
  "ruleId"        TEXT NOT NULL,
  "workspaceId"   TEXT NOT NULL,
  "documentId"    TEXT,
  "documentTitle" TEXT,
  "trigger"       "AutomationTrigger" NOT NULL,
  "status"        "AutomationRunStatus" NOT NULL DEFAULT 'PENDING',
  "depth"         INTEGER NOT NULL DEFAULT 0,
  "startedAt"     TIMESTAMP(3),
  "finishedAt"    TIMESTAMP(3),
  "durationMs"    INTEGER,
  "error"         TEXT,
  "detail"        JSONB,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "automation_run_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "automation_run_ruleId_createdAt_idx"
  ON "automation_run" ("ruleId", "createdAt");
CREATE INDEX "automation_run_workspaceId_createdAt_idx"
  ON "automation_run" ("workspaceId", "createdAt");
-- The retention sweep, which has no workspace to narrow by.
CREATE INDEX "automation_run_createdAt_idx" ON "automation_run" ("createdAt");

ALTER TABLE "automation_run"
  ADD CONSTRAINT "automation_run_ruleId_fkey"
  FOREIGN KEY ("ruleId") REFERENCES "automation_rule" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "automation_run"
  ADD CONSTRAINT "automation_run_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The page keeps its own history when it is deleted; the run keeps the title it
-- copied, so the log can still say which page this was about.
ALTER TABLE "automation_run"
  ADD CONSTRAINT "automation_run_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "document" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Where a write came from. Deliberately not a foreign key: the dispatcher has
-- to be able to read the origin of an event whose rule has since been deleted,
-- and a cascade would take exactly those rows away.
ALTER TABLE "outbox_event" ADD COLUMN "automationRuleId" TEXT;
ALTER TABLE "outbox_event" ADD COLUMN "automationDepth" INTEGER NOT NULL DEFAULT 0;
