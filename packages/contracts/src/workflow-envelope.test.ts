import { describe, expect, it } from 'vitest';

import { workflowAgentNodeEffect } from './workflow-envelope';
import { type WorkflowEnvelope } from './workflows';

const envelope: WorkflowEnvelope = {
  workflowsEnabled: true,
  writeMode: 'direct',
  limits: {
    maxNodeExecutions: 200,
    maxParallelBranches: 4,
    maxLifetimeSeconds: 86_400,
    budgetMicroUsd: 1_000_000,
  },
};

const profiles = [
  {
    id: 'p-default',
    name: 'Standard',
    isDefault: true,
    writeMode: 'propose' as const,
    budgetMicroUsdPerTask: null,
  },
  {
    id: 'p-tight',
    name: 'Knapp',
    isDefault: false,
    writeMode: 'direct' as const,
    budgetMicroUsdPerTask: 200_000,
  },
];

describe('workflowAgentNodeEffect', () => {
  it('inherits the default profile and its stricter mode when the node names none', () => {
    const effect = workflowAgentNodeEffect({
      node: { agentProfileId: null, writeMode: 'direct', budgetMicroUsd: null },
      envelope,
      profiles,
    });
    expect(effect.profile?.id).toBe('p-default');
    expect(effect.profileInherited).toBe(true);
    expect(effect.writeMode).toBe('propose');
    expect(effect.writeModeNarrowed).toBe(true);
    expect(effect.budgetMicroUsd).toBe(1_000_000);
  });

  it('cuts the budget to the profile and the run, and says so', () => {
    const effect = workflowAgentNodeEffect({
      node: { agentProfileId: 'p-tight', writeMode: null, budgetMicroUsd: 500_000 },
      envelope,
      profiles,
    });
    expect(effect.budgetMicroUsd).toBe(200_000);
    expect(effect.budgetNarrowed).toBe(true);
    expect(effect.writeMode).toBe('direct');
    expect(effect.writeModeNarrowed).toBe(false);
  });

  it('holds a test run to its own ceiling and the workspace to its mode', () => {
    expect(
      workflowAgentNodeEffect({
        node: { agentProfileId: 'p-tight', writeMode: 'direct', budgetMicroUsd: null },
        envelope,
        profiles,
        runWriteMode: 'read_only',
      }).writeMode,
    ).toBe('read_only');
    expect(
      workflowAgentNodeEffect({
        node: { agentProfileId: 'p-tight', writeMode: null, budgetMicroUsd: null },
        envelope: { ...envelope, writeMode: 'propose' },
        profiles,
      }).writeMode,
    ).toBe('propose');
  });

  it('reports no profile for one that is gone rather than guessing the default', () => {
    const effect = workflowAgentNodeEffect({
      node: { agentProfileId: 'p-gone', writeMode: null, budgetMicroUsd: null },
      envelope,
      profiles,
    });
    expect(effect.profile).toBeNull();
    expect(effect.profileInherited).toBe(false);
  });
});
