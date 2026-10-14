-- A person may declare an external MCP server's answers their own data (issue #196, ADR-086).
ALTER TABLE "external_mcp_server" ADD COLUMN "trusted" BOOLEAN NOT NULL DEFAULT false;
