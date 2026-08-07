-- Heartbeat of the worker processing an AI run.
--
-- A RUNNING run without a recent heartbeat has lost its worker: the process
-- crashed, was killed by a deploy restart, or the job stalled. Additive and
-- nullable, so this is safe on the running database and an older worker
-- process keeps working (see reap-stale-ai-runs,
-- apps/worker/src/processors/maintenance.ts).
ALTER TABLE "ai_run"
  ADD COLUMN "heartbeatAt" TIMESTAMP(3);

CREATE INDEX "ai_run_status_heartbeatAt_idx" ON "ai_run"("status", "heartbeatAt");
