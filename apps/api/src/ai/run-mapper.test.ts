import { describe, expect, it } from 'vitest';

import { type AiRunRow, mapAiRunRow } from './run-mapper';

/** A fully-populated row; individual tests override only what they need. */
const baseRow: AiRunRow = {
  id: 'run1234567',
  workspaceId: 'ws1234567',
  documentId: null,
  status: 'RUNNING',
  provider: 'mock',
  model: 'test-model',
  createdById: 'user1234',
  createdAt: new Date('2026-08-07T10:00:00.000Z'),
  startedAt: new Date('2026-08-07T10:00:01.000Z'),
  heartbeatAt: new Date('2026-08-07T10:00:06.000Z'),
  finishedAt: null,
  usage: null,
  errorCode: null,
  errorDetail: null,
  errorDetailKey: null,
  errorDetailArgs: null,
  resultText: null,
  conversationId: null,
  reasoningLevel: 'NONE',
  toolCalls: 0,
  toolsOffered: null,
  toolSchemaChars: null,
  toolDomains: [],
  toolIterations: 0,
};

describe('mapAiRunRow', () => {
  it("reports the run's own clock as ISO timestamps (issue #16)", () => {
    const mapped = mapAiRunRow(baseRow);
    expect(mapped.startedAt).toBe('2026-08-07T10:00:01.000Z');
    expect(mapped.heartbeatAt).toBe('2026-08-07T10:00:06.000Z');
  });

  it('reports both as null before the run has been picked up', () => {
    const mapped = mapAiRunRow({
      ...baseRow,
      status: 'PENDING',
      startedAt: null,
      heartbeatAt: null,
    });
    expect(mapped.startedAt).toBeNull();
    expect(mapped.heartbeatAt).toBeNull();
  });

  it('carries the partial answer of a still-running run (issue #6)', () => {
    // The worker renews this with every heartbeat, so a client that noticed a
    // gap in the delta stream has something authoritative to reload.
    const mapped = mapAiRunRow({ ...baseRow, resultText: 'Ich schreibe jetzt' });
    expect(mapped.resultText).toBe('Ich schreibe jetzt');
  });

  it('carries the diagnosis of a failed run beside its code (issue #118)', () => {
    const mapped = mapAiRunRow({
      ...baseRow,
      status: 'FAILED',
      errorCode: 'ai_tool_limit_exceeded',
      errorDetail: 'Die Grenze von 8 Werkzeugrunden ist erreicht',
    });
    expect(mapped.errorDetail).toBe('Die Grenze von 8 Werkzeugrunden ist erreicht');
  });

  it('renders a keyed diagnosis in the requester’s locale (issue #98)', () => {
    const row: AiRunRow = {
      ...baseRow,
      status: 'FAILED',
      errorCode: 'ai_tool_limit_exceeded',
      errorDetail: 'Die Grenze von 8 Werkzeugrunden ist erreicht',
      errorDetailKey: 'toolLoop',
      errorDetailArgs: {
        limit: 8,
        tallies: [{ name: 'exo_search', calls: 14, repeats: 0, chars: 128_400 }],
      },
    };
    const german = mapAiRunRow(row, 'de');
    expect(german.errorDetail).toContain('exo_search: 14 Aufrufe, 128.400 Zeichen');
    expect(german.errorDetailKey).toBe('toolLoop');
    // The number follows the reader's locale even before a translation exists.
    expect(mapAiRunRow(row, 'en').errorDetail).toContain('128,400');
  });

  it('keeps the stored text of a row written before the key existed', () => {
    const mapped = mapAiRunRow({ ...baseRow, status: 'FAILED', errorDetail: 'Alter Text' }, 'en');
    expect(mapped.errorDetail).toBe('Alter Text');
    expect(mapped.errorDetailArgs).toBeNull();
  });
});
