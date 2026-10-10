import { describe, expect, it } from 'vitest';

import { type AgentProfileSnapshot } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';

import {
  profileLimits,
  profileMessage,
  profileToolDomains,
  type RunProfile,
} from './agent-profile';

const snapshot: AgentProfileSnapshot = {
  id: 'profile-under-test',
  name: 'Rechercheur',
  revision: 3,
  source: 'work_item',
  writeMode: 'read_only',
  approvalPolicy: 'none',
  toolDomains: ['web'],
  modelSlug: null,
  reasoningLevel: null,
  budgetMicroUsdPerRun: 200_000,
  budgetMicroUsdPerTask: null,
  maxToolIterations: 50,
  maxRunSeconds: 60,
  confineToWorkspace: true,
};

const profile: RunProfile = {
  snapshot,
  instructions: 'Belege jede Aussage.',
  ruleDocumentIds: ['rule-page-1', 'rule-page-gone'],
  providerRouting: null,
};

describe('an agent profile in a run (issue #143)', () => {
  it('only ever lowers a limit', () => {
    expect(
      profileLimits(profile, {
        budgetMicroUsd: 100_000,
        maxToolIterations: 20,
        runBudgetMs: 600_000,
      }),
    ).toEqual({ budgetMicroUsd: 100_000, maxToolIterations: 20, runBudgetMs: 60_000 });
    expect(
      profileLimits(null, { budgetMicroUsd: 1, maxToolIterations: 2, runBudgetMs: 3 }),
    ).toEqual({ budgetMicroUsd: 1, maxToolIterations: 2, runBudgetMs: 3 });
  });

  it('keeps the domains a run on work cannot do without', () => {
    expect(profileToolDomains(profile, { onWorkItem: true, proposing: true })).toEqual([
      'core',
      'workItems',
      'attention',
      'changesets',
      'web',
    ]);
    expect(profileToolDomains(null, { onWorkItem: true, proposing: false })).toBeNull();
    expect(
      profileToolDomains(
        { ...profile, snapshot: { ...snapshot, toolDomains: null } },
        { onWorkItem: true, proposing: false },
      ),
    ).toBeNull();
  });

  it('tells the model its role and the rule pages it can still find', async () => {
    const prisma = {
      document: {
        findMany: async () => [
          {
            id: 'rule-page-1',
            title: 'Quellen',
            content: { markdown: 'Nur Primärquellen.', plainText: null },
          },
        ],
      },
    } as unknown as PrismaClient;
    const message = await profileMessage({ prisma, profile, workspaceId: 'ws-1' });
    expect(message?.role).toBe('system');
    expect(message?.content).toContain('Rolle „Rechercheur“');
    expect(message?.content).toContain('Belege jede Aussage.');
    expect(message?.content).toContain('## Quellen\n\nNur Primärquellen.');
  });
});
