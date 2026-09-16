import { type AiToolDefinition } from '@exocortex/ai';
import { issueServiceToken } from '@exocortex/auth';
import {
  type AiMutationPolicy,
  decideMutation,
  fenceUntrustedContent,
  type UntrustedOrigin,
} from '@exocortex/contracts';
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
 *
 * It is also the run's trust boundary (issue #56, ADR-030). Every tool call of
 * the built-in loop passes through `run`, which makes this the one place that
 * can see both what the run has read and what it is about to change -- so the
 * decision lives here rather than in each of the eighty tools.
 */
export interface ToolRunner {
  readonly definitions: readonly AiToolDefinition[];
  /** Origins of the foreign text this run has read, in the order it arrived. */
  readonly untrustedOrigins: readonly UntrustedOrigin[];
  /**
   * Records foreign text that reached the context without passing through a
   * tool call. The vision preprocessor is the case that exists today: it
   * describes images out of an uploaded file before the loop starts, and a
   * description is as good a place to hide an instruction as the file is.
   */
  noteUntrustedContent(origin: UntrustedOrigin): void;
  run(input: { name: string; argumentsJson: string; correlationId: string }): Promise<{
    text: string;
    isError: boolean;
    /** `true` when the trust boundary refused the call; nothing was executed. */
    refused: boolean;
  }>;
}

export interface CreateToolRunnerInput {
  apiUrl: string;
  serviceTokenSecret: string;
  serviceTokenTtlSeconds: number;
  userId: string;
  includeMutating: boolean;
  /** `ai.untrustedContentPolicy`: what this run may still change after reading foreign text. */
  mutationPolicy: AiMutationPolicy;
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

/**
 * What one run tells the factory. The deployment-wide half (API URL, token
 * secret, logger) is bound once in `runtime.ts`; this is the part that differs
 * per run, and naming it keeps the three declarations of it from drifting.
 */
export type ToolRunnerFactoryInput = Pick<
  CreateToolRunnerInput,
  'userId' | 'includeMutating' | 'mutationPolicy' | 'toolCallTimeoutMs' | 'agentSession'
>;

export type ToolRunnerFactory = (input: ToolRunnerFactoryInput) => ToolRunner;

export function createToolRunner(input: CreateToolRunnerInput): ToolRunner {
  // `deny` takes the mutating tools out of the catalogue entirely rather than
  // refusing them one by one: a model that is never offered a write does not
  // spend a turn proposing one. `guarded` keeps them, because whether they are
  // allowed depends on what the run reads next.
  const includeMutating = input.includeMutating && input.mutationPolicy !== 'deny';
  const definitions: AiToolDefinition[] = toolsFor('ai', { includeMutating }).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.jsonSchema,
  }));

  let tokenExpiresAt = 0;
  let client: ExocortexApiClient | null = null;
  const untrustedOrigins: UntrustedOrigin[] = [];

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

  function noteUntrustedContent(origin: UntrustedOrigin): void {
    if (untrustedOrigins.includes(origin)) return;
    untrustedOrigins.push(origin);
    input.logger.info('Run has read content from outside this deployment', {
      origin,
      mutationPolicy: input.mutationPolicy,
    });
  }

  return {
    definitions,
    untrustedOrigins,
    noteUntrustedContent,
    async run({ name, argumentsJson, correlationId }) {
      const tool = findTool(name);
      if (tool === null) {
        return { text: `Unbekanntes Werkzeug: ${name}`, isError: true, refused: false };
      }

      // Before the arguments are even parsed: whether this call may run
      // depends on the tool and on what the run has read, never on what the
      // model put in the payload.
      const decision = decideMutation({
        policy: input.mutationPolicy,
        mutating: tool.mutating,
        untrustedOrigins,
      });
      if (!decision.allowed) {
        input.logger.warn('Refused a mutating tool call', {
          tool: name,
          correlationId,
          code: decision.code,
          untrustedOrigins,
        });
        return { text: decision.message, isError: true, refused: true };
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
          refused: false,
        };
      }

      // A tool error is never a thrown exception out of `run` -- the loop must
      // be able to hand the failure back to the model as a `tool` message
      // instead of crashing the whole run.
      try {
        const result = await tool.run(ensureClient(), args);
        const isError = result.isError ?? false;
        // The document is cut first and fenced afterwards, so the closing
        // marker survives a result that ran into `MAX_RESULT_CHARS`: a fence
        // the truncation ate is a fence that is not there. A failed call
        // carries an error message of ours, not the document, so it is neither
        // fenced nor counted.
        if (tool.untrustedOutput !== null && !isError) {
          noteUntrustedContent(tool.untrustedOutput);
          return {
            text: fenceUntrustedContent({
              origin: tool.untrustedOutput,
              label: name,
              text: truncate(result.text),
            }),
            isError,
            refused: false,
          };
        }
        return { text: truncate(result.text), isError, refused: false };
      } catch (error) {
        if (error instanceof ExocortexApiError) {
          return {
            text: `Fehler (${error.code}): ${error.message}`,
            isError: true,
            refused: false,
          };
        }
        if (error instanceof ToolInputValidationError) {
          const paths = error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ');
          return {
            text: `Die Argumente waren ungültig (Felder: ${paths}).`,
            isError: true,
            refused: false,
          };
        }
        input.logger.warn('Tool call failed with an unexpected error', {
          tool: name,
          correlationId,
          reason: error instanceof Error ? error.message : String(error),
        });
        return {
          text: `Unerwarteter Fehler beim Aufruf von ${name}.`,
          isError: true,
          refused: false,
        };
      }
    },
  };
}
