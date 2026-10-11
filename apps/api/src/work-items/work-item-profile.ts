import { type AiReasoningLevel, type CreateWorkItemRequest } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';

import { type AgentProfilesService } from '../agent-profiles/agent-profiles.service';
import { currentAutomation } from '../common/correlation';

import { assertMayChooseProfile } from './work-item-access';
import { type VerifiedWorkflowNode } from './work-item-workflow';

/**
 * The agent profile side of a work item (issue #143, ADR-071): which profile a
 * new item gets, what the profile prefers for a run, and whether an
 * automation may name one.
 */

/**
 * The model and reasoning level a profile prefers, as far as they can be
 * honoured (issue #143). A model that is no longer enabled is skipped
 * rather than refused: a profile names a preference, not a binding, and
 * the run then uses the default model.
 */
export async function profilePreferences(
  prisma: PrismaClient,
  profileId: string | null,
): Promise<{
  modelSlug?: string;
  reasoningLevel?: AiReasoningLevel;
}> {
  if (profileId === null) return {};
  const profile = await prisma.agentProfile.findUnique({
    where: { id: profileId },
    select: { modelSlug: true, reasoningLevel: true },
  });
  if (profile === null) return {};
  const model =
    profile.modelSlug === null
      ? null
      : await prisma.aiModel.findUnique({
          where: { slug: profile.modelSlug },
          select: { enabled: true },
        });
  return {
    ...(model?.enabled === true && profile.modelSlug !== null
      ? { modelSlug: profile.modelSlug }
      : {}),
    ...(profile.reasoningLevel === null
      ? {}
      : { reasoningLevel: profile.reasoningLevel.toLowerCase() as AiReasoningLevel }),
  };
}

/**
 * The profile a new item gets (issue #143): the one it names, when the
 * credential may choose one, or else its parent's, so that a part of a
 * larger piece of work stays under the rules of the whole.
 */
export async function profileForNewItem(
  deps: { prisma: PrismaClient; profiles: AgentProfilesService },
  input: {
    workspaceId: string;
    userId: string;
    request: CreateWorkItemRequest;
    mayChoose: boolean;
    /** The agent node creating the item (issue #162), verified against its run. */
    workflowNode?: VerifiedWorkflowNode | undefined;
  },
): Promise<string | null> {
  const { workspaceId, userId, request, mayChoose, workflowNode } = input;
  if (request.agentProfileId !== undefined) {
    // A workflow's agent node may name exactly the profile its published
    // version names (issue #162): an admin chose it when writing the graph,
    // and the owner switched the workflow on, as for an automation rule.
    const nodeNamesProfile =
      workflowNode !== undefined && workflowNode.node.agentProfileId === request.agentProfileId;
    assertMayChooseProfile(
      mayChoose ||
        nodeNamesProfile ||
        (await ruleNamesProfile(deps.prisma, workspaceId, userId, request.agentProfileId)),
    );
    if (request.agentProfileId === null) return null;
    await deps.profiles.assertUsable(workspaceId, request.agentProfileId);
    return request.agentProfileId;
  }
  if (request.parentId === undefined || request.parentId === null) return null;
  const parent = await deps.prisma.workItem.findUnique({
    where: { id: request.parentId },
    select: { agentProfileId: true },
  });
  return parent?.agentProfileId ?? null;
}

/**
 * Whether this request is the action of an automation rule that names
 * exactly this profile (issue #143). The rule's owner chose the profile
 * when writing the rule, which takes the OWNER role and an admin-class
 * credential; the automation origin is only ever kept for the worker's own
 * service token (`SessionGuard`), so the request cannot claim a rule it is
 * not acting for.
 */
async function ruleNamesProfile(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
  profileId: string | null,
): Promise<boolean> {
  const origin = currentAutomation();
  if (origin === undefined) return false;
  const rule = await prisma.automationRule.findUnique({
    where: { id: origin.ruleId },
    select: { workspaceId: true, action: true, agentProfileId: true, createdById: true },
  });
  return (
    rule !== null &&
    rule.workspaceId === workspaceId &&
    rule.createdById === userId &&
    rule.action === 'WORK_ITEM' &&
    rule.agentProfileId === profileId
  );
}
