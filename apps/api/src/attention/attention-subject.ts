import {
  type AttentionItem,
  type AttentionSubject,
  type AttentionSubjectPage,
  attentionSubjectSchema,
  type RequestAttention,
} from '@exocortex/contracts';
import { type Prisma, type PrismaClient, type PrismaTransactionClient } from '@exocortex/database';

import { AppError } from '../common/app-error';

/**
 * What an approval is bound to (issue #140, ADR-068).
 *
 * A page's one revision is `DocumentContent.yjsUpdatedAt` (issue #120). An
 * approval records it for every page it names when it is asked; answering
 * compares again, and an answer given after a page moved approves nothing.
 * What is compared is the content alone: a rename or a move does not change
 * what an approval to write a page was about.
 */

interface PageState {
  workspaceId: string;
  title: string;
  revision: string | null;
}

async function pageStates(
  client: PrismaClient | PrismaTransactionClient,
  documentIds: readonly string[],
): Promise<Map<string, PageState>> {
  if (documentIds.length === 0) return new Map();
  const rows = await client.document.findMany({
    where: { id: { in: [...new Set(documentIds)] } },
    select: {
      id: true,
      workspaceId: true,
      title: true,
      content: { select: { yjsUpdatedAt: true } },
    },
  });
  return new Map(
    rows.map((row) => [
      row.id,
      {
        workspaceId: row.workspaceId,
        title: row.title,
        revision: row.content?.yjsUpdatedAt.toISOString() ?? null,
      },
    ]),
  );
}

/**
 * The subject a request binds itself to, checked against the pages as they
 * are now. A page in another workspace is refused like a missing one; a
 * revision the asker sent that is no longer current is refused with the
 * current one, because asking for approval of a state that is already gone
 * would be asking about nothing.
 */
export async function subjectForRequest(
  prisma: PrismaClient,
  workspaceId: string,
  pages: NonNullable<RequestAttention['subjectPages']>,
): Promise<AttentionSubject> {
  const states = await pageStates(
    prisma,
    pages.map((page) => page.documentId),
  );
  const bound = pages.map((page) => {
    const state = states.get(page.documentId);
    if (state === undefined || state.workspaceId !== workspaceId || state.revision === null) {
      throw new AppError('attention_target_invalid', 'A subject page is not in this workspace', {
        documentId: page.documentId,
      });
    }
    if (page.revision !== undefined && page.revision !== state.revision) {
      throw new AppError('attention_subject_changed', 'A subject page changed since it was read', {
        documentId: page.documentId,
        currentYjsUpdatedAt: state.revision,
      });
    }
    return { documentId: page.documentId, revision: state.revision };
  });
  return { kind: 'pages', pages: bound };
}

/** Written only through the schema; a row that does not parse was edited by hand. */
export function parseSubject(value: Prisma.JsonValue | null): AttentionSubject | null {
  if (value === null) return null;
  const parsed = attentionSubjectSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The pages a subject names; none for a changeset, whose changes carry their own revisions. */
export function subjectPageIds(subject: AttentionSubject | null): string[] {
  return subject?.kind === 'pages' ? subject.pages.map((page) => page.documentId) : [];
}

/**
 * True when what the subject names has moved since: a page at another
 * revision or gone, a changeset whose changes no longer hash the same or
 * that is gone (issue #141).
 */
export async function subjectChanged(
  client: PrismaClient | PrismaTransactionClient,
  workspaceId: string,
  subject: AttentionSubject,
): Promise<boolean> {
  if (subject.kind === 'changeset') {
    const changeset = await client.changeset.findUnique({
      where: { id: subject.changesetId },
      select: { workspaceId: true, contentHash: true },
    });
    return (
      changeset === null ||
      changeset.workspaceId !== workspaceId ||
      changeset.contentHash !== subject.hash
    );
  }
  const states = await pageStates(
    client,
    subject.pages.map((page) => page.documentId),
  );
  return subject.pages.some((page) => {
    const state = states.get(page.documentId);
    return (
      state === undefined || state.workspaceId !== workspaceId || state.revision !== page.revision
    );
  });
}

/**
 * The subject pages of several items as a reader sees them, in one query.
 * Keyed by attention item id; an item without a subject has no entry.
 */
export async function subjectPagesFor(
  prisma: PrismaClient,
  rows: readonly { id: string; workspaceId: string; subject: Prisma.JsonValue | null }[],
): Promise<Map<string, AttentionSubjectPage[]>> {
  const subjects = rows
    .map((row) => ({ row, subject: parseSubject(row.subject) }))
    .filter(
      (
        entry,
      ): entry is {
        row: (typeof rows)[number];
        subject: Extract<AttentionSubject, { kind: 'pages' }>;
      } => entry.subject?.kind === 'pages',
    );
  const states = await pageStates(
    prisma,
    subjects.flatMap((entry) => entry.subject.pages.map((page) => page.documentId)),
  );
  return new Map(
    subjects.map(({ row, subject }) => [
      row.id,
      subject.pages.map((page) => {
        const state = states.get(page.documentId);
        const visible = state !== undefined && state.workspaceId === row.workspaceId;
        return {
          documentId: page.documentId,
          revision: page.revision,
          title: visible ? state.title : null,
          changed: !visible || state.revision !== page.revision,
        };
      }),
    ]),
  );
}

/**
 * The changesets several items are about, as a reader sees them, in one
 * query (issue #141). Keyed by attention item id.
 */
export async function subjectChangesetsFor(
  prisma: PrismaClient,
  rows: readonly { id: string; workspaceId: string; subject: Prisma.JsonValue | null }[],
): Promise<Map<string, NonNullable<AttentionItem['changeset']>>> {
  const bound = rows
    .map((row) => ({ row, subject: parseSubject(row.subject) }))
    .filter(
      (
        entry,
      ): entry is {
        row: (typeof rows)[number];
        subject: Extract<AttentionSubject, { kind: 'changeset' }>;
      } => entry.subject?.kind === 'changeset',
    );
  if (bound.length === 0) return new Map();
  const changesets = await prisma.changeset.findMany({
    where: { id: { in: bound.map((entry) => entry.subject.changesetId) } },
    select: {
      id: true,
      workspaceId: true,
      title: true,
      status: true,
      contentHash: true,
      changes: { select: { status: true } },
    },
  });
  const byId = new Map(changesets.map((changeset) => [changeset.id, changeset]));
  const result = new Map<string, NonNullable<AttentionItem['changeset']>>();
  for (const { row, subject } of bound) {
    const changeset = byId.get(subject.changesetId);
    if (changeset === undefined || changeset.workspaceId !== row.workspaceId) continue;
    result.set(row.id, {
      id: changeset.id,
      title: changeset.title,
      status: changeset.status.toLowerCase(),
      pending: changeset.changes.filter((change) => change.status === 'PENDING').length,
      total: changeset.changes.length,
      intact: changeset.contentHash === subject.hash,
    });
  }
  return result;
}
