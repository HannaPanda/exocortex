import { describe, expect, it } from 'vitest';

import { type AiUsage } from '@exocortex/contracts';
import { Prisma } from '@exocortex/database';

import { imageRunData, type ImageRunRecord } from './image-run';

/**
 * The row a drawn picture leaves in `ai_run` (issue #252): the arithmetic and
 * the attribution, without a database.
 */

const startedAt = new Date('2026-11-26T10:00:00.000Z');

function record(overrides: Partial<ImageRunRecord> = {}): ImageRunRecord {
  return {
    workspaceId: 'ws1',
    documentId: 'doc1',
    userId: 'u1',
    prompt: 'Berge',
    provider: 'openrouter',
    model: 'test/image',
    usage: null,
    usedOwnKey: false,
    status: 'COMPLETED',
    errorCode: null,
    diagnosis: null,
    startedAt,
    finishedAt: new Date(startedAt.getTime() + 9_000),
    correlationId: 'c1',
    ...overrides,
  };
}

const usage = (providerCostMicroUsd: number | null): AiUsage => ({
  inputTokens: 1_000_000,
  outputTokens: 2_000_000,
  cachedInputTokens: 0,
  provider: 'openrouter',
  servedBy: null,
  model: 'test/image',
  providerCostMicroUsd,
  durationMs: 9_000,
});

const prices = { inputMicroUsdPerMTok: 300_000, outputMicroUsdPerMTok: 30_000_000 };

describe('imageRunData', () => {
  it('is a row of kind IMAGE in the workspace that asked, paid by the key that paid', () => {
    const data = imageRunData(record({ usedOwnKey: true, usage: usage(38_700) }), prices);

    expect(data).toMatchObject({
      kind: 'IMAGE',
      workspaceId: 'ws1',
      documentId: 'doc1',
      createdById: 'u1',
      provider: 'openrouter',
      model: 'test/image',
      status: 'COMPLETED',
      usedOwnKey: true,
      durationMs: 9_000,
      inputTokens: 1_000_000,
      outputTokens: 2_000_000,
    });
  });

  it('keeps the reported price and estimates nothing beside it', () => {
    const data = imageRunData(record({ usage: usage(38_700) }), prices);
    expect(data.providerCostMicroUsd).toBe(38_700);
    expect(data.estimatedCostMicroUsd).toBeNull();
  });

  it('estimates from the price list when the provider named no price', () => {
    const data = imageRunData(record({ usage: usage(null) }), prices);
    expect(data.providerCostMicroUsd).toBeNull();
    // 1M input at $0.30 plus 2M output at $30 per million.
    expect(data.estimatedCostMicroUsd).toBe(60_300_000);
  });

  it('invents no price for a model the registry does not hold', () => {
    const data = imageRunData(record({ usage: usage(null) }), {
      inputMicroUsdPerMTok: null,
      outputMicroUsdPerMTok: null,
    });
    expect(data.estimatedCostMicroUsd).toBeNull();
  });

  it('carries a refused key as the diagnosis every reader renders', () => {
    const data = imageRunData(
      record({
        status: 'FAILED',
        errorCode: 'ai_image_unavailable',
        usedOwnKey: true,
        diagnosis: {
          key: 'keyRefused',
          args: { reason: 'invalid', provider: 'openrouter', model: 'test/image', ownKey: true },
        },
      }),
      prices,
    );

    expect(data.errorDetailKey).toBe('keyRefused');
    expect(data.errorDetailArgs).toEqual({
      reason: 'invalid',
      provider: 'openrouter',
      model: 'test/image',
      ownKey: true,
    });
    expect(data.errorDetail).toContain('Arbeitsbereich');
    expect(data.usage).toBe(Prisma.JsonNull);
  });
});
