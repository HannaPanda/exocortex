-- One vocabulary for what a person may be told about, and an account-wide
-- answer per channel (issue #105, ADR-052).
--
-- Before this, push knew three kinds on a device and mail knew none at all: a
-- share notification went out whether or not anybody wanted it. The occasion
-- and the transport are now two separate things, and a preference is stored
-- where the question actually lives -- on the device for push (ADR-048), on
-- the account for mail.

-- The push enum becomes the shared one rather than a second vocabulary that
-- would have to be mapped. A new type and a cast rather than ALTER TYPE ...
-- RENAME VALUE, so the whole change is one transaction and CALENDAR_REMINDER
-- is carried over explicitly: existing device preferences must come out the
-- other side untouched.
CREATE TYPE "NotificationKind" AS ENUM ('SHARE', 'COMMENT', 'CALENDAR', 'AGENT');

-- Through text[] and back, because the old value has no counterpart in the new
-- type and a per-element expression may not contain a subquery here.
-- `array_replace` handles an empty list and a NULL column as themselves, which
-- is what a registered-and-silent device is.
ALTER TABLE "push_subscription"
    ALTER COLUMN "kinds" TYPE "NotificationKind"[]
    USING array_replace("kinds"::text[], 'CALENDAR_REMINDER', 'CALENDAR')::"NotificationKind"[];

DROP TYPE "PushNotificationKind";

CREATE TYPE "NotificationChannel" AS ENUM ('PUSH', 'EMAIL');

CREATE TYPE "NotificationDeliveryMode" AS ENUM ('OFF', 'IMMEDIATE', 'DAILY_DIGEST');

CREATE TABLE "notification_preference" (
    "userId" TEXT NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "mode" "NotificationDeliveryMode" NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preference_pkey" PRIMARY KEY ("userId", "kind", "channel")
);

-- Push preferences belong to a device and nowhere else (ADR-048). Without this
-- there would be two places to ask about push, and the answer that disagreed
-- would win by accident. Dropping it is what a second account-wide channel
-- would cost, and that is the right price for the question to be asked.
ALTER TABLE "notification_preference"
    ADD CONSTRAINT "notification_preference_account_scoped_check"
    CHECK ("channel" <> 'PUSH');

ALTER TABLE "notification_preference"
    ADD CONSTRAINT "notification_preference_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
