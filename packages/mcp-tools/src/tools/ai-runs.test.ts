import { describe, expect, it } from 'vitest';

import { type AiRun } from '@exocortex/contracts';

import { type ExocortexApiClient } from '../client.js';

import { aiRunCancelTool, aiRunGetTool } from './ai-runs.js';

interface RecordedCall {
  method: string;
  path: string;
}

function createFakeClient(response: unknown): {
  client: ExocortexApiClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const client: ExocortexApiClient = {
    async request(input) {
      calls.push({ method: input.method, path: input.path });
      return input.responseSchema.parse(response);
    },
    async upload(input) {
      calls.push({ method: 'UPLOAD', path: input.path });
      return input.responseSchema.parse(response);
    },
  };
  return { client, calls };
}

const runningRun: AiRun = {
  id: 'run1234567',
  workspaceId: 'ws12345678',
  documentId: null,
  status: 'running',
  provider: 'mock',
  model: 'test-model',
  createdById: 'user123456',
  createdAt: '2026-08-09T10:00:00.000Z',
  startedAt: '2026-08-09T10:00:01.000Z',
  heartbeatAt: '2026-08-09T10:00:31.000Z',
  finishedAt: null,
  usage: null,
  errorCode: null,
  errorDetail: null,
  errorDetailKey: null,
  errorDetailArgs: null,
  resultText: 'Ich schreibe jetzt den strukturierten Inhalt',
  conversationId: null,
  reasoningLevel: 'none',
  toolCalls: 0,
  toolsOffered: 22,
  toolSchemaChars: 29_032,
  toolDomains: ['core', 'pages'],
  toolIterations: 2,
};

describe('aiRunGetTool', () => {
  it('reads the run and reports the signs of life a stalled run would lack', async () => {
    const { client, calls } = createFakeClient(runningRun);

    const result = await aiRunGetTool.run(client, { runId: 'run1234567' });

    expect(calls).toEqual([{ method: 'GET', path: '/api/ai/runs/run1234567' }]);
    expect(result.text).toContain('läuft');
    expect(result.text).toContain('2026-08-09T10:00:31.000Z');
    expect(result.text).toContain('Werkzeugrunden: 2');
    expect(result.text).toContain('Antwort bisher');
  });

  it('names the error code of a run that failed', async () => {
    const { client } = createFakeClient({
      ...runningRun,
      status: 'failed',
      errorCode: 'ai_response_truncated',
      finishedAt: '2026-08-09T10:01:00.000Z',
    });

    const result = await aiRunGetTool.run(client, { runId: 'run1234567' });

    expect(result.text).toContain('fehlgeschlagen');
    expect(result.text).toContain('ai_response_truncated');
  });

  it('reports the diagnosis a failed run carries, not only its code (issue #118)', async () => {
    const { client } = createFakeClient({
      ...runningRun,
      status: 'failed',
      errorCode: 'ai_tool_limit_exceeded',
      errorDetail: 'Die Grenze von 8 Werkzeugrunden ist erreicht: exo_search 14 Aufrufe',
      finishedAt: '2026-08-09T10:01:00.000Z',
    });

    const result = await aiRunGetTool.run(client, { runId: 'run1234567' });

    expect(result.text).toContain('Diagnose: Die Grenze von 8 Werkzeugrunden');
    expect(result.text).toContain('exo_search 14 Aufrufe');
  });

  it('caps the answer excerpt so a long run cannot flood a tool loop', async () => {
    const { client } = createFakeClient({ ...runningRun, resultText: 'x'.repeat(9_000) });

    const result = await aiRunGetTool.run(client, { runId: 'run1234567' });

    expect(result.text.length).toBeLessThan(9_000);
    expect(result.text).toContain('… (gekürzt)');
  });

  it('is read-only', () => {
    expect(aiRunGetTool.mutating).toBe(false);
  });
});

describe('aiRunCancelTool', () => {
  it('posts to the cancel endpoint', async () => {
    const { client, calls } = createFakeClient({
      ...runningRun,
      status: 'cancelled',
      finishedAt: '2026-08-09T10:00:40.000Z',
    });

    const result = await aiRunCancelTool.run(client, { runId: 'run1234567' });

    expect(calls).toEqual([{ method: 'POST', path: '/api/ai/runs/run1234567/cancel' }]);
    expect(result.text).toContain('abgebrochen');
  });

  it('declares the run as its confirmation target', () => {
    expect(aiRunCancelTool.mutating).toBe(true);
    expect(aiRunCancelTool.targetOf({ runId: 'run1234567' })).toBe('ai_run:run1234567');
  });
});

describe('the AI run tools as a pair', () => {
  it('are offered to external MCP clients only, never to the built-in AI', () => {
    // A tool loop that can cancel a run can, first of all, cancel the run it
    // is itself executing in.
    for (const tool of [aiRunGetTool, aiRunCancelTool]) {
      expect(tool.surfaces).toEqual(['mcp']);
    }
  });
});
