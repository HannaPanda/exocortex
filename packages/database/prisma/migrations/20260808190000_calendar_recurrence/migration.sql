-- Recurring appointments show their next occurrence, not their first.
--
-- Two additive columns, both nullable, so nothing has to be backfilled:
--
--  * `recurrenceIcs` caches the object's iCalendar body for recurring objects
--    only. The occurrence to display moves with the calendar rather than with
--    the object, and a routine sync deliberately does not fetch a body whose
--    etag is unchanged -- so the rule has to be readable without the network.
--  * `occurrenceStart` records which occurrence the mirrored row currently
--    names, which is what lets a pass skip every row that is already right.
ALTER TABLE "calendar_object_state"
  ADD COLUMN "recurrenceIcs" TEXT,
  ADD COLUMN "occurrenceStart" TIMESTAMP(3);
