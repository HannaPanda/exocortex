import { Inject, Injectable } from '@nestjs/common';

import { assertPolicy, canReadDocument, WorkspaceAccessService } from '@exocortex/auth';
import { type DocumentActivityEntry, type DocumentActivityResponse } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';

import { PRISMA } from '../platform/platform.module';

import { DocumentSnapshotService } from './document-snapshot.service';

/** Cap per source query; the merged list is capped again after sorting. */
const MAX_PER_SOURCE = 200;
const MAX_ENTRIES = 200;

/**
 * Same-actor gap under which two periodic snapshots fold into one
 * `editingSession` entry instead of staying separate points (issue #20,
 * "Bearbeitungen im Editor verdichten").
 */
const SESSION_GAP_MS = 30 * 60 * 1000;

/** How close two timestamps have to be to count as "the same instant" for dedup purposes. */
const SAME_INSTANT_TOLERANCE_MS = 60_000;

const AUDIT_ACTION_KINDS = [
  'document.moved',
  'document.moved_workspace',
  'document.archived',
  'document.restored',
  'document.renamed',
  'document.snapshot_restored',
] as const;
type RelevantAuditAction = (typeof AUDIT_ACTION_KINDS)[number];

function isRelevantAuditAction(action: string): action is RelevantAuditAction {
  return (AUDIT_ACTION_KINDS as readonly string[]).includes(action);
}

function metadataString(metadata: unknown, key: string): string | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

interface EditPoint {
  at: Date;
  actorId: string | null;
  actorName: string | null;
}

/** Rounds to the minute so two nearly-simultaneous writes in one transaction compare equal. */
function instantKey(actorId: string | null, at: Date): string {
  return `${actorId ?? 'null'}:${Math.floor(at.getTime() / SAME_INSTANT_TOLERANCE_MS)}`;
}

/**
 * The page's own history (issue #20): a "Verlauf" of what happened to *this*
 * page and how to get back to an earlier state, not a compliance audit trail
 * (`AuditLog` stays out of scope for anything that is not already there).
 *
 * Merges three independent, individually incomplete sources:
 *
 * 1. `DocumentSnapshotService.list` -- every restorable version, already
 *    permission-checked there, reused rather than re-queried.
 * 2. `AuditLog`, filtered to this document either directly
 *    (`targetType: 'document'`) or through a restored snapshot's metadata
 *    (`targetType: 'document_snapshot'`, since a restore audits the snapshot,
 *    not the page). `document.renamed` was added alongside this feature
 *    because a title has no other history; the rest already existed.
 * 3. `Document.createdAt`/`createdById` and `updatedAt`/`updatedById` --
 *    a document is created exactly once and has exactly one "current" editor,
 *    so the row itself is already the whole history for those two facts.
 *
 * Editing-session entries are *derived*, not read from a fourth source: see
 * `buildEditingSessions` below for why they come from `SCHEDULED` snapshots
 * specifically rather than every snapshot reason.
 */
@Injectable()
export class DocumentActivityService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: WorkspaceAccessService,
    private readonly snapshots: DocumentSnapshotService,
  ) {}

  async list(documentId: string, userId: string): Promise<DocumentActivityResponse> {
    const context = await this.access.requireDocumentContext(documentId, userId);
    assertPolicy(canReadDocument(context.role, context.document, context.workspaceId));

    const [document, snapshotList, auditRows] = await Promise.all([
      this.prisma.document.findUniqueOrThrow({
        where: { id: documentId },
        select: {
          createdAt: true,
          createdById: true,
          createdBy: { select: { name: true } },
          updatedAt: true,
          updatedById: true,
          updatedBy: { select: { name: true } },
        },
      }),
      // Already permission-checked inside; the check above is cheap and keeps
      // this method's own contract self-contained.
      this.snapshots.list(documentId, userId),
      this.prisma.auditLog.findMany({
        where: {
          OR: [
            { targetType: 'document', targetId: documentId },
            {
              targetType: 'document_snapshot',
              metadata: { path: ['documentId'], equals: documentId },
            },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: MAX_PER_SOURCE,
        select: {
          id: true,
          action: true,
          targetId: true,
          createdAt: true,
          actorId: true,
          metadata: true,
          actor: { select: { name: true } },
        },
      }),
    ]);

    const entries: DocumentActivityEntry[] = [];
    const knownInstants = new Set<string>();

    entries.push({
      type: 'created',
      id: `${documentId}:created`,
      occurredAt: document.createdAt.toISOString(),
      actorId: document.createdById,
      actorName: document.createdBy?.name ?? null,
    });
    knownInstants.add(instantKey(document.createdById, document.createdAt));

    for (const snapshot of snapshotList.slice(0, MAX_PER_SOURCE)) {
      entries.push({
        type: 'snapshot',
        id: snapshot.id,
        occurredAt: snapshot.createdAt,
        actorId: snapshot.createdById,
        actorName: snapshot.createdByName,
        reason: snapshot.reason,
        byteSize: snapshot.byteSize,
      });
      knownInstants.add(instantKey(snapshot.createdById, new Date(snapshot.createdAt)));
    }

    for (const row of auditRows) {
      if (!isRelevantAuditAction(row.action)) continue;
      const base = {
        id: row.id,
        occurredAt: row.createdAt.toISOString(),
        actorId: row.actorId,
        actorName: row.actor?.name ?? null,
      };
      knownInstants.add(instantKey(row.actorId, row.createdAt));

      switch (row.action) {
        case 'document.moved':
          entries.push({ ...base, type: 'moved', acrossWorkspace: false });
          break;
        case 'document.moved_workspace':
          entries.push({ ...base, type: 'moved', acrossWorkspace: true });
          break;
        case 'document.archived':
          entries.push({ ...base, type: 'archived' });
          break;
        case 'document.restored':
          entries.push({ ...base, type: 'restored' });
          break;
        case 'document.renamed':
          entries.push({
            ...base,
            type: 'renamed',
            previousTitle: metadataString(row.metadata, 'previousTitle'),
            nextTitle: metadataString(row.metadata, 'nextTitle'),
          });
          break;
        case 'document.snapshot_restored':
          // Audited against the snapshot, not the page: `targetId` is the
          // snapshot's own id.
          entries.push({ ...base, type: 'snapshotRestored', restoredFromSnapshotId: row.targetId });
          break;
      }
    }

    for (const session of buildEditingSessions({
      scheduledSnapshots: snapshotList.filter((snapshot) => snapshot.reason === 'scheduled'),
      currentEdit: {
        at: document.updatedAt,
        actorId: document.updatedById,
        actorName: document.updatedBy?.name ?? null,
      },
      knownInstants,
    })) {
      entries.push(session);
    }

    entries.sort((a, b) => sortKey(b) - sortKey(a));
    return { entries: entries.slice(0, MAX_ENTRIES) };
  }
}

function sortKey(entry: DocumentActivityEntry): number {
  return new Date(entry.type === 'editingSession' ? entry.endedAt : entry.occurredAt).getTime();
}

/**
 * Derives `editingSession` entries from `SCHEDULED` snapshots only, not from
 * every snapshot reason.
 *
 * `MANUAL`/`API_WRITE`/`IMPORT`/`PRE_RESTORE` snapshots already surface as
 * their own precise, individually restorable `snapshot` entries -- folding
 * them into a vague session range too would bury the exact restore point the
 * merged list exists to keep visible (issue #20, point 1). `SCHEDULED`
 * snapshots exist for no other reason than sampling an active editing
 * session (`snapshot-active-documents`, gated by
 * `activity.editSessionSnapshotsEnabled`); condensing *those* into ranges is
 * the intended, cheap reading of "regelmäßige Momentaufnahmen wären der
 * billigere Weg" from the issue.
 *
 * Without any `SCHEDULED` snapshots (the setting defaults off), this falls
 * back to at most one single-point session built from `Document.updatedAt` --
 * honest given the data available, not a range, since no earlier boundary is
 * knowable from a single "current state" column.
 */
function buildEditingSessions(input: {
  scheduledSnapshots: { createdAt: string; createdById: string | null; createdByName: string | null }[];
  currentEdit: EditPoint;
  knownInstants: ReadonlySet<string>;
}): Extract<DocumentActivityEntry, { type: 'editingSession' }>[] {
  const points: EditPoint[] = input.scheduledSnapshots
    .map((snapshot) => ({
      at: new Date(snapshot.createdAt),
      actorId: snapshot.createdById,
      actorName: snapshot.createdByName,
    }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  const lastPoint = points[points.length - 1];
  const currentIsNew =
    !input.knownInstants.has(instantKey(input.currentEdit.actorId, input.currentEdit.at)) &&
    (lastPoint === undefined || input.currentEdit.at.getTime() > lastPoint.at.getTime());
  if (currentIsNew) points.push(input.currentEdit);

  const sessions: Extract<DocumentActivityEntry, { type: 'editingSession' }>[] = [];
  let current: EditPoint[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    const started = current[0];
    const ended = current[current.length - 1];
    if (started === undefined || ended === undefined) return;
    sessions.push({
      type: 'editingSession',
      id: `session:${started.actorId ?? 'unknown'}:${started.at.toISOString()}`,
      startedAt: started.at.toISOString(),
      endedAt: ended.at.toISOString(),
      actorId: ended.actorId,
      actorName: ended.actorName,
    });
    current = [];
  };

  for (const point of points) {
    const previous = current[current.length - 1];
    const sameActor = previous !== undefined && previous.actorId === point.actorId;
    const withinGap =
      previous !== undefined && point.at.getTime() - previous.at.getTime() <= SESSION_GAP_MS;
    if (previous !== undefined && !(sameActor && withinGap)) flush();
    current.push(point);
  }
  flush();

  return sessions;
}
