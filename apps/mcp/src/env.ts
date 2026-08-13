import { z } from 'zod';

/**
 * Deliberately not `@exocortex/config`: its schemas require `DATABASE_URL`,
 * S3 and SMTP settings that an MCP client machine (a laptop running Hermes,
 * or a remote operator's shell) does not have and should never need. This is
 * a tiny, self-contained schema for exactly what the stdio bin needs.
 */
export const mcpEnvSchema = z.object({
  EXOCORTEX_API_URL: z.url(),
  EXOCORTEX_API_TOKEN: z.string().trim().min(10),
  /**
   * Optional HTTP basic auth for deployments behind nginx (exocortex.app has
   * it). Not sent as `Authorization`, because the bearer token already needs
   * that header; see `docs/mcp.md` for the operator-side nginx configuration
   * this implies (an `X-Forwarded-Authorization`-style header on the
   * server), and prefer running on the same host and talking to the API
   * directly (`http://127.0.0.1:3211`), bypassing nginx entirely, which is
   * how Hermes runs it.
   */
  EXOCORTEX_BASIC_AUTH: z.string().trim().optional(),
  EXOCORTEX_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  /**
   * Widens the confirmation gate from the irreversible calls to every write.
   * The stdio counterpart of `mcp.writeConfirmationRequired`, and off for the
   * same reason: the client running this subprocess already asks its human.
   */
  EXOCORTEX_REQUIRE_WRITE_CONFIRMATION: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .transform((v) => v === true || v === 'true' || v === '1')
    .default(false),
  EXOCORTEX_LOG_FILE: z.string().trim().optional(),
});
export type McpEnv = z.infer<typeof mcpEnvSchema>;
