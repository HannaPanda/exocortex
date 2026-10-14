import { describe, expect, it, vi } from 'vitest';

import { type VisionPreprocessor } from '@exocortex/ai';
import { type Settings } from '@exocortex/contracts';

import { type ResolvedModelRow } from './contract';
import { resolveToolImageDescriber } from './preparation';

function modelRow(overrides: Partial<ResolvedModelRow>): ResolvedModelRow {
  return {
    slug: 'vendor/text-model',
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
