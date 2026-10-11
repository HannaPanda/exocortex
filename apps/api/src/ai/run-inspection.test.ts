import { describe, expect, it } from 'vitest';

import { buildRunInspection, type RunEventRow, targetDocumentId } from './run-inspection';
import { mapAiRunRow } from './run-mapper';

const t = (seconds: number): Date => new Date(Date.UTC(2026, 9, 11, 8, 0, seconds));

const run = mapAiRunRow({
  id: 'run-under-test',
  workspaceId: 'ws-1',
  documentId: 'page-open',
  status: 'COMPLETED',
  provider: 'openrouter',
  model: 'deepseek/v4.1-flash',
  createdById: 'user-1',
  createdAt: t(0),
  startedAt: t(1),
  heartbeatAt: t(9),
  finishedAt: t(10),
  usage: null,
  errorCode: null,
  errorDetail: null,
  errorDetailKey: null,
  errorDetailArgs: null,
  resultText: null,
  conversationId: 'conv-1',
  reasoningLevel: 'NONE',
  toolIterations: 1,
  toolCalls: 2,
  toolsOffered: 22,
  toolSchemaChars: 3600,
  toolDomains: ['core'],
  agentProfileSnapshot: null,
});

const row = {
  createdAt: t(0),
  startedAt: t(1),
  finishedAt: t(10),
  correlationId: 'corr-1',
  traceId: null,
  inputTokens: 5000,
  outputTokens: 300,
  cachedInputTokens: 0,
  providerCostMicroUsd: 83_000,
  estimatedCostMicroUsd: null,
  durationMs: 9000,
};

const source = {
  databaseViewId: null,
  savedQueryId: null,
  fullChars: null,
  truncated: false,
  origin: 'internal' as const,
};

const events: RunEventRow[] = [
  {
    sequence: 1,
    kind: 'context',
    at: t(1),
    durationMs: null,
    data: {
      sections: [
        {
          key: 'open_page',
          chars: 400,
          estimatedTokens: 112,
          items: 1,
          truncated: false,
          sources: [
            { ...source, kind: 'page', documentId: 'page-open', mode: 'pointer', chars: 400 },
          ],
        },
        {
          key: 'always_rules',
          chars: 600,
          estimatedTokens: 167,
          items: 1,
          truncated: false,
          sources: [{ ...source, kind: 'rule', documentId: 'page-secret', mode: null, chars: 600 }],
        },
      ],
    },
  },
  turnRow(2, 2, 'DeepInfra'),
  toolRow(3, 'exo_page_read', 'document:page-open', 'succeeded', null),
  toolRow(4, 'exo_web_fetch', null, 'failed', 'web'),
  turnRow(5, 8, 'Chutes'),
  { sequence: 6, kind: 'unknown_kind', at: t(8), durationMs: null, data: {} },
];

function turnRow(sequence: number, second: number, servedBy: string): RunEventRow {
  return {
    sequence,
    kind: 'turn',
    at: t(second),
    durationMs: 1500,
    data: {
      index: sequence,
      model: 'deepseek/v4.1-flash',
      servedBy,
      eligibleProviders: 3,
      finishReason: 'stop',
      inputTokens: 2500,
      outputTokens: 150,
      cachedInputTokens: 0,
      costMicroUsd: 41_000,
      toolCalls: 0,
      reasoned: false,
      outputChars: 420,
      failureCode: null,
    },
  };
}

function toolRow(
  sequence: number,
  toolName: string,
  target: string | null,
  status: string,
  untrustedOrigin: string | null,
): RunEventRow {
  return {
    sequence,
    kind: 'tool_call',
    at: t(sequence + 1),
    durationMs: 120,
    data: {
      iteration: 1,
      toolName,
      status,
      target,
      resultChars: 1000,
      resultTruncated: false,
      untrustedOrigin,
      repeated: false,
      pausedRun: false,
    },
  };
}

const inspection = buildRunInspection({
  run,
  row,
  events,
  relations: {
    attention: [
      {
        id: 'att-1',
        kind: 'approval',
        status: 'resolved',
        title: 'Darf ich?',
        blocking: true,
        createdAt: t(7),
        settledAt: t(30),
        resumedRunId: 'run-next',
      },
    ],
    changesets: [],
    checkpoints: [],
    resumedFrom: [],
  },
  titles: {
    documents: new Map([['page-open', 'Offene Seite']]),
    savedQueries: new Map(),
  },
});

describe('the run inspection (issue #145)', () => {
  it('orders recorded steps and joined facts into one timeline', () => {
    expect(inspection.timeline.map((entry) => entry.kind)).toEqual([
      'created',
      'started',
      'context',
      'turn',
      'tool_call',
      'tool_call',
      'attention_raised',
      'turn',
      'finished',
      'attention_settled',
      'resumed_as',
    ]);
  });

  it('counts providers, switches and failed calls', () => {
    expect(inspection.summary).toMatchObject({
      turns: 2,
      toolCalls: 2,
      failedToolCalls: 1,
      providers: ['DeepInfra', 'Chutes'],
      providerSwitches: 1,
      durationMs: 9000,
      providerCostMicroUsd: 83_000,
    });
  });

  it('names only the pages the reader may see', () => {
    const sources = inspection.context?.sections.flatMap((section) => section.sources) ?? [];
    expect(sources.map((entry) => entry.title)).toEqual(['Offene Seite', null]);
    const read = inspection.timeline.find(
      (entry) => entry.kind === 'tool_call' && entry.toolName === 'exo_page_read',
    );
    expect(read).toMatchObject({ targetTitle: 'Offene Seite' });
  });

  it('adds up what tool answers brought in, by origin', () => {
    expect(inspection.toolResults).toEqual([
      { origin: 'internal', calls: 1, chars: 1000 },
      { origin: 'web', calls: 1, chars: 1000 },
    ]);
    expect(inspection.context).toMatchObject({ chars: 1000, estimatedTokens: 279 });
  });

  it('says whether anything was recorded at all', () => {
    expect(inspection.recorded).toBe(true);
    const old = buildRunInspection({
      run,
      row,
      events: [],
      relations: { attention: [], changesets: [], checkpoints: [], resumedFrom: [] },
      titles: { documents: new Map(), savedQueries: new Map() },
    });
    expect(old.recorded).toBe(false);
    expect(old.context).toBeNull();
    expect(old.timeline.map((entry) => entry.kind)).toEqual(['created', 'started', 'finished']);
  });
});

describe('targetDocumentId', () => {
  it('reads a page out of a document or page target and nothing else', () => {
    expect(targetDocumentId('document:abc')).toBe('abc');
    expect(targetDocumentId('page:abc')).toBe('abc');
    expect(targetDocumentId('workspace:abc')).toBeNull();
    expect(targetDocumentId(null)).toBeNull();
  });
});
