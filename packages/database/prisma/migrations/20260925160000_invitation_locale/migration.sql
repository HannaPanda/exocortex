-- The language an invitation speaks (issue #98, ADR-062): its mail, and the
-- new account's interface until the person chooses one. Nullable: NULL means
-- the inviter did not choose, and the mail follows the inviter's language.
ALTER TABLE "invitation" ADD COLUMN "locale" TEXT;
