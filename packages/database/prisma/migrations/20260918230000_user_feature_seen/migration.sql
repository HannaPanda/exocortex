-- Issue #80 (ADR-040): how far down the feature registry one person has read.
-- A date rather than a set of ids: the question is "what happened since I last
-- looked", and an absent row means the person has missed nothing yet.
CREATE TABLE "user_feature_seen" (
    "userId" TEXT NOT NULL,
    "seenUpTo" DATE NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_feature_seen_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "user_feature_seen" ADD CONSTRAINT "user_feature_seen_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
