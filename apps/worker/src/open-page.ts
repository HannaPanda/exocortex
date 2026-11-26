import { mayBeConversationPage, WorkspaceAccessService } from '@exocortex/auth';
import { type SharePermission, type ShareScope } from '@exocortex/contracts';
import { type DocumentType, type PrismaClient } from '@exocortex/database';

/**
 * The page a run has open: whether the run may name it, from which workspace
 * it is read, and how far up its breadcrumb goes (issue #234 split this out
 * of `system-prompt.ts`, which formats what is loaded here).
 */

/** The grant through which a run reaches a page of another workspace (issue #234). */
export interface OpenPageShare {
  /** The shared page. Everything above it is outside the grant and is never named. */
  rootId: string;
  scope: ShareScope;
  permission: SharePermission;
}

/** Where the run's open page lives, and how the run's person reaches it. */
export interface OpenPageReach {
  /** The page's own workspace: the run's, unless a share reached the page. */
  workspaceId: string;
  /** `null` for a page of the run's own workspace. */
  share: OpenPageShare | null;
}

/**
 * Whether a run may name its open page, and from which workspace it reads it.
 *
 * A page of the run's own workspace is read there, as before. A page of
 * another workspace is read only while the run's person still holds a share
 * on it (issue #234): the API checked that when the message was posted, and
 * this asks again when the run starts, because a grant withdrawn in between
 * must take the page out of the prompt as well as out of every tool call.
 * The answer comes from `WorkspaceAccessService.findDocumentContext`, the
 * same function every API route asks, so the worker cannot disagree with the
 * API about who reaches what.
 *
 * `null` means: do not name the page at all.
 */
export async function resolveOpenPageReach(input: {
  prisma: PrismaClient;
  runWorkspaceId: string;
  documentId: string;
  userId: string;
}): Promise<OpenPageReach | null> {
  const document = await input.prisma.document.findUnique({
    where: { id: input.documentId },
    select: { workspaceId: true },
  });
  if (document === null) return null;
  if (document.workspaceId === input.runWorkspaceId) {
    return { workspaceId: document.workspaceId, share: null };
  }

  const context = await new WorkspaceAccessService(input.prisma).findDocumentContext(
    input.documentId,
    input.userId,
  );
  if (
    context === null ||
    context.grant.source !== 'share' ||
    !mayBeConversationPage(context, input.runWorkspaceId)
  ) {
    return null;
  }
  return {
    workspaceId: context.workspaceId,
    share: {
      rootId: context.grant.rootId,
      scope: context.grant.scope,
      permission: context.grant.permission,
    },
  };
}

/** How far up the tree the breadcrumb of the open page is resolved. Deeper ancestors are elided. */
const MAX_PATH_DEPTH = 8;

export interface OpenPage {
  id: string;
  title: string;
  type: DocumentType;
  archived: boolean;
  /** Ancestor titles from the root down to (and excluding) the page itself. Possibly elided at the front. */
  ancestorTitles: readonly string[];
  /** `true` when the breadcrumb was cut off at `MAX_PATH_DEPTH`. */
  pathElided: boolean;
  /**
   * The grant through which the user reaches this page from another
   * workspace (issue #234), or absent for a page of the run's own workspace.
   */
  share?: Pick<OpenPageShare, 'scope' | 'permission'> | null;
}

/**
 * What the model is told about a page somebody shared with the user from
 * another workspace (issue #234).
 *
 * A courtesy to the model, not the boundary: every tool call is authorized as
 * the user again, so a write on a READ grant, a sub-page of a single shared
 * page or a search in the other workspace is refused by the API whatever this
 * says. Saying it up front only spares the run the calls it would lose.
 */
export function sharedPageLines(share: Pick<OpenPageShare, 'scope' | 'permission'>): string[] {
  const reach =
    share.scope === 'SUBTREE'
      ? 'Die Freigabe umfasst diese Seite und die Seiten darunter.'
      : 'Die Freigabe umfasst nur diese eine Seite, ihre Unterseiten gehören nicht dazu.';
  const permission =
    share.permission === 'WRITE'
      ? 'Die Nutzerin darf hier lesen und bearbeiten.'
      : 'Die Nutzerin darf hier nur lesen; ändern kannst du diese Seite nicht.';
  return [
    'Diese Seite gehört nicht zum Arbeitsbereich dieses Chats, jemand hat sie mit der Nutzerin geteilt.',
    `${reach} ${permission}`,
    'In dem Arbeitsbereich, aus dem sie stammt, erreichst du nichts außerhalb der Freigabe: keine',
    'Suche, keinen Seitenbaum, keine anderen Seiten oder Datenbanken. Versuche es nicht; sage es,',
    'wenn eine Frage mehr verlangt.',
  ];
}

/**
 * Loads the open page and its breadcrumb.
 *
 * Scoped to the workspace `resolveOpenPageReach` answered on purpose: a run
 * may carry a `documentId` from an older turn or from a client that guessed
 * one, and a title from a workspace the run has nothing to do with must never
 * reach the prompt. That is the run's own workspace, or the page's when the
 * run's person holds a live share on it.
 */
export async function loadOpenPage(input: {
  prisma: PrismaClient;
  /** The page's own workspace, which is the run's unless `share` is set. */
  workspaceId: string;
  documentId: string;
  /**
   * The grant from another workspace (issue #234). The breadcrumb then stops
   * at the shared page, as it does in the browser: the titles above it are
   * pages nobody shared.
   */
  share: OpenPageShare | null;
}): Promise<OpenPage | null> {
  const { prisma, workspaceId, documentId, share } = input;

  const document = await prisma.document.findFirst({
    where: { id: documentId, workspaceId },
    select: { id: true, title: true, type: true, parentId: true, archivedAt: true },
  });
  if (document === null) return null;

  const ancestorTitles: string[] = [];
  // A shared page is its own root: nothing above it is named.
  let parentId = share !== null && share.rootId === document.id ? null : document.parentId;
  let pathElided = false;
  let metShareRoot = false;
  for (let depth = 0; parentId !== null; depth += 1) {
    if (depth >= MAX_PATH_DEPTH) {
      pathElided = true;
      break;
    }
    const parent: { title: string; parentId: string | null } | null =
      await prisma.document.findFirst({
        where: { id: parentId, workspaceId },
        select: { title: true, parentId: true },
      });
    if (parent === null) break;
    ancestorTitles.unshift(parent.title);
    // The shared page is the last title the grant covers on the way up.
    if (share !== null && share.rootId === parentId) {
      metShareRoot = true;
      parentId = null;
    } else {
      parentId = parent.parentId;
    }
  }
  // A walk that never met the shared page (the page moved out of the branch
  // a moment ago) names nothing, rather than titles above the grant.
  if (share !== null && share.rootId !== document.id && !metShareRoot) {
    ancestorTitles.length = 0;
    pathElided = false;
  }

  return {
    id: document.id,
    title: document.title,
    type: document.type,
    archived: document.archivedAt !== null,
    ancestorTitles,
    pathElided,
    share: share === null ? null : { scope: share.scope, permission: share.permission },
  };
}
