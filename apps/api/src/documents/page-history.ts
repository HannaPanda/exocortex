import {
  type PageHistoryAuthor,
  type PageHistoryGroup,
  type PageHistoryGroupKind,
  type PageHistoryVersion,
} from '@exocortex/contracts';

import { runIdFromSessionExternalId } from '../ai/run-changes';

/**
 * The pure half of the page history (issue #235): who caused a version, and
 * which versions belong together. No database; `PageHistoryService` loads.
 */

/** The journal row of the write a snapshot was taken before (ADR-022). */
export interface VersionJournal {
  actorId: string | null;
  agentSessionId: string;
  externalId: string;
  clientLabel: string | null;
}

export interface VersionRow {
  id: string;
  createdAt: Date;
  reason: PageHistoryVersion['reason'];
  createdById: string | null;
  createdByName: string | null;
  journal: VersionJournal | null;
}

/**
 * Who caused one version.
 *
 * The journal decides between agent and person, because the snapshot's own
 * `createdById` is the account a write ran as, which for an agent is the
 * person it acts for. A run of the built-in AI writes under a session whose
 * external id names the run.
 */
export function authorOf(row: VersionRow): PageHistoryAuthor {
  const userId = row.createdById ?? row.journal?.actorId ?? null;
  if (row.journal !== null && userId !== null) {
    const runId = runIdFromSessionExternalId(row.journal.externalId);
    if (runId !== null) return { kind: 'aiRun', userId, name: row.createdByName, runId };
    return {
      kind: 'agent',
      userId,
      name: row.createdByName,
      clientLabel: row.journal.clientLabel,
      agentSessionId: row.journal.agentSessionId,
    };
  }
  if (userId !== null) return { kind: 'person', userId, name: row.createdByName };
  return { kind: 'unknown' };
}

const GROUP_KIND: Record<PageHistoryVersion['reason'], PageHistoryGroupKind> = {
  scheduled: 'edit',
  api_write: 'write',
  pre_restore: 'restore',
  restore: 'restore',
  manual: 'manual',
  import: 'import',
};

/**
 * How far apart two versions may be and still be one entry.
 *
 * Typing is sampled at most every ten minutes by default
 * (`activity.editSessionSnapshotIntervalMinutes`), so an editing session needs
 * a gap well above that or every sample would stand alone; the same thirty
 * minutes the Aktivität tab folds sessions with. A series of writes from
 * outside the editor comes in bursts seconds apart, and ten minutes of silence
 * is a different series.
 */
export const GROUP_GAP_MS: Record<PageHistoryGroupKind, number> = {
  edit: 30 * 60_000,
  write: 10 * 60_000,
  restore: 10 * 60_000,
  import: 10 * 60_000,
  manual: 0,
};

function authorKey(author: PageHistoryAuthor): string {
  switch (author.kind) {
    case 'person':
      return `person:${author.userId}`;
    case 'agent':
      return `agent:${author.agentSessionId}`;
    case 'aiRun':
      return `run:${author.runId}`;
    case 'unknown':
      return 'unknown';
  }
}

/**
 * Folds versions in short succession by the same author into one entry,
 * newest group first. Nothing is dropped: every version stays a member.
 *
 * A version saved by name is never folded, because somebody chose that exact
 * moment. A `write` series stands for its oldest member, the page before the
 * series began, which is the version somebody undoing an agent wants; every
 * other group stands for its newest, the page as the session left it.
 */
export function groupVersions(rows: readonly VersionRow[]): PageHistoryGroup[] {
  const sorted = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const groups: { kind: PageHistoryGroupKind; key: string; members: VersionRow[] }[] = [];

  for (const row of sorted) {
    const kind = GROUP_KIND[row.reason];
    const key = authorKey(authorOf(row));
    const current = groups[groups.length - 1];
    const previous = current?.members[current.members.length - 1];
    const joins =
      current !== undefined &&
      previous !== undefined &&
      current.kind === kind &&
      current.key === key &&
      previous.createdAt.getTime() - row.createdAt.getTime() <= GROUP_GAP_MS[kind];
    if (joins) current.members.push(row);
    else groups.push({ kind, key, members: [row] });
  }

  return groups.map(({ kind, members }) => {
    const newest = members[0] as VersionRow;
    const oldest = members[members.length - 1] as VersionRow;
    const representative = kind === 'write' ? oldest : newest;
    return {
      id: newest.id,
      kind,
      author: authorOf(representative),
      startedAt: oldest.createdAt.toISOString(),
      endedAt: newest.createdAt.toISOString(),
      representativeId: representative.id,
      versions: members.map(toVersion),
    };
  });
}

export function toVersion(row: VersionRow): PageHistoryVersion {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    reason: row.reason,
    author: authorOf(row),
  };
}
