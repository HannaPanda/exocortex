-- The interface language a person chose (issue #98, ADR-062). Nullable:
-- NULL is "never chose" and lets the browser decide.
ALTER TABLE "user" ADD COLUMN "locale" TEXT;
