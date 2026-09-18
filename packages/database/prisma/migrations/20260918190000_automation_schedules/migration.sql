-- Issue #73: an automation can be started by the clock, not only by a change.

-- The trigger a rule can listen for, and the shapes a schedule can have.
ALTER TYPE "AutomationTrigger" ADD VALUE 'SCHEDULE';

CREATE TYPE "AutomationScheduleKind" AS ENUM ('ONCE', 'DAILY', 'WEEKLY', 'MONTHLY', 'CRON');

-- What started a run. Every row that exists today was started by an event or by
-- hand, and describing them as events is the honest default: the manual path
-- kept no mark of its own before this column.
CREATE TYPE "AutomationRunOrigin" AS ENUM ('EVENT', 'SCHEDULE', 'MANUAL');

ALTER TABLE "automation_rule"
  ADD COLUMN "scheduleKind" "AutomationScheduleKind",
  ADD COLUMN "scheduleAt" TIMESTAMP(3),
  ADD COLUMN "scheduleTime" TEXT,
  ADD COLUMN "scheduleWeekday" INTEGER,
  ADD COLUMN "scheduleDayOfMonth" INTEGER,
  ADD COLUMN "scheduleCron" TEXT,
  ADD COLUMN "scheduleTimeZone" TEXT,
  ADD COLUMN "nextRunAt" TIMESTAMP(3);

ALTER TABLE "automation_run"
  ADD COLUMN "origin" "AutomationRunOrigin" NOT NULL DEFAULT 'EVENT';

-- The sweep's only question, once a minute for ever: which rules are due.
CREATE INDEX "automation_rule_nextRunAt_idx" ON "automation_rule" ("nextRunAt");
