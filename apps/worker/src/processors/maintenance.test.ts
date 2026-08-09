import { describe, expect, it } from 'vitest';

import { pruneSnapshotIds } from './maintenance';

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date('2026-08-09T12:00:00.000Z');
const fullCutoff = new Date(now.getTime() - 7 * DAY_MS);
const dailyCutoff = new Date(now.getTime() - 30 * DAY_MS);

function daysAgo(days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

describe('pruneSnapshotIds', () => {
  it('keeps everything inside the full-retention window', () => {
    const snapshots = [
      { id: 'a', createdAt: daysAgo(0) },
      { id: 'b', createdAt: daysAgo(3) },
      { id: 'c', createdAt: daysAgo(6.9) },
    ];

    expect(pruneSnapshotIds(snapshots, { fullCutoff, dailyCutoff })).toEqual([]);
  });

  it('deletes nothing when there is too little data to thin (a bucket of one)', () => {
    // One snapshot per day, well outside the full-retention window but each
    // one alone in its own day-bucket: nothing to prune from a bucket of one.
    const snapshots = [
      { id: 'a', createdAt: daysAgo(10) },
      { id: 'b', createdAt: daysAgo(15) },
      { id: 'c', createdAt: daysAgo(20) },
    ];

    expect(pruneSnapshotIds(snapshots, { fullCutoff, dailyCutoff })).toEqual([]);
  });

  it('keeps the newest snapshot per day and deletes the rest, in the daily tier', () => {
    const day = daysAgo(10);
    const snapshots = [
      { id: 'newest', createdAt: day },
      { id: 'older-same-day', createdAt: new Date(day.getTime() - 60 * 60 * 1000) },
      { id: 'oldest-same-day', createdAt: new Date(day.getTime() - 5 * 60 * 60 * 1000) },
    ];

    const deleted = pruneSnapshotIds(snapshots, { fullCutoff, dailyCutoff });

    expect(deleted.sort()).toEqual(['older-same-day', 'oldest-same-day']);
  });

  it('keeps the newest snapshot per week and deletes the rest, in the weekly tier', () => {
    const week = daysAgo(40);
    const snapshots = [
      { id: 'newest', createdAt: week },
      { id: 'same-week-1', createdAt: new Date(week.getTime() - 1 * DAY_MS) },
      { id: 'same-week-2', createdAt: new Date(week.getTime() - 2 * DAY_MS) },
      // A week and a half further back: a different epoch-week bucket, so
      // this one survives on its own.
      { id: 'different-week', createdAt: daysAgo(50) },
    ];

    const deleted = pruneSnapshotIds(snapshots, { fullCutoff, dailyCutoff });

    expect(deleted.sort()).toEqual(['same-week-1', 'same-week-2']);
  });

  it('does not care about input order: the newest in a bucket always wins', () => {
    const day = daysAgo(10);
    const snapshots = [
      { id: 'older', createdAt: new Date(day.getTime() - 60 * 60 * 1000) },
      { id: 'newest', createdAt: day },
    ];

    expect(pruneSnapshotIds(snapshots, { fullCutoff, dailyCutoff })).toEqual(['older']);
  });

  it('returns nothing for an empty list', () => {
    expect(pruneSnapshotIds([], { fullCutoff, dailyCutoff })).toEqual([]);
  });
});
