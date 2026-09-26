import { type AiToolDefinition } from '@exocortex/ai';
import { issueServiceToken } from '@exocortex/auth';
import {
  type AiMutationPolicy,
  type AiWriteMode,
  decideMutation,
  fenceUntrustedContent,
  type UntrustedOrigin,
} from '@exocortex/contracts';
import { currentTraceCarrier, type Logger, withSpan } from '@exocortex/logger';
import {
  type AnyToolDefinition,
  createFetchApiClient,
  describeApiError,
  type ExocortexApiClient,
  ExocortexApiError,
  findTool,
  openedDomain,
  selectToolDomains,
  type ToolDomain,
  ToolInputValidationError,
  toolSchemaChars,
  toolsFor,
} from '@exocortex/mcp-tools';

import { repeatHint, ToolCallLedger, type ToolCallTally } from './tool-ledger';

/** Every tool result is capped here so a single call can never eat the run's whole context. */
const MAX_RESULT_CHARS = 30_000;

/** A service token is re-minted once it is within this margin of expiring. */
const REISSUE_MARGIN_MS = 30_000;

/**
 * The one tool with a per-run budget (issue #26).
 *
 * Named here rather than made into a general "budgeted tools" table, because a
 * table with one row is a design decision pretending to be a mechanism. When a
 * second tool needs a budget, that is the moment to build the table.
 */
const WEB_FETCH_TOOL = 'exo_web_fetch';

/**
 * The tool that opens a domain of the catalogue (issue #121).
 *
 * Named here for the same reason `WEB_FETCH_TOOL` is: what it does belongs to
 * the loop, not to the catalogue. The catalogue can describe the domains and
 * list one; only the loop can decide what the next turn is offered.
 */
const TOOLBOX_TOOL = 'exo_toolbox';

/**
 * The cut, and what it has to say about itself (issue #118).
 *
 * A bare `… (gekürzt)` is what produced the failure this envelope exists for.
 * A model that is handed a prefix and no numbers cannot tell a page that ends
 * there from a page that was cut, so it keeps asking: the run that named this
 * issue spent twenty calls looking for a section that sat three thousand
 * characters past the cut, and never learned there was a past the cut.
 *
 * So the note states how much was shown of how much, and that there is no
 * continuation *here*: this cap is the last resort under every tool, and it
 * has no cursor to offer. The tools that can be narrowed say so themselves,
 * and the ones that read pages now answer with a map long before they reach
 * this line.
 */
function truncate(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return (
    `${text.slice(0, MAX_RESULT_CHARS)}\n\n` +
    `… gekürzt: ${MAX_RESULT_CHARS} von ${text.length} Zeichen stehen hier, der Rest fehlt. ` +
    'Es gibt dafür keine Fortsetzung: derselbe Aufruf liefert wieder denselben Anfang. ' +
    'Frage enger an (einzelner Abschnitt, Filter, kleinere Grenze), statt es zu wiederholen.'
  );
}

/** What the run was offered, and what that cost it (issue #121). */
export interface ToolContext {
  /** Tools in the request, this turn. */
  offered: number;
  /** Characters the serialized tool list weighs, this turn. */
  schemaChars: number;
  /** The domains behind that number, including any `exo_toolbox` opened. */
  domains: ToolDomain[];
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
  /**
   * The tools this turn is offered. A getter, not a value: `exo_toolbox` can
   * open a domain mid-run, and the loop reads this again before every turn.
   */
  readonly definitions: readonly AiToolDefinition[];
  /** The same set, measured, for the run's row and its log line. */
  toolContext(): ToolContext;
  /** Tool calls this run has made, across every tool. */
  callCount(): number;
  /** Origins of the foreign text this run has read, in the order it arrived. */
  readonly untrustedOrigins: readonly UntrustedOrigin[];
  /**
   * Records foreign text that reached the context without passing through a
   * tool call. The vision preprocessor is the case that exists today: it
   * describes images out of an uploaded file before the loop starts, and a
   * description is as good a place to hide an instruction as the file is.
   */
  noteUntrustedContent(origin: UntrustedOrigin): void;
  /**
   * What this run has spent its tool calls on, per tool (issue #118,
   * ADR-059). Read when the run ends badly, so the abort names what happened
   * instead of only the limit it hit.
   */
  tallies(): ToolCallTally[];
  run(input: {
    name: string;
    argumentsJson: string;
    correlationId: string;
  }): Promise<ToolCallOutcome>;
}

export interface ToolCallOutcome {
  text: string;
  isError: boolean;
  /** `true` when the trust boundary refused the call; nothing was executed. */
  refused: boolean;
  /** `true` when the call raised a blocking human checkpoint (issue #140). */
  pausesRun?: boolean;
}

export interface CreateToolRunnerInput {
  apiUrl: string;
  serviceTokenSecret: string;
  serviceTokenTtlSeconds: number;
  userId: string;
  includeMutating: boolean;
  /** `ai.untrustedContentPolicy`: what this run may still change after reading foreign text. */
  mutationPolicy: AiMutationPolicy;
  /**
   * The write mode this run is held to (issue #141): decided here per call,
   * and signed into the service token so the API holds the run to it too.
   */
  writeMode: AiWriteMode;
  /**
   * `ai.webResearchMaxFetchesPerRun`: web pages this run may read (issue #26).
   *
   * Counted here rather than in the API because only the loop knows what a run
   * is; the API sees one request at a time and could not tell the fifth fetch
   * of one run from the first of five. Zero takes the tool out of the
   * catalogue entirely, the same move `deny` makes for the mutating ones:
   * a tool that will refuse every call is a tool worth not offering.
   */
  webFetchesPerRun: number;
  /**
   * What the run was asked to do, in the user's own words (issue #121).
   *
   * The only input the domain selection has, and deliberately so: the system
   * prompt names every ON_DEMAND rule page in the workspace, so feeding it in
   * would switch half the domains on for every run.
   */
  taskText: string;
  /**
   * Domains this run needs whatever its words say. One case today: the open
   * page is a database view, so the database tools are needed before anybody
   * mentions a database.
   */
  requiredDomains: readonly ToolDomain[];
  logger: Logger;
  /** Ceiling for one tool call; see `AI_TOOL_CALL_TIMEOUT_MS`. */
  toolCallTimeoutMs: number;
  /**
   * The run this loop belongs to, recorded with everything it writes
   * (ADR-022). The built-in AI is an agent like any other: what it changed in
   * one run has to be findable, and undoable, as one thing.
   */
  agentSession: { externalId: string; label: string };
  /**
   * The run itself, signed into every service token this loop mints (issue
   * #140), so a checkpoint it raises names this run without the model ever
   * handling the id.
   */
  runId: string;
}

/**
 * What one run tells the factory. The deployment-wide half (API URL, token
 * secret, logger) is bound once in `runtime.ts`; this is the part that differs
 * per run, and naming it keeps the three declarations of it from drifting.
 */
export type ToolRunnerFactoryInput = Pick<
  CreateToolRunnerInput,
  | 'userId'
  | 'includeMutating'
  | 'mutationPolicy'
  | 'writeMode'
  | 'webFetchesPerRun'
  | 'taskText'
  | 'requiredDomains'
  | 'toolCallTimeoutMs'
  | 'agentSession'
  | 'runId'
>;

export type ToolRunnerFactory = (input: ToolRunnerFactoryInput) => ToolRunner;

/** What a run is told about, and how that set can still grow (issue #121). */
interface ToolOffer {
  tools: () => readonly AnyToolDefinition[];
  /** `true` when this call widened the set; `false` when the domain was already open. */
  open: (domain: ToolDomain) => boolean;
  domains: () => ToolDomain[];
}

/**
 * The part of the catalogue one run hears about.
 *
 * Chosen once from the task, and widened only by `exo_toolbox`, which is the
 * model saying it needs something the words did not name. Its own function
 * because it is the one piece of `createToolRunner` that is about the
 * catalogue rather than about executing a call.
 *
 * Nothing here is an authorization. Every tool stays executable through
 * `findTool`, and whether a call may run is still decided by `decideMutation`
 * and by what the service token can reach.
 */
function createToolOffer(input: CreateToolRunnerInput): ToolOffer {
  // `deny` takes the mutating tools out of the catalogue entirely rather than
  // refusing them one by one: a model that is never offered a write does not
  // spend a turn proposing one. `guarded` keeps them, because whether they are
  // allowed depends on what the run reads next. A restricted write mode
  // (issue #141) keeps only what that mode may call.
  const includeMutating = input.includeMutating && input.mutationPolicy !== 'deny';
  const offeredInMode = (tool: AnyToolDefinition): boolean =>
    !tool.mutating ||
    decideMutation({
      policy: 'allow',
      mutating: true,
      untrustedOrigins: [],
      writeMode: input.writeMode,
      writeClass: tool.writeClass,
    }).allowed;
  const domains = new Set<ToolDomain>(
    selectToolDomains({ text: input.taskText, required: input.requiredDomains }),
  );

  return {
    tools: () =>
      toolsFor('ai', { includeMutating, domains: [...domains] }).filter(
        (tool) =>
          (tool.name !== WEB_FETCH_TOOL || input.webFetchesPerRun > 0) && offeredInMode(tool),
      ),
    open: (domain) => {
      if (domains.has(domain)) return false;
      domains.add(domain);
      return true;
    },
    domains: () => [...domains],
  };
}

/**
 * Books the finished call, and swaps the answer for a hint when the run
 * already has that exact answer (issue #118, ADR-059).
 *
 * After the call rather than before it: what makes a repeat pointless is that
 * the answer is the same, and only the answer can say that. A page the model
 * re-read because somebody changed it comes back changed and passes through
 * untouched; the fourteenth search that finds what the first one found does
 * not.
 */
function bookCall(
  ledger: ToolCallLedger,
  logger: Logger,
  name: string,
  argumentsJson: string,
  result: ToolCallOutcome,
): ToolCallOutcome {
  const mutating = findTool(name)?.mutating ?? true;
  const verdict = ledger.record({
    name,
    argumentsJson,
    resultText: result.text,
    comparable: !mutating && !result.isError && !result.refused,
  });
  if (verdict.repeatOf === null) return result;
  logger.info('Answered a repeated tool call with a hint instead of the same text', {
    tool: name,
    call: verdict.call,
    repeatOf: verdict.repeatOf,
    savedChars: result.text.length,
  });
  return { text: repeatHint({ name, repeatOf: verdict.repeatOf }), isError: false, refused: false };
}

export function createToolRunner(input: CreateToolRunnerInput): ToolRunner {
  const offer = createToolOffer(input);

  let tokenExpiresAt = 0;
  let client: ExocortexApiClient | null = null;
  const untrustedOrigins: UntrustedOrigin[] = [];
  let webFetches = 0;
  const ledger = new ToolCallLedger();

  /** Mints (or re-mints, close to expiry) the service token and its client. */
  function ensureClient(): ExocortexApiClient {
    const now = Date.now();
    if (client === null || tokenExpiresAt - now <= REISSUE_MARGIN_MS) {
      const issued = issueServiceToken({
        secret: input.serviceTokenSecret,
        userId: input.userId,
        purpose: 'ai-tools',
        ttlSeconds: input.serviceTokenTtlSeconds,
        runId: input.runId,
        ...(input.writeMode === 'direct' ? {} : { writeMode: input.writeMode }),
      });
      tokenExpiresAt = issued.expiresAt;
      client = createFetchApiClient({
        baseUrl: input.apiUrl,
        token: issued.token,
        timeoutMs: input.toolCallTimeoutMs,
        agentSession: input.agentSession,
        // Read per call, not per client: the client is minted once per run and
        // the span it belongs under is the tool call being made right now.
        traceparent: () => currentTraceCarrier()?.traceparent,
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

  /**
   * The call itself, without the span around it.
   *
   * Split out so `run` below stays the two things it is about: what the trace
   * records, and what the loop gets back. Every return path here is a result
   * the model is meant to read, including the failures -- see the comment on
   * the `try` further down.
   */
  async function executeToolCall(
    name: string,
    argumentsJson: string,
    correlationId: string,
  ): Promise<ToolCallOutcome> {
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
      writeMode: input.writeMode,
      writeClass: tool.writeClass,
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

    // The budget is spent on the call, not on the page: a fetch that failed
    // still cost a round trip and a browser render, and a run allowed to keep
    // retrying a broken address until one succeeds has no budget at all.
    if (name === WEB_FETCH_TOOL) {
      if (webFetches >= input.webFetchesPerRun) {
        input.logger.info('Refused a web fetch over the run budget', {
          correlationId,
          limit: input.webFetchesPerRun,
        });
        return {
          text:
            `Dieser Lauf hat sein Kontingent von ${input.webFetchesPerRun} Webseiten aufgebraucht. ` +
            'Arbeite mit dem, was du schon gelesen hast, und sage, was du sonst noch nachschlagen würdest.',
          isError: true,
          refused: true,
        };
      }
      webFetches += 1;
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
      // The catalogue can say what a domain holds; only the loop can hand its
      // tools to the next turn (issue #121).
      if (name === TOOLBOX_TOOL && !isError) {
        const opened = openedDomain(argumentsJson);
        if (opened !== null && offer.open(opened)) {
          input.logger.info('Run opened another tool domain', {
            domain: opened,
            correlationId,
            offered: offer.tools().length,
          });
        }
      }
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
      return {
        text: truncate(result.text),
        isError,
        refused: false,
        ...(result.pausesRun === true && !isError ? { pausesRun: true } : {}),
      };
    } catch (error) {
      if (error instanceof ExocortexApiError) {
        return {
          text: describeApiError(error),
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
  }

  return {
    get definitions(): readonly AiToolDefinition[] {
      return offer.tools().map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.jsonSchema,
      }));
    },
    toolContext(): ToolContext {
      const tools = offer.tools();
      return {
        offered: tools.length,
        schemaChars: toolSchemaChars(tools),
        domains: offer.domains(),
      };
    },
    callCount: () => ledger.tallies().reduce((total, tally) => total + tally.calls, 0),
    untrustedOrigins,
    noteUntrustedContent,
    tallies: () => ledger.tallies(),
    async run({ name, argumentsJson, correlationId }) {
      // Every tool call of the built-in loop passes through here, which makes
      // this the place for its span too (issue #57). The name and the outcome
      // are recorded; the arguments and the result never are, because both are
      // somebody's page content.
      return withSpan(
        `ai.tool ${name}`,
        async (span) => {
          const result = bookCall(
            ledger,
            input.logger,
            name,
            argumentsJson,
            await executeToolCall(name, argumentsJson, correlationId),
          );
          span.setAttributes({
            'ai.tool.refused': result.refused,
            'ai.tool.error': result.isError,
          });
          // A failed tool call is a result the loop hands back to the model,
          // never a thrown error, so the status has to be set here or a run
          // that spent four iterations failing would look untroubled.
          if (result.isError) span.setStatus('error', result.refused ? 'refused' : 'tool_error');
          return result;
        },
        { correlationId, attributes: { 'ai.tool.name': name } },
      );
    },
  };
}
