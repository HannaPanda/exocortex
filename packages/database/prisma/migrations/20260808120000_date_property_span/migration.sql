-- DATE properties become spans, so a database can hold calendar events.
--
-- Additive and non-destructive: `dateValue` keeps its meaning (the instant, and
-- from now on the *start* of a span), and both new columns are nullable, so
-- every existing value stays a valid point-in-time date. A DATE property only
-- reads them once its config carries `isRange: true`
-- (`databaseDatePropertyConfigSchema` in @exocortex/contracts), which no
-- existing property does. Nothing to backfill.

-- Exclusive end of the span. NULL means "no stated end", which is deliberately
-- distinct from a zero-length span: an appointment written down without an end
-- is normal, and the calendar renders it with a default duration rather than
-- having a migration invent one.
ALTER TABLE "document_property_value" ADD COLUMN "dateEndValue" TIMESTAMP(3);

-- Whole-day span rather than a time of day. Per value, because one calendar
-- holds birthdays and 14:00 meetings.
ALTER TABLE "document_property_value" ADD COLUMN "dateAllDay" BOOLEAN;

-- Serves the `overlaps` filter operator, which is the query behind every
-- calendar view: it compares the span's start against the window's end and the
-- span's end against the window's start, so it needs both columns of one
-- property in a single index.
CREATE INDEX "document_property_value_propertyId_dateValue_dateEndValue_idx"
  ON "document_property_value" ("propertyId", "dateValue", "dateEndValue");
