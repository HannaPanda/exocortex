-- Push notifications for the installed app (issue #30, ADR-048).
--
-- A row per device, not per person: which kinds of notification reach a
-- browser is a property of that browser, because a phone in a pocket and a
-- desktop at work want different things.
CREATE TYPE "PushNotificationKind" AS ENUM ('CALENDAR_REMINDER', 'COMMENT', 'AGENT');

CREATE TABLE "push_subscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kinds" "PushNotificationKind"[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastDeliveredAt" TIMESTAMP(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "push_subscription_pkey" PRIMARY KEY ("id")
);

-- The address is unique across the deployment rather than per user: a browser
-- profile mints one endpoint for this application, so registering it again
-- after signing in as somebody else hands the device to the new account.
CREATE UNIQUE INDEX "push_subscription_endpoint_key" ON "push_subscription"("endpoint");

-- The person's own device list.
CREATE INDEX "push_subscription_userId_createdAt_idx" ON "push_subscription"("userId", "createdAt");

ALTER TABLE "push_subscription"
    ADD CONSTRAINT "push_subscription_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
