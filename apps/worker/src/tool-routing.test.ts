import { describe, expect, it, vi } from 'vitest';

import { AiProviderError, type DecisionProvider, type DecisionResult } from '@exocortex/ai';
import { createLogger } from '@exocortex/logger';

import { routeToolDomains, type ToolRoutingInput } from './tool-routing';

const logger = createLogger({ name: 'tool-routing-test', level: 'silent' });

function answering(probabilities: Record<string, number>): DecisionProvider {
  return {
    id: 'test',
    decide: vi.fn(async (): Promise<DecisionResult> => ({
      answers: Object.fromEntries(
        Object.entries(probabilities).map(([key, probability]) => [
          key,
          { kind: 'yesNo' as const, probability },
        ]),
      ),
      model: 'typesafe/jev-1.13-20261001',
      provider: 'typesafe',
      latencyMs: 240,
      inputTokens: 900,
      costMicroUsd: 48,
    })),
  };
}

function failing(error: unknown): DecisionProvider {
  return {
    id: 'test',
    decide: vi.fn(async () => {
      throw error;
    }),
  };
}

function route(overrides: Partial<ToolRoutingInput>) {
  return routeToolDomains({
    enabled: true,
    text: 'die leeren Sachen kannst du erstmal entfernen',
    required: [],
    carried: [],
    signals: [],
    decisions: answering({}),
    correlationId: 'corr-1',
    logger,
    ...overrides,
  });
}

/**
 * Who chooses a run's first tool offer (issue #206, ADR-089). The property
 * under test: Jev decides when it can, and every way it cannot ends in the
 * keyword selection and a run that starts, with the reason on record.
 */
describe('routeToolDomains', () => {
  it('offers what Jev says yes to, plus the domains every run has', async () => {
    const outcome = await route({
      text: 'この図に何が描かれていますか',
      decisions: answering({ attachments: 0.93, lifecycle: 0.02, web: 0.49 }),
    });

    expect(outcome.domains).toEqual(['core', 'pages', 'attachments']);
    expect(outcome.event).toMatchObject({
      decider: 'jev',
      fallbackReason: null,
      model: 'typesafe/jev-1.13-20261001',
      costMicroUsd: 48,
    });
  });

  it('is the keyword selection exactly when switched off, and asks nobody', async () => {
    const decisions = answering({ attachments: 0.99 });
    const outcome = await route({ enabled: false, decisions });

    expect(decisions.decide).not.toHaveBeenCalled();
    expect(outcome.event.decider).toBe('keywords');
    expect(outcome.domains).toContain('lifecycle');
  });

  it('keeps what the caller knows and what the page carries, whatever Jev says', async () => {
    const outcome = await route({
      text: 'Was zeigt diese Skizze?',
      required: ['databases', 'lifecycle'],
      carried: ['lifecycle'],
      signals: ['page_images'],
      decisions: answering({ attachments: 0.1 }),
    });

    expect(outcome.domains).toEqual(['core', 'pages', 'lifecycle', 'databases', 'attachments']);
    expect(outcome.event.carried).toEqual(['lifecycle']);
    expect(outcome.event.signals).toEqual(['page_images']);
  });

  it('tells Jev what the page carries', async () => {
    const decisions = answering({ attachments: 0.9 });
    await route({ decisions, signals: ['page_images', 'page_pdfs'] });

    expect(decisions.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({ context: { pageCarries: ['pictures', 'PDF files'] } }),
      }),
    );
  });

  it.each([
    ['unavailable', null],
    ['timeout', failing(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))],
    [
      'error',
      failing(new AiProviderError('ai_decision_unavailable', 'OpenRouter responded with 502')),
    ],
    [
      'invalid',
      failing(new AiProviderError('ai_decision_invalid', 'No answer came back for "web".')),
    ],
    ['empty', answering({})],
  ] as const)(
    'falls back to the keywords when Jev is %s, and the run starts',
    async (reason, decisions) => {
      const outcome = await route({ decisions });

      expect(outcome.event).toMatchObject({ decider: 'fallback', fallbackReason: reason });
      // The keywords know "entfern" since 2026-10-23.
      expect(outcome.domains).toContain('lifecycle');
    },
  );

  it('gives up waiting at the timeout rather than holding the run', async () => {
    const slow: DecisionProvider = {
      id: 'slow',
      decide: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason as Error));
        }),
    };
    const started = Date.now();
    const outcome = await route({ decisions: slow, timeoutMs: 50 });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(outcome.event.fallbackReason).toBe('timeout');
  });

  it('does not ask about a run that has no words of its own', async () => {
    const decisions = answering({ web: 1 });
    const outcome = await route({ text: '   ', decisions });

    expect(decisions.decide).not.toHaveBeenCalled();
    expect(outcome.event.decider).toBe('keywords');
  });
});
