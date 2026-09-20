-- Mail as an automation action (issue #104, ADR-054).
--
-- Two columns' worth of change for a feature that opens a daily agenda, a
-- weekly review and "send me this page at 17:00" all at once, because the
-- clock half already existed (ADR-038). What is deliberately absent is a
-- recipient column: the address is read from the owning account when the mail
-- is queued, so there is no field on a rule that points anywhere. An
-- automation that could name an inbox would be a relay, and the agents that
-- may write rules would have a second way out of this deployment.
ALTER TYPE "AutomationAction" ADD VALUE 'EMAIL_SELF';

-- The subject line, or null for the rule's name. Free text, and the only such
-- text on this model that reaches a mail header -- defensible because the mail
-- reaches the person who typed it and nobody else.
ALTER TABLE "automation_rule" ADD COLUMN "mailSubject" TEXT;
