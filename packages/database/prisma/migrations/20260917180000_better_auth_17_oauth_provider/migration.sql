-- better-auth 1.7: the MCP plugin is a different authorization server (issue #64).
--
-- `better-auth/plugins`.`mcp` became `@better-auth/mcp`, built on
-- `@better-auth/oauth-provider`, and it does not carry the old tables forward:
-- `oauth_application` is `oauth_client` with a different column set, an access
-- token is a signed JWT rather than a row, a refresh token got its own table,
-- and a protected resource (RFC 8707) became a first-class entity. The `jwt`
-- plugin comes with it, because the access tokens are signed with keys it
-- keeps in `jwks`.
--
-- What is carried over and what is not:
--
--   * clients      -- copied. `redirectUrls` was one comma-separated string and
--                     becomes an array; `type` becomes the RFC 7591
--                     `tokenEndpointAuthMethod`.
--   * client secrets -- dropped. 1.6 stored them in the clear, 1.7 stores a
--                     hash, and a plaintext secret in a column that now means
--                     "hash" is a secret nobody can use and everybody can read.
--                     Both clients on this deployment are public (PKCE, no
--                     secret), so nothing is lost; a confidential client would
--                     have to register again.
--   * consents     -- kept. The space-separated scope string becomes an array.
--                     `consentGiven` is gone: the row's existence is the yes.
--   * tokens       -- dropped. The table changes shape, every row on this
--                     deployment expired weeks ago, and a JWT cannot be
--                     reconstructed from one anyway. A connector refreshes or
--                     asks again.
--
-- Written by hand, like every migration here: `prisma migrate dev` wants to
-- drop and recreate the full-text search index it does not know about.

-- ---------------------------------------------------------------------------
-- Signing keys for the authorization server
-- ---------------------------------------------------------------------------

CREATE TABLE "jwks" (
    "id" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "alg" TEXT,
    "crv" TEXT,

    CONSTRAINT "jwks_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- Clients
-- ---------------------------------------------------------------------------

CREATE TABLE "oauth_client" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT,
    "clientDiscoveryId" TEXT,
    "disabled" BOOLEAN DEFAULT false,
    "skipConsent" BOOLEAN,
    "enableEndSession" BOOLEAN,
    "subjectType" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "clientCredentialsScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),
    "name" TEXT,
    "uri" TEXT,
    "icon" TEXT,
    "contacts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tos" TEXT,
    "policy" TEXT,
    "softwareId" TEXT,
    "softwareVersion" TEXT,
    "softwareStatement" TEXT,
    "redirectUris" TEXT[],
    "postLogoutRedirectUris" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "backchannelLogoutUri" TEXT,
    "backchannelLogoutSessionRequired" BOOLEAN,
    "tokenEndpointAuthMethod" TEXT,
    "applicationType" TEXT,
    "jwks" TEXT,
    "jwksUri" TEXT,
    "grantTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "responseTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requirePKCE" BOOLEAN,
    "dpopBoundAccessTokens" BOOLEAN DEFAULT false,
    "referenceId" TEXT,
    "metadata" JSONB,

    CONSTRAINT "oauth_client_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "oauth_client_clientId_key" ON "oauth_client"("clientId");
CREATE INDEX "oauth_client_userId_idx" ON "oauth_client"("userId");

ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_client_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The scope, grant and response lists were implicit in 1.6 -- the plugin knew
-- them and the row did not carry them. 1.7 reads them off the client, so the
-- values the old plugin actually used are written out here.
INSERT INTO "oauth_client" (
    "id", "clientId", "clientSecret", "disabled", "userId", "createdAt", "updatedAt",
    "name", "icon", "metadata", "redirectUris", "tokenEndpointAuthMethod",
    "applicationType", "scopes", "grantTypes", "responseTypes", "requirePKCE"
)
SELECT
    a."id",
    a."clientId",
    NULL,
    COALESCE(a."disabled", false),
    a."userId",
    a."createdAt",
    a."updatedAt",
    a."name",
    a."icon",
    NULLIF(a."metadata", '')::jsonb,
    string_to_array(a."redirectUrls", ','),
    CASE WHEN a."type" = 'public' THEN 'none' ELSE 'client_secret_basic' END,
    'web',
    ARRAY['openid', 'profile', 'email', 'offline_access']::TEXT[],
    ARRAY['authorization_code', 'refresh_token']::TEXT[],
    ARRAY['code']::TEXT[],
    true
FROM "oauth_application" a;

-- ---------------------------------------------------------------------------
-- Protected resources (RFC 8707)
-- ---------------------------------------------------------------------------
--
-- Left empty. The plugin seeds the one resource this deployment has,
-- `<APP_URL>/api/mcp`, from its own options on first use, and hard-coding the
-- origin here would bake one deployment's URL into the migration history.

CREATE TABLE "oauth_resource" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accessTokenTtl" INTEGER,
    "refreshTokenTtl" INTEGER,
    "signingAlgorithm" TEXT,
    "signingKeyId" TEXT,
    "allowedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "customClaims" JSONB,
    "dpopBoundAccessTokensRequired" BOOLEAN DEFAULT false,
    "disabled" BOOLEAN DEFAULT false,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),
    "policyVersion" INTEGER DEFAULT 1,
    "metadata" JSONB,

    CONSTRAINT "oauth_resource_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "oauth_resource_identifier_key" ON "oauth_resource"("identifier");

CREATE TABLE "oauth_client_resource" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_client_resource_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "oauth_client_resource_clientId_idx" ON "oauth_client_resource"("clientId");
CREATE INDEX "oauth_client_resource_resourceId_idx" ON "oauth_client_resource"("resourceId");
CREATE UNIQUE INDEX "oauth_client_resource_clientId_resourceId_key"
  ON "oauth_client_resource"("clientId", "resourceId");

ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "oauth_client"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_resourceId_fkey"
  FOREIGN KEY ("resourceId") REFERENCES "oauth_resource"("identifier") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Refresh tokens
-- ---------------------------------------------------------------------------

CREATE TABLE "oauth_refresh_token" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "sessionId" TEXT,
    "userId" TEXT NOT NULL,
    "referenceId" TEXT,
    "authorizationCodeId" TEXT,
    "resources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requestedUserInfoClaims" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked" TIMESTAMP(3),
    "rotatedAt" TIMESTAMP(3),
    "rotationReplayResponse" TEXT,
    "rotationReplayExpiresAt" TIMESTAMP(3),
    "authTime" TIMESTAMP(3),
    "confirmation" JSONB,
    "scopes" TEXT[],

    CONSTRAINT "oauth_refresh_token_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "oauth_refresh_token_token_key" ON "oauth_refresh_token"("token");
CREATE INDEX "oauth_refresh_token_clientId_idx" ON "oauth_refresh_token"("clientId");
CREATE INDEX "oauth_refresh_token_sessionId_idx" ON "oauth_refresh_token"("sessionId");
CREATE INDEX "oauth_refresh_token_userId_idx" ON "oauth_refresh_token"("userId");
CREATE INDEX "oauth_refresh_token_authorizationCodeId_idx" ON "oauth_refresh_token"("authorizationCodeId");

ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "oauth_client"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Client assertions (`private_key_jwt` replay protection)
-- ---------------------------------------------------------------------------

CREATE TABLE "oauth_client_assertion" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_client_assertion_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- Access tokens: same table, different thing
-- ---------------------------------------------------------------------------
--
-- The rows are deleted rather than converted. 1.6 stored the access and
-- refresh token side by side in the clear; 1.7 stores a digest of an opaque
-- token, and issues no opaque token at all when the grant has a resource
-- audience -- which every grant here does. There is nothing to convert.

ALTER TABLE "oauth_access_token" DROP CONSTRAINT "oauth_access_token_clientId_fkey";

DROP INDEX "oauth_access_token_accessToken_key";
DROP INDEX "oauth_access_token_refreshToken_key";

DELETE FROM "oauth_access_token";

ALTER TABLE "oauth_access_token"
    DROP COLUMN "accessToken",
    DROP COLUMN "accessTokenExpiresAt",
    DROP COLUMN "refreshToken",
    DROP COLUMN "refreshTokenExpiresAt",
    DROP COLUMN "updatedAt",
    DROP COLUMN "scopes",
    ADD COLUMN "token" TEXT NOT NULL,
    ADD COLUMN "sessionId" TEXT,
    ADD COLUMN "referenceId" TEXT,
    ADD COLUMN "authorizationCodeId" TEXT,
    ADD COLUMN "resources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "requestedUserInfoClaims" TEXT[] DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "refreshId" TEXT,
    ADD COLUMN "expiresAt" TIMESTAMP(3) NOT NULL,
    ADD COLUMN "revoked" TIMESTAMP(3),
    ADD COLUMN "confirmation" JSONB,
    ADD COLUMN "scopes" TEXT[],
    ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX "oauth_access_token_token_key" ON "oauth_access_token"("token");
CREATE INDEX "oauth_access_token_sessionId_idx" ON "oauth_access_token"("sessionId");
CREATE INDEX "oauth_access_token_authorizationCodeId_idx" ON "oauth_access_token"("authorizationCodeId");
CREATE INDEX "oauth_access_token_refreshId_idx" ON "oauth_access_token"("refreshId");

ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "oauth_client"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_refreshId_fkey"
  FOREIGN KEY ("refreshId") REFERENCES "oauth_refresh_token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Consents: kept, reshaped
-- ---------------------------------------------------------------------------

ALTER TABLE "oauth_consent" DROP CONSTRAINT "oauth_consent_clientId_fkey";

ALTER TABLE "oauth_consent"
    DROP COLUMN "consentGiven",
    ADD COLUMN "referenceId" TEXT,
    ADD COLUMN "resources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "requestedUserInfoClaims" TEXT[] DEFAULT ARRAY[]::TEXT[],
    ALTER COLUMN "userId" DROP NOT NULL,
    ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP,
    ALTER COLUMN "scopes" TYPE TEXT[] USING string_to_array("scopes", ' ');

ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "oauth_client"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The old client table is now empty of meaning
-- ---------------------------------------------------------------------------

ALTER TABLE "oauth_application" DROP CONSTRAINT "oauth_application_userId_fkey";
DROP TABLE "oauth_application";
