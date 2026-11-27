-- A database column that a model fills in (issue #237, ADR-099).
--
-- Three tables and one column:
--
--   database_property_ai   the column's instruction: a preset or its own
--                          words, what the model may read, and whether the
--                          column fills itself when a row is created or
--                          edited. Off unless somebody switched it on.
--   database_ai_fill_run   one batch: the `ai_run` row of kind FILL that pays
--                          for it, and a copy of the instruction it started
--                          with, so an edit halfway changes nothing.
--   database_ai_fill_cell  each cell of the batch and how it ended. The latest
--                          one per row and column is what a cell shows.
--
-- `document_property_value.aiRunId` marks a value a fill wrote; every other
-- write clears it. A plain id rather than a foreign key, like
-- `attachment.propertyId`: it says where a value came from, nothing hangs on
-- it, and a cascade into the largest table here would buy nothing.
--
-- Written by hand, like every migration here: `prisma migrate dev` wants to
-- drop and recreate the full-text search index it does not know about.

-- CreateEnum
CREATE TYPE "DatabaseAiFillPreset" AS ENUM ('SUMMARY', 'KEY_POINTS', 'TAGS', 'TRANSLATE', 'DOCUMENT_DATE', 'SENDER', 'RECIPIENT', 'CUSTOM');

-- CreateEnum
CREATE TYPE "DatabaseAiAutoFill" AS ENUM ('OFF', 'ON_CREATE', 'ON_CHANGE');

-- CreateEnum
CREATE TYPE "DatabaseAiFillMode" AS ENUM ('EMPTY_ONLY', 'REPLACE_AI', 'REPLACE_ALL');

-- CreateEnum
CREATE TYPE "DatabaseAiFillOrigin" AS ENUM ('MANUAL', 'AUTOMATIC');

-- CreateEnum
CREATE TYPE "DatabaseAiFillCellStatus" AS ENUM ('QUEUED', 'RUNNING', 'FILLED', 'EMPTY', 'SKIPPED', 'FAILED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "AiRunKind" ADD VALUE 'FILL';

-- AlterTable
ALTER TABLE "document_property_value" ADD COLUMN     "aiRunId" TEXT;

-- CreateTable
CREATE TABLE "database_property_ai" (
    "propertyId" TEXT NOT NULL,
    "preset" "DatabaseAiFillPreset" NOT NULL,
    "instruction" TEXT,
    "targetLanguage" TEXT,
    "allowNewOptions" BOOLEAN NOT NULL DEFAULT false,
    "useContent" BOOLEAN NOT NULL DEFAULT true,
    "useProperties" BOOLEAN NOT NULL DEFAULT true,
    "useAttachments" BOOLEAN NOT NULL DEFAULT true,
    "autoFill" "DatabaseAiAutoFill" NOT NULL DEFAULT 'OFF',
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "database_property_ai_pkey" PRIMARY KEY ("propertyId")
);

-- CreateTable
CREATE TABLE "database_ai_fill_run" (
    "aiRunId" TEXT NOT NULL,
    "databaseId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "mode" "DatabaseAiFillMode" NOT NULL,
    "origin" "DatabaseAiFillOrigin" NOT NULL DEFAULT 'MANUAL',
    "preset" "DatabaseAiFillPreset" NOT NULL,
    "instruction" TEXT,
    "targetLanguage" TEXT,
    "allowNewOptions" BOOLEAN NOT NULL,
    "useContent" BOOLEAN NOT NULL,
    "useProperties" BOOLEAN NOT NULL,
    "useAttachments" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "database_ai_fill_run_pkey" PRIMARY KEY ("aiRunId")
);

-- CreateTable
CREATE TABLE "database_ai_fill_cell" (
    "id" TEXT NOT NULL,
    "aiRunId" TEXT NOT NULL,
    "rowId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "status" "DatabaseAiFillCellStatus" NOT NULL DEFAULT 'QUEUED',
    "errorCode" TEXT,
    "materialTrusted" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "database_ai_fill_cell_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "database_ai_fill_run_databaseId_createdAt_idx" ON "database_ai_fill_run"("databaseId", "createdAt");

-- CreateIndex
CREATE INDEX "database_ai_fill_run_propertyId_idx" ON "database_ai_fill_run"("propertyId");

-- CreateIndex
CREATE INDEX "database_ai_fill_cell_aiRunId_position_idx" ON "database_ai_fill_cell"("aiRunId", "position");

-- CreateIndex
CREATE INDEX "database_ai_fill_cell_rowId_propertyId_createdAt_idx" ON "database_ai_fill_cell"("rowId", "propertyId", "createdAt");

-- CreateIndex
CREATE INDEX "database_ai_fill_cell_propertyId_idx" ON "database_ai_fill_cell"("propertyId");

-- AddForeignKey
ALTER TABLE "database_property_ai" ADD CONSTRAINT "database_property_ai_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "database_property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_property_ai" ADD CONSTRAINT "database_property_ai_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_ai_fill_run" ADD CONSTRAINT "database_ai_fill_run_aiRunId_fkey" FOREIGN KEY ("aiRunId") REFERENCES "ai_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_ai_fill_run" ADD CONSTRAINT "database_ai_fill_run_databaseId_fkey" FOREIGN KEY ("databaseId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_ai_fill_run" ADD CONSTRAINT "database_ai_fill_run_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "database_property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_ai_fill_cell" ADD CONSTRAINT "database_ai_fill_cell_aiRunId_fkey" FOREIGN KEY ("aiRunId") REFERENCES "database_ai_fill_run"("aiRunId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_ai_fill_cell" ADD CONSTRAINT "database_ai_fill_cell_rowId_fkey" FOREIGN KEY ("rowId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_ai_fill_cell" ADD CONSTRAINT "database_ai_fill_cell_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "database_property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

