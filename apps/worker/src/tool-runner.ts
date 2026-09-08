import { type AiToolDefinition } from '@exocortex/ai';
import { issueServiceToken } from '@exocortex/auth';
import { type Logger } from '@exocortex/logger';
import {
  createFetchApiClient,
  type ExocortexApiClient,
  ExocortexApiError,
  findTool,
  ToolInputValidationError,
  toolsFor,
} from '@exocortex/mcp-tools';

/** Every tool result is capped here so a single call can never eat the run's whole context. */
const MAX_RESULT_CHARS = 30_000;

/** A service token is re-minted once it is within this margin of expiring. */
const REISSUE_MARGIN_MS = 30_000;

function truncate(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n… (gekürzt)` : text;
}

/**
 * Executes tool calls for an AI run.
 *
 * Every call goes through the REST API with a short-lived service token minted
 * for the run's own user, so the model can do exactly what that human could do
 * and not one thing more. There is no privileged path: authorization stays in
 * `apps/api`, and the catalogue is the same one the external MCP server serves.
 */
export interface ToolRunner {
  readonly definitions: readonly AiToolDefinition[];
  run(input: { name: string; argumentsJson: string; correlationId: string }): Promise<{
    text: string;
    isError: boolean;
  }>;
}

export interface CreateToolRunnerInput {
  apiUrl: string;
  serviceTokenSecret: string;
  serviceTokenTtlSeconds: number;
  userId: string;
  includeMutating: boolean;
  logger: Logger;
  /** Ceiling for one tool call; see `AI_TOOL_CALL_TIMEOUT_MS`. */
  toolCallTimeoutMs: number;
  /**
   * The run this loop belongs to, recorded with everything it writes
   * (ADR-022). The built-in AI is an agent like any other: what it changed in
   * one run has to be findable, and undoable, as one thing.
   */
  agentSession: { externalId: string; label: string };
}

export function createToolRunner(input: CreateToolRunnerInput): ToolRunner {
  const definitions: AiToolDefinition[] = toolsFor('ai', {
    includeMutating: input.includeMutating,
  }).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.jsonSchema,
  }));

  let tokenExpiresAt = 0;
  let client: ExocortexApiClient | null = null;

  /** Mints (or re-mints, close to expiry) the service token and its client. */
  function ensureClient(): ExocortexApiClient {
    const now = Date.now();
    if (client === null || tokenExpiresAt - now <= REISSUE_MARGIN_MS) {
      const issued = issueServiceToken({
        secret: input.serviceTokenSecret,
        userId: input.userId,
        purpose: 'ai-tools',
        ttlSeconds: input.serviceTokenTtlSeconds,
      });
      tokenExpiresAt = issued.expiresAt;
      client = createFetchApiClient({
        baseUrl: input.apiUrl,
        token: issued.token,
        timeoutMs: input.toolCallTimeoutMs,
        agentSession: input.agentSession,
      });
    }
    return client;
  }

  return {
    definitions,
    async run({ name, argumentsJson, correlationId }) {
      const tool = findTool(name);
      if (tool === null) {
        return { text: `Unbekanntes Werkzeug: ${name}`, isError: true };
      }

      let args: unknown;
      try {
        args = JSON.parse(argumentsJson) as unknown;
      } catch (error) {
        return {
          text: `Die Argumente waren kein gültiges JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
          isError: true,
        };
      }

      // A tool error is never a thrown exception out of `run` -- the loop must
      // be able to hand the failure back to the model as a `tool` message
      // instead of crashing the whole run.
      try {
        const result = await tool.run(ensureClient(), args);
        return { text: truncate(result.text), isError: result.isError ?? false };
      } catch (error) {
        if (error instanceof ExocortexApiError) {
          return { text: `Fehler (${error.code}): ${error.message}`, isError: true };
        }
        if (error instanceof ToolInputValidationError) {
          const paths = error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ');
          return { text: `Die Argumente waren ungültig (Felder: ${paths}).`, isError: true };
        }
        input.logger.warn('Tool call failed with an unexpected error', {
          tool: name,
          correlationId,
          reason: error instanceof Error ? error.message : String(error),
        });
        return { text: `Unerwarteter Fehler beim Aufruf von ${name}.`, isError: true };
      }
    },
  };
}
