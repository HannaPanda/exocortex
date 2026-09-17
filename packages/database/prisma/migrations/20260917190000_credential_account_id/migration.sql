-- A credential account's id is the user's id, not the address (issue #64).
--
-- Better Auth has always written it that way in `sign-up.mjs`, and
-- `InvitationsService` copies that convention with a comment saying so. Two
-- scripts in this repository did not: `prisma/seed.ts` and
-- `scripts/provision-user.ts` both put the email address in `accountId`.
--
-- Until better-auth 1.7 that was a harmless inconsistency, because `signInEmail`
-- matched on `providerId = 'credential'` alone. 1.7 also requires
-- `accountId = user.id`, so an account seeded the old way stops being found and
-- the sign-in fails with "user not found" -- the same message as for an address
-- nobody ever registered. Both scripts now write the user id; this repairs the
-- rows they already wrote.
--
-- Only the account identifier moves. The password hash is untouched, so nobody
-- has to be issued a new one.

UPDATE "account"
   SET "accountId" = "userId"
 WHERE "providerId" = 'credential'
   AND "accountId" <> "userId";
