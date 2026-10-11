-- Issue #145, ADR-073: a run's timeline as facts, and where the operator's tools pick it up.

-- AlterTable
ALTER TABLE "ai_run" ADD COLUMN "correlationId" TEXT,
ADD COLUMN "traceId" TEXT;

-- CreateTable
CREATE TABLE "ai_run_event" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationMs" INTEGER,
    "data" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "ai_run_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_run_event_runId_sequence_key" ON "ai_run_event"("runId", "sequence");

-- AddForeignKey
ALTER TABLE "ai_run_event" ADD CONSTRAINT "ai_run_event_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ai_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
