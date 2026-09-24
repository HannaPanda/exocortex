-- A public link's token, encrypted, so the workspace's admins can see it again
-- (ADR-044, addendum 2026-09-24). Links made before this migration keep only
-- their hash: there is nothing to recover them from.
ALTER TABLE "document_share"
  ADD COLUMN "tokenCiphertext" TEXT,
  ADD COLUMN "tokenIv" TEXT,
  ADD COLUMN "tokenAuthTag" TEXT,
  ADD COLUMN "tokenKeyVersion" INTEGER;

-- All four or none: a partial record cannot be decrypted, and one that looked
-- decryptable would fail at read time instead of at write time.
ALTER TABLE "document_share"
  ADD CONSTRAINT "document_share_sealed_token_complete" CHECK (
    ("tokenCiphertext" IS NULL AND "tokenIv" IS NULL AND "tokenAuthTag" IS NULL AND "tokenKeyVersion" IS NULL)
    OR ("tokenCiphertext" IS NOT NULL AND "tokenIv" IS NOT NULL AND "tokenAuthTag" IS NOT NULL AND "tokenKeyVersion" IS NOT NULL)
  );

-- Only a link has a token to seal.
ALTER TABLE "document_share"
  ADD CONSTRAINT "document_share_sealed_token_link_only" CHECK (
    "tokenCiphertext" IS NULL OR "kind" = 'PUBLIC_LINK'
  );
