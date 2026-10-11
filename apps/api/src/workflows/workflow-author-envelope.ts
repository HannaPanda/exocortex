import { type WorkflowGraph, type WorkflowProblem } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';

import {
  limitsOf,
  PROFILE_LIMITS_SELECT,
  profileNoLooser,
} from '../work-items/work-item-delegation-rules';

/**
 * What a run of the built-in AI may put into a workflow it drafts (issue
 * #165, ADR-080): no agent node under a looser profile than the run works
 * under itself.
 *
 * A draft starts nothing, and a person publishes it, so this is not the
 * last line. It is the line that keeps the review honest: a run held to a
 * narrow profile must not be able to hand a person a graph whose agents
 * would run under a wider one, and count on the wider one being overlooked.
 * The same rule decides which profile a run may give a child work item
 * (ADR-072), so the two cannot drift apart.
 *
 * A node without a profile works under the workspace's default, and is
 * compared as that. The write mode needs no rule of its own: drafting is a
 * write, which a proposing or read-only run is refused before it gets here,
 * and a profile's own mode is part of what "no looser" compares.
 */
export async function authorEnvelopeProblems(
  prisma: PrismaClient,
  input: { aiRunId: string; workspaceId: string; graph: WorkflowGraph },
): Promise<WorkflowProblem[]> {
  const agentNodes = input.graph.nodes.filter((node) => node.type === 'agent');
  if (agentNodes.length === 0) return [];

  const run = await prisma.aiRun.findUnique({
    where: { id: input.aiRunId },
    select: { agentProfileId: true },
  });
  const [runProfile, defaultProfile] = await Promise.all([
    run?.agentProfileId == null
      ? null
      : prisma.agentProfile.findUnique({
          where: { id: run.agentProfileId },
          select: PROFILE_LIMITS_SELECT,
        }),
    prisma.agentProfile.findFirst({
      where: { workspaceId: input.workspaceId, isDefault: true },
      select: { id: true, ...PROFILE_LIMITS_SELECT },
    }),
  ]);
  const author = runProfile ?? defaultProfile;
  // A run under no profile at all is held to nothing a profile could say.
  if (author === null) return [];
  const authorLimits = limitsOf(author);

  const named = [
    ...new Set(
      agentNodes.flatMap((node) => (node.agentProfileId === null ? [] : [node.agentProfileId])),
    ),
  ];
  const profiles = await prisma.agentProfile.findMany({
    where: { id: { in: named }, workspaceId: input.workspaceId },
    select: { id: true, ...PROFILE_LIMITS_SELECT },
  });
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));

  const problems: WorkflowProblem[] = [];
  for (const node of agentNodes) {
    const profile = node.agentProfileId === null ? defaultProfile : byId.get(node.agentProfileId);
    // A profile from elsewhere is `reference_not_found` already.
    if (node.agentProfileId !== null && profile === undefined) continue;
    if (profile != null && profileNoLooser(limitsOf(profile), authorLimits)) continue;
    problems.push({
      code: 'profile_looser_than_author',
      message:
        node.agentProfileId === null
          ? 'Without a profile this agent would work under the workspace default, which is looser than the profile of the run writing the draft; name one at least as strict'
          : 'This agent profile is looser than the profile of the run writing the draft',
      nodeId: node.id,
      edgeId: null,
      path: null,
    });
  }
  return problems;
}
