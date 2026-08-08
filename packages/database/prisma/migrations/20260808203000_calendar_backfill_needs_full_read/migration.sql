-- Makes the two previous backfills actually happen.
--
-- Both `20260808192000` and `20260808200000` cleared every stored etag to force
-- the next pass to fetch each body once. That is only half the mechanism: a link
-- with a `sync-token` asks the server for *what changed*, and an unchanged object
-- is not listed at all, so a cleared etag is never compared against anything. The
-- bodies were therefore never fetched, and `recurrenceIcs` and `occurrenceStart`
-- stayed empty on every object that had not been edited since.
--
-- Clearing the token is the missing half: without one the next pass reads the
-- whole collection (`readEverything` in `apps/worker/src/calendar/pull.ts`), lists
-- every object, and fetches every body whose stored etag differs -- which, with
-- the etags already NULL, is all of them. The server hands back a fresh token in
-- the same request, so the pass after this one is cheap again.
--
-- Costs one full listing plus one multiget per collection, once.
UPDATE "calendar_link" SET "syncToken" = NULL;
UPDATE "calendar_object_state" SET "etag" = NULL;
