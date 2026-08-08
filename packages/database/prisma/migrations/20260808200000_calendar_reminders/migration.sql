-- Reminders for mirrored appointments.
--
-- `remindedFor` holds the occurrence a reminder has already gone out for, so the
-- sweep can be idempotent by comparing it against `occurrenceStart` rather than
-- by keeping a boolean somebody has to reset.
ALTER TABLE "calendar_object_state"
  ADD COLUMN "remindedFor" TIMESTAMP(3);

-- One forced re-read, so every mirrored appointment gets an `occurrenceStart`.
--
-- Until now that column was filled for recurring objects only, because only a
-- series needed its date recomputed as time passes. The reminder sweep reads it
-- for *every* appointment, and a NULL there means "no date known", which would
-- silently exclude every non-recurring appointment mirrored before this change
-- from ever being announced.
--
-- Clearing the etag makes the next pass fetch each body exactly once and write
-- the column: the sync fetches when the stored etag differs from the reported
-- one, and NULL always differs. Costs one multiget per collection, once.
UPDATE "calendar_object_state" SET "etag" = NULL;

-- The sweep asks for "appointments around now that have not been announced yet",
-- per link. Without this it is a sequential scan every minute.
CREATE INDEX "calendar_object_state_occurrenceStart_idx"
  ON "calendar_object_state" ("occurrenceStart");
