-- Project workspaces (issue #43, ADR-027).
--
-- A project is a `document` with `type = 'PROJECT'` whose Yjs state holds a
-- file tree rather than a ProseMirror document. `project` is the sidecar with
-- what a page does not have, `project_file` is the derived projection of the
-- tree, and `project_build` is one run of the container.
--
-- Written by hand, like every migration here: `prisma migrate dev` wants to
-- drop and recreate the full-text search index it does not know about.

ALTER TYPE "DocumentType" ADD VALUE 'PROJECT';

CREATE TYPE "ProjectType" AS ENUM ('LATEX');

CREATE TYPE "ProjectEngine" AS ENUM ('PDFLATEX', 'XELATEX', 'LUALATEX');

CREATE TYPE "ProjectBibliography" AS ENUM ('AUTO', 'BIBTEX', 'BIBER', 'NONE');

CREATE TYPE "ProjectFileKind" AS ENUM ('TEXT', 'ASSET');

CREATE TYPE "ProjectBuildStatus" AS ENUM (
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED'
);

CREATE TABLE "project" (
  "documentId"     TEXT NOT NULL,
  "type"           "ProjectType" NOT NULL DEFAULT 'LATEX',
  "rootFile"       TEXT NOT NULL DEFAULT 'main.tex',
  "engine"         "ProjectEngine" NOT NULL DEFAULT 'PDFLATEX',
  "bibliography"   "ProjectBibliography" NOT NULL DEFAULT 'AUTO',
  "materializedAt" TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "project_pkey" PRIMARY KEY ("documentId")
);

ALTER TABLE "project"
  ADD CONSTRAINT "project_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "document" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "project_file" (
  "id"           TEXT NOT NULL,
  "projectId"    TEXT NOT NULL,
  "path"         TEXT NOT NULL,
  "kind"         "ProjectFileKind" NOT NULL,
  "content"      TEXT,
  "attachmentId" TEXT,
  "byteSize"     INTEGER NOT NULL DEFAULT 0,
  "updatedAt"    TIMESTAMP(3) NOT NULL,

  CONSTRAINT "project_file_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_file_projectId_path_key" ON "project_file" ("projectId", "path");
CREATE INDEX "project_file_projectId_kind_idx" ON "project_file" ("projectId", "kind");

ALTER TABLE "project_file"
  ADD CONSTRAINT "project_file_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "project" ("documentId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_file"
  ADD CONSTRAINT "project_file_attachmentId_fkey"
  FOREIGN KEY ("attachmentId") REFERENCES "attachment" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "project_build" (
  "id"                    TEXT NOT NULL,
  "workspaceId"           TEXT NOT NULL,
  "projectId"             TEXT,
  "projectTitle"          TEXT,
  "rootFile"              TEXT NOT NULL,
  "engine"                "ProjectEngine" NOT NULL,
  "bibliography"          "ProjectBibliography" NOT NULL,
  "status"                "ProjectBuildStatus" NOT NULL DEFAULT 'PENDING',
  "inputHash"             TEXT NOT NULL,
  "errorCode"             TEXT,
  "log"                   TEXT,
  "diagnostics"           JSONB NOT NULL DEFAULT '[]',
  "attachmentId"          TEXT,
  "sourceMapAttachmentId" TEXT,
  "pageCount"             INTEGER,
  "createdById"           TEXT,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt"             TIMESTAMP(3),
  "finishedAt"            TIMESTAMP(3),
  "durationMs"            INTEGER,
  "cancelledAt"           TIMESTAMP(3),
  "heartbeatAt"           TIMESTAMP(3),

  CONSTRAINT "project_build_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "project_build_workspaceId_createdAt_idx" ON "project_build" ("workspaceId", "createdAt");
CREATE INDEX "project_build_projectId_createdAt_idx" ON "project_build" ("projectId", "createdAt");
-- The cache lookup: has this exact input already been built successfully?
CREATE INDEX "project_build_inputHash_status_idx" ON "project_build" ("inputHash", "status");
-- The retention sweep and the stale-build reaper, neither of which has a
-- workspace to narrow by.
CREATE INDEX "project_build_createdAt_idx" ON "project_build" ("createdAt");
CREATE INDEX "project_build_status_heartbeatAt_idx" ON "project_build" ("status", "heartbeatAt");

ALTER TABLE "project_build"
  ADD CONSTRAINT "project_build_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_build"
  ADD CONSTRAINT "project_build_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "project" ("documentId") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "project_build"
  ADD CONSTRAINT "project_build_attachmentId_fkey"
  FOREIGN KEY ("attachmentId") REFERENCES "attachment" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "project_build"
  ADD CONSTRAINT "project_build_sourceMapAttachmentId_fkey"
  FOREIGN KEY ("sourceMapAttachmentId") REFERENCES "attachment" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "project_build"
  ADD CONSTRAINT "project_build_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "user" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
