import { describe, expect, it } from 'vitest';

import { type PrismaClient } from '@exocortex/database';
import { type ExocortexApiClient } from '@exocortex/mcp-tools';

import { type AutomationRuleRecord } from './run-recorder';
import { handOverWork } from './work-item';

const rule: AutomationRuleRecord = {
  id: 'rule-under-test',
  workspaceId: 'ws-1',
  name: 'Prüfen',
  enabled: true,
  action: 'WORK_ITEM',
  output: 'COMMENT',
  webhookUrl: null,
  secretCiphertext: null,
  secretIv: null,
  secretAuthTag: null,
  secretKeyVersion: null,
  prompt: 'Finde veraltete Angaben.',
  modelSlug: null,
  mailSubject: null,
  agentProfileId: 'profile-under-test',
  startWorkItemRun: true,
  createdById: 'owner-1',
};

const payload = {
  correlationId: 'corr-1',
  workspaceId: 'ws-1',
  documentId: 'page-1',
  ruleId: rule.id,
  trigger: 'DOCUMENT_CONTENT_CHANGED',
  origin: 'event',
  depth: 0,
} as unknown as Parameters<typeof handOverWork>[0]['payload'];

const prisma = {
  document: { findUnique: async () => ({ title: 'Preisliste' }) },
} as unknown as PrismaClient;

function recordingClient() {
  const calls: { path: string; body: unknown; headers: Record<string, string> | undefined }[] = [];
  const apiClientFor = (_userId: string, headers?: Record<string, string>): ExocortexApiClient =>
    ({
      request: async (request: { path: string; body?: unknown }) => {
        calls.push({ path: request.path, body: request.body, headers });
        return request.path.endsWith('/runs')
          ? { run: { id: 'run-1' } }
          : { workItem: { id: 'work-1' } };
      },
    }) as unknown as ExocortexApiClient;
  return { calls, apiClientFor };
}

describe('the work item action (issue #143)', () => {
  it('hands the page over under the rule profile and starts the assistant', async () => {
    const { calls, apiClientFor } = recordingClient();
    const result = await handOverWork({ rule, aiEnabled: true, prisma, apiClientFor, payload });

    expect(result).toEqual({ output: 'WORK_ITEM', workItemId: 'work-1', runId: 'run-1' });
    expect(calls[0]?.path).toBe('/api/workspaces/ws-1/work-items');
    expect(calls[0]?.body).toEqual({
      title: 'Prüfen: Preisliste',
      goal: 'Finde veraltete Angaben.',
      contextDocumentIds: ['page-1'],
      agentProfileId: 'profile-under-test',
    });
    // The origin is what lets the work item route accept the rule's profile.
    expect(Object.values(calls[0]?.headers ?? {})).toContain('rule-under-test:0');
    expect(calls[1]?.path).toBe('/api/work-items/work-1/runs');
  });

  it('starts nothing when the AI is off and the rule wants a run', async () => {
    const { calls, apiClientFor } = recordingClient();
    await expect(
      handOverWork({ rule, aiEnabled: false, prisma, apiClientFor, payload }),
    ).rejects.toThrow('AI is switched off');
    expect(calls).toHaveLength(0);
  });
});
