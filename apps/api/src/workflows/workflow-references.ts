import { type WorkflowGraph, type WorkflowProblem } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';

/**
 * What a graph names outside itself, checked against the database (issue
 * #160, ADR-075): agent profiles, pages and people have to belong to the
 * workflow's workspace. Pure validation cannot know that, so these problems
 * are added beside its own, in the same shape, as `reference_not_found`.
 *
 * Belonging is all that is checked here. Whether a profile may be used by
 * whoever starts a run is decided when the run starts, by the rules that
 * decide it for every work item (ADR-071).
 */
export async function referenceProblems(
  prisma: PrismaClient,
  workspaceId: string,
  graph: WorkflowGraph,
): Promise<WorkflowProblem[]> {
  const wanted = collectReferences(graph);
  const [profiles, pages, members] = await Promise.all([
    wanted.profiles.size === 0
      ? []
      : prisma.agentProfile.findMany({
          where: { id: { in: [...wanted.profiles] }, workspaceId },
          select: { id: true },
        }),
    wanted.pages.size === 0
      ? []
      : prisma.document.findMany({
          where: { id: { in: [...wanted.pages] }, workspaceId, archivedAt: null },
          select: { id: true },
        }),
    wanted.users.size === 0
      ? []
      : prisma.workspaceMember.findMany({
          where: { userId: { in: [...wanted.users] }, workspaceId },
          select: { userId: true },
        }),
  ]);
  const found = new Set([
    ...profiles.map((row) => `profile:${row.id}`),
    ...pages.map((row) => `page:${row.id}`),
    ...members.map((row) => `user:${row.userId}`),
  ]);

  const problems: WorkflowProblem[] = [];
  for (const reference of wanted.list) {
    if (found.has(reference.key)) continue;
    problems.push({
      code: 'reference_not_found',
      message: `${reference.what} is not part of this workspace`,
      nodeId: reference.nodeId,
      edgeId: null,
      path: null,
    });
  }
  return problems;
}

interface Reference {
  key: string;
  nodeId: string;
  what: string;
}

function collectReferences(graph: WorkflowGraph) {
  const list: Reference[] = [];
  const profiles = new Set<string>();
  const pages = new Set<string>();
  const users = new Set<string>();
  const page = (nodeId: string, id: string) => {
    pages.add(id);
    list.push({ key: `page:${id}`, nodeId, what: `Page ${id}` });
  };
  for (const node of graph.nodes) {
    if (node.type === 'agent') {
      if (node.agentProfileId !== null) {
        profiles.add(node.agentProfileId);
        list.push({
          key: `profile:${node.agentProfileId}`,
          nodeId: node.id,
          what: `Agent profile ${node.agentProfileId}`,
        });
      }
      for (const id of node.documentIds) page(node.id, id);
    }
    if (node.type === 'trigger.event' && node.scopeDocumentId !== null) {
      page(node.id, node.scopeDocumentId);
    }
    if (node.type === 'approval' && node.assigneeUserId !== null) {
      users.add(node.assigneeUserId);
      list.push({
        key: `user:${node.assigneeUserId}`,
        nodeId: node.id,
        what: `Person ${node.assigneeUserId}`,
      });
    }
  }
  return { list, profiles, pages, users };
}
