-- Rendering: an existing page published as a file (issue #44, ADR-026).
--
-- Two tables. The artifact is deliberately not a third: a produced PDF is an
-- ordinary `attachment`, so it is downloadable, deletable and text-extractable
-- exactly like an uploaded one, and the extraction is what lets an agent read
-- back what a build actually produced.
--
-- Written by hand, like every migration here: `prisma migrate dev` wants to
-- drop and recreate the full-text search index it does not know about.

CREATE TYPE "Renderer" AS ENUM ('LATEX_PDF');

CREATE TYPE "RenderSource" AS ENUM ('DOCUMENT', 'SUBTREE');

CREATE TYPE "RenderJobStatus" AS ENUM (
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED'
);

CREATE TABLE "render_template" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "renderer"    "Renderer" NOT NULL DEFAULT 'LATEX_PDF',
  "source"      TEXT,
  "variables"   JSONB NOT NULL DEFAULT '[]',
  "createdById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "render_template_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "render_template_workspaceId_name_idx" ON "render_template" ("workspaceId", "name");

ALTER TABLE "render_template"
  ADD CONSTRAINT "render_template_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "render_template"
  ADD CONSTRAINT "render_template_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "user" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "render_job" (
  "id"            TEXT NOT NULL,
  "workspaceId"   TEXT NOT NULL,
  "documentId"    TEXT,
  "documentTitle" TEXT,
  "templateId"    TEXT,
  "templateName"  TEXT,
  "renderer"      "Renderer" NOT NULL DEFAULT 'LATEX_PDF',
  "source"        "RenderSource" NOT NULL DEFAULT 'DOCUMENT',
  "status"        "RenderJobStatus" NOT NULL DEFAULT 'PENDING',
  "variables"     JSONB NOT NULL DEFAULT '{}',
  "inputHash"     TEXT NOT NULL,
  "errorCode"     TEXT,
  "log"           TEXT,
  "attachmentId"  TEXT,
  "createdById"   TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt"     TIMESTAMP(3),
  "finishedAt"    TIMESTAMP(3),
  "durationMs"    INTEGER,
  "cancelledAt"   TIMESTAMP(3),
  "heartbeatAt"   TIMESTAMP(3),

  CONSTRAINT "render_job_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "render_job_workspaceId_createdAt_idx" ON "render_job" ("workspaceId", "createdAt");
CREATE INDEX "render_job_documentId_createdAt_idx" ON "render_job" ("documentId", "createdAt");
-- The cache lookup: has this exact input already been built successfully?
CREATE INDEX "render_job_inputHash_status_idx" ON "render_job" ("inputHash", "status");
-- The retention sweep and the stale-job reaper, neither of which has a
-- workspace to narrow by.
CREATE INDEX "render_job_createdAt_idx" ON "render_job" ("createdAt");
CREATE INDEX "render_job_status_heartbeatAt_idx" ON "render_job" ("status", "heartbeatAt");

ALTER TABLE "render_job"
  ADD CONSTRAINT "render_job_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "render_job"
  ADD CONSTRAINT "render_job_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "document" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "render_job"
  ADD CONSTRAINT "render_job_templateId_fkey"
  FOREIGN KEY ("templateId") REFERENCES "render_template" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "render_job"
  ADD CONSTRAINT "render_job_attachmentId_fkey"
  FOREIGN KEY ("attachmentId") REFERENCES "attachment" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "render_job"
  ADD CONSTRAINT "render_job_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "user" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
