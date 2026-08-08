-- API token scopes.
--
-- `scopes` existed as a column but nothing ever read it, so every `exo_` token
-- was the whole account: all workspaces, deletion, the admin API, and the right
-- to mint more tokens. TokenScopeGuard now enforces it, and an empty array
-- grants nothing so the check cannot be bypassed by a row that predates it.
--
-- Existing tokens are backfilled to read+write rather than left empty, because
-- they are in active use by MCP clients that read and write pages. They lose
-- the admin scope, which is the point: none of them ever needed it.

ALTER TABLE "api_token" ALTER COLUMN "scopes" SET DEFAULT ARRAY['read']::text[];

UPDATE "api_token"
SET "scopes" = ARRAY['read', 'write']::text[]
WHERE cardinality("scopes") = 0;
