-- Which view was open when the run's page is a database.
--
-- A collection's rows only mean something through a view's filters and sorts,
-- so a run that knows the page but not the view would describe a different
-- table than the one on screen. SET NULL on delete: losing the view is not a
-- reason to lose the run.
ALTER TABLE "ai_run"
  ADD COLUMN "databaseViewId" TEXT;

ALTER TABLE "ai_run"
  ADD CONSTRAINT "ai_run_databaseViewId_fkey"
  FOREIGN KEY ("databaseViewId") REFERENCES "database_view"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ai_run_databaseViewId_idx" ON "ai_run"("databaseViewId");
