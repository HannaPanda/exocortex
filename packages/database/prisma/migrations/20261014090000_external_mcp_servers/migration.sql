-- CreateEnum
CREATE TYPE "ExternalMcpTransport" AS ENUM ('STREAMABLE_HTTP');

-- CreateEnum
CREATE TYPE "ExternalMcpAuthKind" AS ENUM ('NONE', 'BEARER', 'HEADER');

-- CreateEnum
CREATE TYPE "ExternalMcpStatus" AS ENUM ('UNCHECKED', 'OK', 'ERROR');

-- CreateEnum
CREATE TYPE "ExternalMcpToolAccess" AS ENUM ('BLOCKED', 'READ', 'WRITE');

-- CreateTable
CREATE TABLE "external_mcp_server" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "transport" "ExternalMcpTransport" NOT NULL DEFAULT 'STREAMABLE_HTTP',
    "url" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "authKind" "ExternalMcpAuthKind" NOT NULL DEFAULT 'NONE',
    "authHeaderName" TEXT,
    "secretCiphertext" TEXT,
    "secretIv" TEXT,
    "secretAuthTag" TEXT,
    "secretKeyVersion" INTEGER,
    "secretHint" TEXT,
    "status" "ExternalMcpStatus" NOT NULL DEFAULT 'UNCHECKED',
    "lastCheckedAt" TIMESTAMP(3),
    "lastOkAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorDetail" TEXT,
    "serverName" TEXT,
    "serverVersion" TEXT,
    "protocolVersion" TEXT,
    "instructions" TEXT,
    "toolsTruncated" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_mcp_server_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_mcp_tool" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT NOT NULL,
    "inputSchema" JSONB NOT NULL,
    "hints" JSONB NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "problem" TEXT,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "access" "ExternalMcpToolAccess" NOT NULL DEFAULT 'BLOCKED',
    "approvedFingerprint" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_mcp_tool_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "external_mcp_server_workspaceId_key_key" ON "external_mcp_server"("workspaceId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "external_mcp_tool_serverId_name_key" ON "external_mcp_tool"("serverId", "name");

-- AddForeignKey
ALTER TABLE "external_mcp_server" ADD CONSTRAINT "external_mcp_server_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_mcp_server" ADD CONSTRAINT "external_mcp_server_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_mcp_tool" ADD CONSTRAINT "external_mcp_tool_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "external_mcp_server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_mcp_tool" ADD CONSTRAINT "external_mcp_tool_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Hand-written below this line (issue #196, ADR-086).

-- A stored secret is all four parts or none: a row with a ciphertext and no
-- tag would fail to decrypt inside a run instead of when it was written.
ALTER TABLE "external_mcp_server" ADD CONSTRAINT "external_mcp_server_secret_shape_check" CHECK (
    ("secretCiphertext" IS NULL AND "secretIv" IS NULL AND "secretAuthTag" IS NULL AND "secretKeyVersion" IS NULL)
    OR ("secretCiphertext" IS NOT NULL AND "secretIv" IS NOT NULL AND "secretAuthTag" IS NOT NULL AND "secretKeyVersion" IS NOT NULL)
);

-- A header auth kind names its header; the others do not.
ALTER TABLE "external_mcp_server" ADD CONSTRAINT "external_mcp_server_auth_header_check" CHECK (
    ("authKind" = 'HEADER') = ("authHeaderName" IS NOT NULL)
);

-- An approval is for exactly the tool a person saw. Whatever writes a new
-- fingerprint has to send the tool back to BLOCKED in the same statement, or
-- this refuses the write; and a tool with a problem is never approved.
ALTER TABLE "external_mcp_tool" ADD CONSTRAINT "external_mcp_tool_approval_check" CHECK (
    "access" = 'BLOCKED'
    OR ("approvedFingerprint" = "fingerprint" AND "problem" IS NULL AND "available")
);
