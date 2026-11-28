import { describe, expect, it, vi } from 'vitest';

import { type VisionPreprocessor } from '@exocortex/ai';
import { type Settings } from '@exocortex/contracts';

import { type ResolvedModelRow } from './contract';
import { resolveImageDescriber, resolveToolImageDescriber } from './preparation';

function modelRow(overrides: Partial<ResolvedModelRow>): ResolvedModelRow {
  return {
    slug: 'vendor/text-model',
    provider: 'openrouter',
    supportsVision: false,
    visionCompanionSlug: null,
    ...overrides,
  } as ResolvedModelRow;
}

function settings(visionEnabled: boolean): Settings {
  return { 'ai.visionEnabled': visionEnabled } as Settings;
}

const preprocessor = {
  describeImage: vi.fn().mockResolvedValue('beschrieben'),
} as unknown as VisionPreprocessor;

describe('resolveToolImageDescriber (issue #204)', () => {
  it('lets a model that sees images describe the picture itself', async () => {
    const visionPreprocessorFor = vi.fn().mockReturnValue(preprocessor);
    const describe = resolveToolImageDescriber({
      settings: settings(true),
      modelRow: modelRow({ slug: 'vendor/vision-model', supportsVision: true }),
      conversationCompanionSlug: null,
      visionPreprocessorFor,
      correlationId: 'c1',
    });

    expect(visionPreprocessorFor).toHaveBeenCalledWith('vendor/vision-model');
    expect(await describe?.({ mimeType: 'image/png', data: 'AAAA' }, 'diff.png')).toBe(
      'beschrieben',
    );
  });

  it('borrows the companion for a text-only model, as the conversation chose it', () => {
    const visionPreprocessorFor = vi.fn().mockReturnValue(preprocessor);
    resolveToolImageDescriber({
      settings: settings(true),
      modelRow: modelRow({ visionCompanionSlug: 'vendor/admin-companion' }),
      conversationCompanionSlug: 'vendor/chosen-companion',
      visionPreprocessorFor,
      correlationId: 'c1',
    });
    expect(visionPreprocessorFor).toHaveBeenCalledWith('vendor/chosen-companion');
  });

  it('borrows the companion for a subscription model, whose slug OpenRouter does not know', () => {
    const visionPreprocessorFor = vi.fn().mockReturnValue(preprocessor);
    resolveToolImageDescriber({
      settings: settings(true),
      modelRow: modelRow({
        slug: 'cline-pass/vision-model',
        provider: 'cline',
        supportsVision: true,
      }),
      conversationCompanionSlug: null,
      visionPreprocessorFor,
      correlationId: 'c1',
    });
    // null: the deployment's default companion.
    expect(visionPreprocessorFor).toHaveBeenCalledWith(null);
  });

  it('answers null when vision is off or the conversation switched the companion off', () => {
    const visionPreprocessorFor = vi.fn().mockReturnValue(preprocessor);
    expect(
      resolveToolImageDescriber({
        settings: settings(false),
        modelRow: modelRow({ supportsVision: true }),
        conversationCompanionSlug: null,
        visionPreprocessorFor,
        correlationId: 'c1',
      }),
    ).toBeNull();
    expect(
      resolveToolImageDescriber({
        settings: settings(true),
        modelRow: modelRow({}),
        conversationCompanionSlug: 'off',
        visionPreprocessorFor,
        correlationId: 'c1',
      }),
    ).toBeNull();
    expect(visionPreprocessorFor).not.toHaveBeenCalled();
  });
});

/**
 * Issue #207: the open page's pictures and a chat picture are described by
 * this same choice, and the stored description keeps the name of whoever
 * wrote it. A subscription preset's slug never reaches the OpenRouter-based
 * describer, however the model is marked.
 */
describe('resolveImageDescriber, for the page and the chat (issue #207)', () => {
  const choose = (row: Partial<ResolvedModelRow>, companion: string | null = null) =>
    resolveImageDescriber({
      settings: settings(true),
      modelRow: modelRow(row),
      conversationCompanionSlug: companion,
      visionPreprocessorFor: () => preprocessor,
      correlationId: 'c1',
    });

  it('names the model that sees as the describer', () => {
    expect(choose({ slug: 'vendor/vision-model', supportsVision: true })?.model).toBe(
      'vendor/vision-model',
    );
  });

  it("names a text-only model's companion, and the conversation's choice over the row's", () => {
    expect(choose({ visionCompanionSlug: 'vendor/admin-companion' })?.model).toBe(
      'vendor/admin-companion',
    );
    expect(
      choose({ visionCompanionSlug: 'vendor/admin-companion' }, 'vendor/chosen-companion')?.model,
    ).toBe('vendor/chosen-companion');
  });

  it('never names a preset slug: a subscription model that sees borrows the default companion', () => {
    const chosen = choose({
      slug: 'cline-pass/vision-model',
      provider: 'cline',
      supportsVision: true,
    });
    expect(chosen).not.toBeNull();
    expect(chosen?.model).toBeNull();
  });

  it('answers null for a conversation that switched the companion off', () => {
    expect(
      choose({ slug: 'cline-pass/m', provider: 'cline', supportsVision: true }, 'off'),
    ).toBeNull();
  });
});
