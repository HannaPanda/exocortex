-- OAuth 2.1 authorization server for remote MCP clients.
--
-- Needed because ChatGPT cannot spawn a subprocess, so the stdio MCP transport
-- is out of reach for it, and it offers no field for a pasted API token. A
-- remote connector authenticates with OAuth and registers itself dynamically
-- (RFC 7591); these three tables are what the Better Auth `mcp` plugin stores.
--
-- The column names come from the plugin's adapter mapping and cannot be
-- renamed. `created_at`/`updated_at` deliberately carry no database default:
-- the plugin always writes both, and a default would hide the day it stops.

CREATE TABLE "oauth_application" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "metadata" TEXT,
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT,
    "redirectUrls" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "disabled" BOOLEAN DEFAULT false,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_application_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "oauth_application_clientId_key" ON "oauth_application"("clientId");
CREATE INDEX "oauth_application_userId_idx" ON "oauth_application"("userId");

ALTER TABLE "oauth_application"
    ADD CONSTRAINT "oauth_application_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "oauth_access_token" (
    "id" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "accessTokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "refreshTokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT,
    "scopes" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_access_token_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "oauth_access_token_accessToken_key" ON "oauth_access_token"("accessToken");
CREATE UNIQUE INDEX "oauth_access_token_refreshToken_key" ON "oauth_access_token"("refreshToken");
CREATE INDEX "oauth_access_token_clientId_idx" ON "oauth_access_token"("clientId");
CREATE INDEX "oauth_access_token_userId_idx" ON "oauth_access_token"("userId");

ALTER TABLE "oauth_access_token"
    ADD CONSTRAINT "oauth_access_token_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "oauth_application"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "oauth_access_token"
    ADD CONSTRAINT "oauth_access_token_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "oauth_consent" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "consentGiven" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_consent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "oauth_consent_clientId_idx" ON "oauth_consent"("clientId");
CREATE INDEX "oauth_consent_userId_idx" ON "oauth_consent"("userId");

ALTER TABLE "oauth_consent"
    ADD CONSTRAINT "oauth_consent_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "oauth_application"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "oauth_consent"
    ADD CONSTRAINT "oauth_consent_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
