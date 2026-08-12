-- Invitations, and the ability to switch an account off (issue #3).
--
-- Purely additive: one new table, one new nullable column on "user". Nothing is
-- dropped and no column changes type, so this migration is safe to run against
-- the live deployment while it serves requests.
--
-- Written by hand, like every migration here: `prisma migrate dev` wants to drop
-- and recreate the full-text search index it does not know about.

-- An account that exists but may not act. Nullable, so every existing row keeps
-- working exactly as before.
ALTER TABLE "user" ADD COLUMN "disabledAt" TIMESTAMP(3);

CREATE TABLE "invitation" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "invitedById" TEXT NOT NULL,
  "workspaceId" TEXT,
  "workspaceRole" "WorkspaceRole",
  "role" "UserRole" NOT NULL DEFAULT 'USER',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "acceptedById" TEXT,
  "revokedAt" TIMESTAMP(3),
  "sentCount" INTEGER NOT NULL DEFAULT 1,
  "lastSentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- Redemption looks an invitation up by the hash of the token in the link, and
-- that lookup is on an unauthenticated path: it has to stay a single indexed
-- read so a wrong token costs the same as a right one.
CREATE UNIQUE INDEX "invitation_tokenHash_key" ON "invitation" ("tokenHash");

-- One invitation produces at most one account.
CREATE UNIQUE INDEX "invitation_acceptedById_key" ON "invitation" ("acceptedById");

-- "Is there already an open invitation for this address?" — checked before every
-- new one, so nobody gets two links and wonders which is real.
CREATE INDEX "invitation_email_idx" ON "invitation" ("email");

CREATE INDEX "invitation_workspaceId_idx" ON "invitation" ("workspaceId");
CREATE INDEX "invitation_invitedById_idx" ON "invitation" ("invitedById");

-- The inviter's account going away takes their open invitations with it: nobody
-- is left holding a link issued by somebody who no longer exists.
ALTER TABLE "invitation"
  ADD CONSTRAINT "invitation_invitedById_fkey"
  FOREIGN KEY ("invitedById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same for the workspace an invitation leads into: a link into a deleted
-- workspace cannot be honoured.
ALTER TABLE "invitation"
  ADD CONSTRAINT "invitation_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The account that came out of the invitation may be deleted later; the record
-- that the invitation was used stays (`acceptedAt` is what makes it spent).
ALTER TABLE "invitation"
  ADD CONSTRAINT "invitation_acceptedById_fkey"
  FOREIGN KEY ("acceptedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
