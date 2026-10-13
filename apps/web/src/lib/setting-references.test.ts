import { describe, expect, it } from 'vitest';

import {
  type AiModel,
  type AiModelCatalogEntry,
  type DatabaseProperty,
  EMBEDDING_MODELS_FITTING_COLUMN,
} from '@exocortex/contracts';

import {
  embeddingOptions,
  matchesReferenceQuery,
  missingEntityColumns,
  modelFieldHasList,
  modelFieldOf,
  registryOptions,
  withStoredValue,
} from './setting-references';

/**
 * The settings that name a model or the entity database (issue #171): which
 * list each one picks from, and that a stored value nobody offers any more is
 * shown as what it is instead of being swapped for something else.
 */

function model(slug: string, enabled = true): AiModel {
  return {
    id: `id-${slug}`,
    slug,
    provider: 'openrouter',
    displayName: slug.toUpperCase(),
    description: null,
    contextWindowTokens: 1000,
    maxOutputTokens: null,
    supportsVision: false,
    supportsTools: true,
    reasoningLevels: ['none'],
    inputMicroUsdPerMTok: 0,
    outputMicroUsdPerMTok: 0,
    visionCompanionSlug: null,
    aliasTargetSlug: null,
    providerRouting: null,
    enabled,
    sortOrder: 0,
    syncedAt: null,
  };
}

function entry(slug: string): AiModelCatalogEntry {
  return {
    slug,
    displayName: `Name of ${slug}`,
    description: null,
    aliasTargetSlug: null,
    contextWindowTokens: 8192,
    maxOutputTokens: null,
    supportsVision: false,
    supportsTools: false,
    reasoningLevels: ['none'],
    inputMicroUsdPerMTok: 0,
    outputMicroUsdPerMTok: 0,
    registered: false,
  };
}

function property(name: string, type: DatabaseProperty['type']): DatabaseProperty {
  return {
    id: `p-${name}`,
    documentId: 'db',
    type,
    name,
    orderKey: 'a',
    config: null,
    options: [],
    createdAt: '2026-10-13T00:00:00.000Z',
    updatedAt: '2026-10-13T00:00:00.000Z',
  };
}

describe('modelFieldOf', () => {
  it('lists the overview model, which has no ModelSlug suffix to be found by', () => {
    expect(modelFieldOf('overview.modelSlug')).toEqual({
      source: 'registry',
      empty: 'defaultModel',
    });
  });

  it('gives the vector model no empty value and the image model "off"', () => {
    expect(modelFieldOf('search.embeddingModelSlug')).toEqual({ source: 'embeddings' });
    expect(modelFieldOf('ai.imageModelSlug')).toEqual({ source: 'image', empty: 'off' });
  });

  it('leaves every other setting alone', () => {
    expect(modelFieldOf('entities.databaseId')).toBeUndefined();
    expect(modelFieldOf('ai.writeMode')).toBeUndefined();
  });
});

describe('modelFieldHasList', () => {
  const image = { source: 'image', empty: 'off' } as const;

  it('keeps the image model a text field where the catalogue cannot be read', () => {
    expect(modelFieldHasList(image, undefined)).toBe(false);
    expect(
      modelFieldHasList(image, { image: { entries: [], loading: false, unavailable: true } }),
    ).toBe(false);
    expect(
      modelFieldHasList(image, { image: { entries: [], loading: true, unavailable: false } }),
    ).toBe(true);
  });

  it('always has a list for the registry and the vector model', () => {
    expect(modelFieldHasList({ source: 'registry', empty: 'chat' }, undefined)).toBe(true);
    expect(modelFieldHasList({ source: 'embeddings' }, undefined)).toBe(true);
  });
});

describe('registryOptions', () => {
  it('offers enabled models, and a disabled one only while it is stored', () => {
    const models = [model('a/one'), model('b/two', false)];
    expect(registryOptions(models, null, 'off').map((option) => option.value)).toEqual(['a/one']);
    const stored = registryOptions(models, 'b/two', 'off');
    expect(stored.map((option) => option.value)).toEqual(['a/one', 'b/two']);
    expect(stored[1]?.detail).toBe('b/two · off');
  });
});

describe('embeddingOptions', () => {
  it('offers only the measured models, named by the catalogue', () => {
    const options = embeddingOptions([
      entry('openai/text-embedding-3-small'),
      entry('openai/text-embedding-ada-002'),
      entry('baai/bge-m3'),
    ]);
    expect(options).toEqual([
      {
        value: 'openai/text-embedding-3-small',
        label: 'Name of openai/text-embedding-3-small',
        detail: 'openai/text-embedding-3-small',
      },
    ]);
  });

  it('falls back to the measured slugs when the catalogue has not answered', () => {
    expect(embeddingOptions([]).map((option) => option.value)).toEqual([
      ...EMBEDDING_MODELS_FITTING_COLUMN,
    ]);
  });

  it('holds the default model, or a fresh deployment starts on a value it cannot pick', () => {
    expect(EMBEDDING_MODELS_FITTING_COLUMN).toContain('openai/text-embedding-3-small');
  });
});

describe('withStoredValue', () => {
  const options = [{ value: 'a/one', label: 'One', detail: 'a/one' }];

  it('adds a stored value nobody offers as its own row and says so', () => {
    const listed = withStoredValue(options, 'gone/model', 'not listed');
    expect(listed.missing).toBe(true);
    expect(listed.options.at(-1)).toEqual({
      value: 'gone/model',
      label: 'gone/model',
      detail: 'not listed',
    });
  });

  it('adds nothing for an offered value or the empty one', () => {
    expect(withStoredValue(options, 'a/one', 'x')).toEqual({ options, missing: false });
    expect(withStoredValue(options, null, 'x')).toEqual({ options, missing: false });
  });
});

describe('matchesReferenceQuery', () => {
  const option = { value: 'qwen/qwen3-embedding-8b', label: 'Qwen3 Embedding 8B', detail: 'x' };

  it('matches every word anywhere, case-insensitive', () => {
    expect(matchesReferenceQuery(option, 'qwen 8b')).toBe(true);
    expect(matchesReferenceQuery(option, 'EMBEDDING')).toBe(true);
    expect(matchesReferenceQuery(option, 'qwen 4b')).toBe(false);
  });

  it('matches the second line too, where a workspace or a slug stands', () => {
    expect(
      matchesReferenceQuery(
        { value: 'id', label: 'Entitäten', detail: 'Second Brain · id' },
        'brain',
      ),
    ).toBe(true);
  });
});

describe('missingEntityColumns', () => {
  it('names the columns the matcher reads that a database lacks', () => {
    expect(missingEntityColumns([])).toEqual(['Typ', 'Aliasse']);
    expect(missingEntityColumns([property('Typ', 'SELECT'), property('Aliasse', 'TEXT')])).toEqual(
      [],
    );
  });

  it('counts a column of the wrong type as missing', () => {
    expect(missingEntityColumns([property('Typ', 'TEXT'), property('Aliasse', 'TEXT')])).toEqual([
      'Typ',
    ]);
  });
});
