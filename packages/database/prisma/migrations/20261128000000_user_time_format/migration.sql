-- How a time of day is written for this person (issue #255).
--
-- `AUTO` follows the interface language (German writes 14:30, English
-- 2:30 PM), which is the behaviour before this column and the default for
-- everybody who never chose. `H24` and `H12` hold the clock whatever the
-- language. Only the rendering changes: every stored instant stays UTC.
-- Purely additive.
--
-- Written by hand, like every migration here: `prisma migrate dev` wants to
-- drop and recreate the full-text search index it does not know about.

CREATE TYPE "TimeFormat" AS ENUM ('AUTO', 'H24', 'H12');

ALTER TABLE "user" ADD COLUMN "timeFormat" "TimeFormat" NOT NULL DEFAULT 'AUTO';
