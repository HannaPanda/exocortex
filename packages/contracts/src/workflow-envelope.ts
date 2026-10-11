import { stricterLimit } from './agent-profiles';
import { type AiWriteMode, strictestWriteMode } from './ai-trust';
import { type WorkflowNodeOf } from './workflow-graph';
import { type WorkflowEnvelope } from './workflows';

/**
 * What an agent node will actually run under (issue #164).
 *
 * A node's own settings are one voice among several: the workspace's
 * `ai.writeMode`, the profile the work item runs under, and for a test run
 * the run's own ceiling each narrow it further, and its budget is cut by the
 * run's and the profile's. The editor shows this beside what the node says,
 * so an inherited restriction is never hidden. It is the same combination
 * the work item and the run apply (ADR-070, ADR-071), computed ahead of time
 * and only as a promise: the run itself decides again when it starts.
 */

/** The parts of a profile that narrow an agent node. */
export interface WorkflowAgentNodeProfile {
  id: string;
  name: string;
  writeMode: AiWriteMode;
  budgetMicroUsdPerTask: number | null;
}

export interface WorkflowAgentNodeEffect {
  /** The profile the node's work runs under: its own, or the workspace's default. */
  profile: WorkflowAgentNodeProfile | null;
  /** True when the node names no profile and inherits the default. */
  profileInherited: boolean;
  /** The strictest of the node's, the profile's, the workspace's and the run's mode. */
  writeMode: AiWriteMode;
  /** True when something other than the node itself made the mode stricter. */
  writeModeNarrowed: boolean;
  /** The most the node's work may spend, never more than the run's budget. */
  budgetMicroUsd: number;
  /** True when the run's or the profile's budget is below the node's own. */
  budgetNarrowed: boolean;
}

export function workflowAgentNodeEffect(input: {
  node: Pick<WorkflowNodeOf<'agent'>, 'agentProfileId' | 'writeMode' | 'budgetMicroUsd'>;
  envelope: WorkflowEnvelope;
  /** Every profile of the workspace, the default among them. */
  profiles: readonly (WorkflowAgentNodeProfile & { isDefault: boolean })[];
  /** A test run's ceiling, when the question is about one. */
  runWriteMode?: AiWriteMode | null;
}): WorkflowAgentNodeEffect {
  const { node, envelope } = input;
  const named =
    node.agentProfileId === null
      ? undefined
      : input.profiles.find((profile) => profile.id === node.agentProfileId);
  const profile =
    node.agentProfileId === null
      ? (input.profiles.find((candidate) => candidate.isDefault) ?? null)
      : (named ?? null);
  const writeMode = strictestWriteMode(
    node.writeMode,
    profile?.writeMode,
    envelope.writeMode,
    input.runWriteMode,
  );
  const budget = stricterLimit(
    stricterLimit(node.budgetMicroUsd, envelope.limits.budgetMicroUsd),
    profile?.budgetMicroUsdPerTask,
  )!;
  return {
    profile:
      profile === null
        ? null
        : {
            id: profile.id,
            name: profile.name,
            writeMode: profile.writeMode,
            budgetMicroUsdPerTask: profile.budgetMicroUsdPerTask,
          },
    profileInherited: node.agentProfileId === null,
    writeMode,
    writeModeNarrowed: writeMode !== strictestWriteMode(node.writeMode),
    budgetMicroUsd: budget,
    budgetNarrowed: node.budgetMicroUsd === null ? false : budget < node.budgetMicroUsd,
  };
}
