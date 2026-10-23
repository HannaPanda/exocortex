import { type AiRunTimeouts, type AiWriteMode, type Settings } from '@exocortex/contracts';
import { type AiMessage } from '@exocortex/contracts';
import { type AiRun } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';
import { toolOfferNote } from '@exocortex/mcp-tools';

import { type ExternalToolLoader, type ExternalToolSource } from '../../external-mcp-tools';
import { type ToolImageDescriber } from '../../tool-images';
import { routeToolDomains, type ToolRoutingOutcome } from '../../tool-routing';
import { type ToolRunner } from '../../tool-runner';
import { type AiRunDependencies } from '../ai-run';

import { profileToolDomains, type RunProfile } from './agent-profile';
import { carriedToolDomains } from './carried-domains';
import { type RunNote } from './context-record';
import { type EvalHold, evalToolDomains } from './eval-hold';
import { taskTextFor } from './preparation';
import { pageRoutingSignals } from './routing-signals';
import { type RunTimeline } from './timeline';

/** What holds one run: its mode, its role, its limits (issues #141 and #143). */
export interface RunPolicy {
  profile: RunProfile | null;
  /** The eval attempt's case, when the run is one (issue #146). */
  evalHold: EvalHold | null;
  writeMode: AiWriteMode;
  /** System messages before the conversation: the role, then the mode. */
  notes: RunNote[];
  timeouts: AiRunTimeouts;
  budgetMicroUsd: number;
  maxToolIterations: number;
}

/**
 * The external tools a run may be offered (issue #196). A database or
 * settings failure here costs the run its external tools, never the run.
 */
async function loadExternalTools(
  loader: ExternalToolLoader | undefined,
  run: AiRun,
  policy: RunPolicy,
  logger: Logger,
): Promise<ExternalToolSource | null> {
  // An eval replay never reaches outside the deployment (issue #146): a
  // foreign server is neither replayable nor harmless.
  if (loader === undefined || policy.evalHold !== null) return null;
  try {
    return await loader({ workspaceId: run.workspaceId, userId: run.createdById });
  } catch (error) {
    logger.warn('Running without external MCP tools: they could not be loaded', {
      runId: run.id,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** The prompt note naming what the run's tool offer leaves out; none without tools. */
function toolOfferNotes(runner: ToolRunner | null): RunNote[] {
  if (runner === null) return [];
  const offer = runner.toolContext();
  const content = toolOfferNote({ offered: offer.domains, closed: offer.closedDomains });
  return content === null ? [] : [{ key: 'tool_offer', message: { role: 'system', content } }];
}

interface RunToolsInput {
  dependencies: AiRunDependencies;
  run: AiRun;
  settings: Settings;
  rest: AiMessage[];
  policy: RunPolicy;
  apiKey: string;
  correlationId: string;
  logger: Logger;
}

/**
 * Which tool domains the run starts with (issues #121 and #206, ADR-089).
 *
 * Jev decides when `ai.semanticToolRouting` is on, the keywords when it is
 * off or Jev cannot answer in time. Either way three facts the words cannot
 * say are added: a database view is open, the run is proposing, or the
 * conversation's last runs already reached for a domain; and a page carrying
 * a picture or a PDF needs the attachment tools before anybody names them.
 */
async function routeRunTools(input: RunToolsInput): Promise<ToolRoutingOutcome> {
  const { dependencies, run } = input;
  const carried = await carriedToolDomains(dependencies.prisma, run);
  return routeToolDomains({
    enabled: input.settings['ai.semanticToolRouting'],
    text: taskTextFor(input.rest),
    required: [
      ...carried,
      ...(run.databaseViewId === null ? [] : (['databases'] as const)),
      // A proposing run needs the proposal tools whatever its words say.
      ...(input.policy.writeMode === 'propose' ? (['changesets'] as const) : []),
    ],
    carried,
    signals: await pageRoutingSignals(dependencies.prisma, run),
    decisions: dependencies.decisionsFor?.(input.apiKey) ?? null,
    correlationId: input.correlationId,
    logger: input.logger,
  });
}

/** The tool loop of one run, told what it may offer and what it may call. */
function createRunToolRunner(
  input: RunToolsInput & {
    externalTools: ExternalToolSource | null;
    describeImage: ToolImageDescriber | null;
    routing: ToolRoutingOutcome;
  },
): ToolRunner {
  const { run, settings, policy } = input;
  const proposing = policy.writeMode === 'propose';
  return input.dependencies.toolRunnerFactory!({
    userId: run.createdById,
    includeMutating: settings['ai.mutatingToolsEnabled'],
    mutationPolicy: settings['ai.untrustedContentPolicy'],
    writeMode: policy.writeMode,
    // Zero when web research is off, which is also how the fetch tool
    // disappears from the catalogue instead of refusing every call.
    webFetchesPerRun: settings['ai.webResearchEnabled']
      ? settings['ai.webResearchMaxFetchesPerRun']
      : 0,
    // Which part of the catalogue this run hears about (issues #121 and
    // #206): chosen before the runner exists, by `routeRunTools`.
    taskText: taskTextFor(input.rest),
    requiredDomains: [],
    offeredDomains: input.routing.domains,
    // The agent profile's domains are a limit, not an offer (issue #143),
    // and an eval case can narrow them further (issue #146).
    allowedDomains: evalToolDomains(
      profileToolDomains(policy.profile, { onWorkItem: run.workItemId !== null, proposing }),
      policy.evalHold,
      proposing ? ['changesets'] : [],
    ),
    // An eval attempt is always held to its workspace, and in the fixture
    // mode to its sandbox (issue #146).
    confinedWorkspaceId:
      policy.profile?.snapshot.confineToWorkspace === true || policy.evalHold !== null
        ? run.workspaceId
        : null,
    confinedPageRootId: policy.evalHold?.pageRootId ?? null,
    externalTools: input.externalTools,
    toolCallTimeoutMs: policy.timeouts.toolCallTimeoutMs,
    // One run, one session (ADR-022): the unit somebody would want back is
    // "what the assistant did while answering that question".
    agentSession: { externalId: `ai-run-${run.id}`, label: 'eXocortex KI' },
    runId: run.id,
    describeImage: input.describeImage,
  });
}

/**
 * Everything about a run's tools before its first turn: who chose them
 * (recorded first on the timeline), the loop that offers them, and the notes
 * the prompt carries, the tool offer's among them (issue #206). Nothing and
 * no notes beyond the policy's when the run has no tools.
 */
export async function prepareRunTools(
  input: RunToolsInput & {
    enabled: boolean;
    timeline: RunTimeline;
    describeImage: ToolImageDescriber | null;
  },
): Promise<{ runner: ToolRunner | null; notes: RunNote[] }> {
  if (!input.enabled || input.dependencies.toolRunnerFactory === null) {
    return { runner: null, notes: input.policy.notes };
  }
  const routing = await routeRunTools(input);
  input.timeline.record(
    { kind: 'tool_routing', data: routing.event },
    routing.durationMs === null ? {} : { durationMs: routing.durationMs },
  );
  const runner = createRunToolRunner({
    ...input,
    externalTools: await loadExternalTools(
      input.dependencies.externalTools,
      input.run,
      input.policy,
      input.logger,
    ),
    routing,
  });
  // What the run was not offered, by name: told in the prompt, because the
  // toolbox's own description did not make the default model look before it
  // said something was missing.
  return { runner, notes: [...input.policy.notes, ...toolOfferNotes(runner)] };
}
