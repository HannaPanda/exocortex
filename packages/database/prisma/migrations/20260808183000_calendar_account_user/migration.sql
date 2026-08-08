-- The calendar sync acts as a specific human.
--
-- Every row the mirror writes goes through the REST API with a service token
-- minted for this user (ADR-014), so the sync can reach exactly the pages that
-- person could reach and no more. It sits on the account rather than in the job
-- payload because a repeatable schedule has no user context to supply.
--
-- Added NOT NULL without a default, which is safe only because
-- `calendar_account` is empty: it was created by 20260808180000_calendar_sync in
-- the same commit series and nothing writes to it yet. A later change to this
-- table will need a backfill.
ALTER TABLE "calendar_account" ADD COLUMN "userId" TEXT NOT NULL;

CREATE INDEX "calendar_account_userId_idx" ON "calendar_account" ("userId");

ALTER TABLE "calendar_account"
  ADD CONSTRAINT "calendar_account_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
