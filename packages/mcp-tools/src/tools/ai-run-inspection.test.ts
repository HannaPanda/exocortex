import { describe, expect, it } from 'vitest';

import { type AiRunInspection } from '@exocortex/contracts';

import { type ExocortexApiClient } from '../client.js';

import { aiRunInspectTool } from './ai-run-inspection.js';

const inspection: AiRunInspection = {
  run: {
    id: 'run1234567',
    workspaceId: 'ws12345678',
    documentId: null,
    status: 'completed',
    provider: 'openrouter',
    model: 'deepseek/v4.1-flash',
    createdById: 'user123456',
    createdAt: '2026-10-11T08:00:00.000Z',
    startedAt: '2026-10-11T08:00:01.000Z',
    heartbeatAt: null,
    finishedAt: '2026-10-11T08:00:10.000Z',
    usage: null,
    errorCode: null,
    errorDetail: null,
    errorDetailKey: null,
    errorDetailArgs: null,
    resultText: null,
    conversationId: 'conv123456',
    reasoningLevel: 'none',
    toolCalls: 1,
    toolsOffered: 22,
    toolSchemaChars: 3600,
    toolDomains: ['core'],
    toolIterations: 1,
    agentProfile: null,
  },
  trace: { correlationId: 'corr-1', traceId: null },
  recorded: true,
  eventsCapped: false,
  summary: {
    durationMs: 9000,
    turns: 1,
    toolCalls: 1,
    failedToolCalls: 0,
    providers: ['DeepInfra'],
    providerSwitches: 0,
    inputTokens: 4200,
    outputTokens: 300,
    cachedInputTokens: 0,
    providerCostMicroUsd: 83_000,
    estimatedCostMicroUsd: null,
  },
  context: {
    chars: 1000,
    estimatedTokens: 278,
    sections: [
      {
        key: 'open_page',
        chars: 1000,
        estimatedTokens: 278,
        items: 1,
        truncated: false,
        sources: [
          {
            kind: 'page',
            documentId: 'page123456',
            databaseViewId: null,
            savedQueryId: null,
            mode: 'pointer',
            chars: 1000,
            fullChars: null,
            truncated: false,
            origin: 'internal',
            title: 'Reiseplanung',
          },
        ],
      },
    ],
  },
  toolResults: [{ origin: 'web', calls: 1, chars: 5000 }],
  timeline: [
    { at: '2026-10-11T08:00:00.000Z', durationMs: null, kind: 'created' },
    {
      at: '2026-10-11T08:00:03.000Z',
      durationMs: 840,
      kind: 'tool_call',
      iteration: 1,
      toolName: 'exo_web_fetch',
      status: 'succeeded',
      target: null,
      targetTitle: null,
      resultChars: 5000,
      resultTruncated: false,
      untrustedOrigin: 'web',
      repeated: false,
      pausedRun: false,
    },
  ],
};

describe('aiRunInspectTool (issue #145)', () => {
  it('reads the inspection and says what the run did, without any text of it', async () => {
    const paths: string[] = [];
    const client: ExocortexApiClient = {
      async request(input) {
        paths.push(input.path);
        return input.responseSchema.parse(inspection);
      },
      async upload() {
        throw new Error('not used');
      },
    };
    const result = await aiRunInspectTool.run(client, { runId: 'run1234567' });

    expect(paths).toEqual(['/api/ai/runs/run1234567/inspection']);
    expect(result.text).toContain('Anbieter: DeepInfra');
    expect(result.text).toContain('Geöffnete Seite: 1000 Zeichen (Reiseplanung)');
    expect(result.text).toContain(
      '+3.0 s exo_web_fetch succeeded, 5000 Zeichen, Fremdinhalt (web) (0.8 s)',
    );
    expect(result.text).toContain('Korrelations-ID: corr-1');
  });

  it('is offered to external agents only', () => {
    expect(aiRunInspectTool.surfaces).toEqual(['mcp']);
    expect(aiRunInspectTool.mutating).toBe(false);
  });
});
