-- A notification occasion for automations that stopped working (issue #107).
-- Mail only, stored on the account like SHARE: an absent row means the
-- catalogue's default, which for this occasion is on.
ALTER TYPE "NotificationKind" ADD VALUE 'FAILURE';
