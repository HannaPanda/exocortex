import { describe, expect, it } from 'vitest';

import {
  mergeCheckpointState,
  parseCheckpointRefs,
  parseCheckpointState,
} from './work-checkpoints';

describe('mergeCheckpointState', () => {
  const previous = {
    summary: 'Zwei von drei Quellen gelesen.',
    state: {
      plan: [
        { text: 'Quellen lesen', status: 'in_progress' as const },
        { text: 'Zusammenfassen', status: 'open' as const },
      ],
      assumptions: ['Die Zahlen von 2025 gelten noch.'],
      findings: ['Quelle A widerspricht B.'],
      lastAction: 'exo_page_read',
      nextStep: 'Quelle C lesen',
    },
  };

  it('starts from an empty state when nothing was recorded', () => {
    expect(mergeCheckpointState(null, { summary: 'Los geht es.' })).toEqual({
      summary: 'Los geht es.',
      state: { plan: [], assumptions: [], findings: [], lastAction: null, nextStep: null },
    });
  });

  it('carries forward every field the caller left out', () => {
    const merged = mergeCheckpointState(previous, {
      plan: [{ text: 'Quellen lesen', status: 'done' }],
    });
    expect(merged.summary).toBe(previous.summary);
    expect(merged.state.plan).toEqual([{ text: 'Quellen lesen', status: 'done' }]);
    expect(merged.state.assumptions).toEqual(previous.state.assumptions);
    expect(merged.state.lastAction).toBe('exo_page_read');
  });

  it('clears a list with an empty one and a line with null', () => {
    const merged = mergeCheckpointState(previous, { findings: [], nextStep: null });
    expect(merged.state.findings).toEqual([]);
    expect(merged.state.nextStep).toBeNull();
    expect(merged.state.assumptions).toHaveLength(1);
  });
});

describe('reading stored checkpoints', () => {
  it('reads a malformed state as an empty one rather than failing', () => {
    expect(parseCheckpointState({ plan: 'kaputt' })).toEqual({
      plan: [],
      assumptions: [],
      findings: [],
      lastAction: null,
      nextStep: null,
    });
    expect(parseCheckpointState(null)).toEqual(parseCheckpointState({}));
  });

  it('drops refs that do not parse', () => {
    expect(parseCheckpointRefs([{ documentId: 'x' }])).toEqual([]);
    expect(
      parseCheckpointRefs([{ documentId: 'doc-12345678', role: 'artifact', revision: null }]),
    ).toHaveLength(1);
  });
});
