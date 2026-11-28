import { describe, expect, it } from 'vitest';

import { authorOf, groupVersions, type VersionRow } from './page-history';

const MINUTE = 60_000;
const base = new Date('2026-11-28T10:00:00.000Z').getTime();

function row(id: string, minutes: number, patch: Partial<VersionRow> = {}): VersionRow {
  return {
    id,
    createdAt: new Date(base + minutes * MINUTE),
    reason: 'scheduled',
    createdById: 'user1',
    createdByName: 'Johanna',
    journal: null,
    ...patch,
  };
}

const agentJournal = {
  actorId: 'user1',
  agentSessionId: 'session1',
  externalId: 'stdio-123',
  clientLabel: 'claude-code',
};
const runJournal = {
  actorId: 'user1',
  agentSessionId: 'session2',
  externalId: 'ai-run-run42',
  clientLabel: null,
};

describe('authorOf', () => {
  it('names a person when no agent journalled the write', () => {
    expect(authorOf(row('a', 0))).toEqual({ kind: 'person', userId: 'user1', name: 'Johanna' });
  });

  it('names the agent session behind a journalled write', () => {
    expect(authorOf(row('a', 0, { reason: 'api_write', journal: agentJournal }))).toEqual({
      kind: 'agent',
      userId: 'user1',
      name: 'Johanna',
      clientLabel: 'claude-code',
      agentSessionId: 'session1',
    });
  });

  it('names the run when the session is a run of the built-in AI', () => {
    expect(authorOf(row('a', 0, { reason: 'api_write', journal: runJournal }))).toEqual({
      kind: 'aiRun',
      userId: 'user1',
      name: 'Johanna',
      runId: 'run42',
    });
  });

  it('says unknown when the account is gone', () => {
    expect(authorOf(row('a', 0, { createdById: null, createdByName: null }))).toEqual({
      kind: 'unknown',
    });
  });
});

describe('groupVersions', () => {
  it('folds typing samples of one person into one session, newest as its face', () => {
    const groups = groupVersions([row('s1', 0), row('s2', 15), row('s3', 30)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      kind: 'edit',
      representativeId: 's3',
      startedAt: new Date(base).toISOString(),
      endedAt: new Date(base + 30 * MINUTE).toISOString(),
    });
    expect(groups[0]?.versions.map((version) => version.id)).toEqual(['s3', 's2', 's1']);
  });

  it('lets a write series stand for its oldest version, the page before it began', () => {
    const writes = [0, 1, 2].map((minute) =>
      row(`w${minute}`, minute, { reason: 'api_write', journal: runJournal }),
    );
    const groups = groupVersions(writes);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.representativeId).toBe('w0');
    expect(groups[0]?.author).toMatchObject({ kind: 'aiRun', runId: 'run42' });
  });

  it('splits on a gap, on another author and on another kind', () => {
    const groups = groupVersions([
      row('a', 0, { reason: 'api_write', journal: agentJournal }),
      row('b', 30, { reason: 'api_write', journal: agentJournal }),
      row('c', 31, { reason: 'api_write', journal: runJournal }),
      row('d', 32),
    ]);
    expect(groups.map((group) => group.id)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('never folds a version somebody saved by name', () => {
    const groups = groupVersions([
      row('m1', 0, { reason: 'manual' }),
      row('m2', 1, { reason: 'manual' }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('drops nothing', () => {
    const rows = Array.from({ length: 40 }, (_, index) =>
      row(`v${index}`, index * 3, { reason: index % 2 === 0 ? 'scheduled' : 'api_write' }),
    );
    const total = groupVersions(rows).reduce((sum, group) => sum + group.versions.length, 0);
    expect(total).toBe(40);
  });
});
