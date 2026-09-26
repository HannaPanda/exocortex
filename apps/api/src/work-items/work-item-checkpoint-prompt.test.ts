import { describe, expect, it } from 'vitest';

import { type WorkCheckpoint } from '@exocortex/contracts';

import { buildCheckpointSection } from './work-item-checkpoint-prompt';

const base: WorkCheckpoint = {
  id: 'checkpoint-1',
  workItemId: 'work-item-1',
  runId: null,
  trigger: 'run_interrupted',
  author: { kind: 'assistant', userId: 'user-1', name: null },
  agentLabel: null,
  system: true,
  summary: 'Gliederung steht.',
  plan: [
    { text: 'Gliederung', status: 'done' },
    { text: 'Kapitel 2', status: 'open' },
  ],
  assumptions: [],
  findings: ['Quelle A ist veraltet.'],
  lastAction: 'exo_page_write · 2026-09-26 10:00 UTC',
  nextStep: 'Kapitel 2 schreiben',
  refs: [
    {
      documentId: 'page-1',
      role: 'artifact',
      revision: null,
      title: 'Entwurf',
      changedSince: true,
    },
    { documentId: 'page-2', role: 'source', revision: null, title: null, changedSince: false },
  ],
  pendingDecisions: [],
  interruptionCode: 'ai_provider_unavailable',
  spentMicroUsd: 0,
  budgetMicroUsd: null,
  provider: 'openrouter',
  model: 'vendor/first-model',
  createdAt: '2026-09-26T10:05:00.000Z',
};

describe('buildCheckpointSection', () => {
  it('hands the whole state over, marks moved pages and names the interruption', () => {
    const text = buildCheckpointSection({
      checkpoint: base,
      answersSince: [],
      stillOpen: [],
      spentMicroUsd: 500,
      budgetMicroUsd: 1_000,
    });
    expect(text).toContain('Checkpoint checkpoint-1');
    expect(text).toContain('damals mit vendor/first-model');
    expect(text).toContain('- [x] Gliederung');
    expect(text).toContain('- [ ] Kapitel 2');
    expect(text).toContain('Quelle A ist veraltet.');
    expect(text).toContain('Entwurf (id: page-1): seit dem Checkpoint geändert, neu lesen');
    expect(text).toContain('(id: page-2): nicht mehr vorhanden');
    expect(text).toContain('ai_provider_unavailable');
    expect(text).toContain('500 von 1000 Mikro-USD');
  });

  it('spells out decisions made since and what is still open', () => {
    const text = buildCheckpointSection({
      checkpoint: { ...base, trigger: 'waiting_for_human', interruptionCode: null },
      answersSince: [
        {
          attentionItemId: 'attention-1',
          kind: 'decision',
          title: 'Welche Variante?',
          status: 'resolved',
          optionId: 'b',
          optionLabel: 'Variante B',
          note: null,
          obsoleteReason: null,
          answeredBy: 'Johanna',
          action: null,
          subject: null,
          subjectTitles: new Map(),
        },
      ],
      stillOpen: [{ attentionItemId: 'attention-2', title: 'Freigabe?', kind: 'approval' }],
      spentMicroUsd: 0,
      budgetMicroUsd: null,
    });
    expect(text).toContain('Entscheidungen seit dem Checkpoint');
    expect(text).toContain('Gewählt: Variante B (b)');
    expect(text).toContain('Beantwortet von Johanna.');
    expect(text).toContain('Freigabe? (approval, id: attention-2)');
    expect(text).not.toContain('endete, ohne fertig zu werden');
    expect(text).not.toContain('Budget');
  });
});
