import { describe, expect, it } from 'vitest';

import {
  resolveSettings,
  SETTING_KEYS,
  SETTING_NUMBER_RANGES,
  settingsResponseSchema,
  settingsSchema,
  updateSettingsRequestSchema,
} from './settings';

describe('resolveSettings', () => {
  it('returns the full default configuration for empty input', () => {
    const { settings, invalidKeys } = resolveSettings({ rows: [] });
    expect(settings).toEqual(settingsSchema.parse({}));
    expect(invalidKeys).toEqual([]);
  });

  it('lets an environment value win over the default', () => {
    const { settings, invalidKeys } = resolveSettings({
      rows: [],
      env: { OPENROUTER_DEFAULT_MODEL: 'z-ai/glm-5.2' },
    });
    expect(settings['ai.defaultModelSlug']).toBe('z-ai/glm-5.2');
    expect(invalidKeys).toEqual([]);
  });

  it('lets a database row win over the environment', () => {
    const { settings, invalidKeys } = resolveSettings({
      rows: [{ key: 'ai.defaultModelSlug', value: 'anthropic/claude-sonnet-5' }],
      env: { OPENROUTER_DEFAULT_MODEL: 'z-ai/glm-5.2' },
    });
    expect(settings['ai.defaultModelSlug']).toBe('anthropic/claude-sonnet-5');
    expect(invalidKeys).toEqual([]);
  });

  it('drops an invalid row and reports its key instead of throwing', () => {
    const { settings, invalidKeys } = resolveSettings({
      rows: [
        { key: 'ai.maxOutputTokens', value: 'not-a-number' },
        { key: 'ai.enabled', value: false },
      ],
    });
    expect(invalidKeys).toEqual(['ai.maxOutputTokens']);
    expect(settings['ai.maxOutputTokens']).toBe(settingsSchema.parse({})['ai.maxOutputTokens']);
    expect(settings['ai.enabled']).toBe(false);
  });

  it('ignores rows for unknown keys', () => {
    const { settings, invalidKeys } = resolveSettings({
      rows: [{ key: 'not.a.real.setting', value: 'whatever' }],
    });
    expect(settings).toEqual(settingsSchema.parse({}));
    expect(invalidKeys).toEqual([]);
  });

  it('defaults ai.maxRunMs to 900000ms and rejects a value below its floor', () => {
    expect(settingsSchema.parse({})['ai.maxRunMs']).toBe(900_000);
    const { settings, invalidKeys } = resolveSettings({
      rows: [{ key: 'ai.maxRunMs', value: 30_000 }],
    });
    expect(invalidKeys).toEqual(['ai.maxRunMs']);
    expect(settings['ai.maxRunMs']).toBe(900_000);
  });
});

describe('updateSettingsRequestSchema', () => {
  it('returns only the keys the caller sent, without filling in defaults', () => {
    const parsed = updateSettingsRequestSchema.parse({ 'ai.maxToolIterations': 6 });

    // The whole point: a patch that materialized every default would write
    // twenty `setting` rows and shadow the environment fallback for good.
    expect(Object.keys(parsed)).toEqual(['ai.maxToolIterations']);
    expect(parsed['ai.maxToolIterations']).toBe(6);
    expect(parsed['ai.defaultModelSlug']).toBeUndefined();
  });

  it('accepts an explicit null for a nullable setting', () => {
    const parsed = updateSettingsRequestSchema.parse({ 'ai.defaultModelSlug': null });

    expect(Object.keys(parsed)).toEqual(['ai.defaultModelSlug']);
    expect(parsed['ai.defaultModelSlug']).toBeNull();
  });

  it('still validates the values that are present', () => {
    expect(updateSettingsRequestSchema.safeParse({ 'ai.maxToolIterations': 1_001 }).success).toBe(
      false,
    );
    expect(updateSettingsRequestSchema.safeParse({ 'ai.enabled': 'yes' }).success).toBe(false);
  });

  it('parses an empty patch to an empty object', () => {
    expect(updateSettingsRequestSchema.parse({})).toEqual({});
  });
});

describe('SETTING_NUMBER_RANGES', () => {
  it('covers every numeric setting and nothing else', () => {
    const numericKeys = SETTING_KEYS.filter(
      (key) => typeof settingsSchema.parse({})[key] === 'number',
    );

    expect(Object.keys(SETTING_NUMBER_RANGES).sort()).toEqual([...numericKeys].sort());
  });

  it('reports the bounds the schema actually enforces', () => {
    for (const [key, range] of Object.entries(SETTING_NUMBER_RANGES)) {
      const field = settingsSchema.shape[key as keyof typeof settingsSchema.shape].unwrap();

      expect(field.safeParse(range.min).success).toBe(true);
      expect(field.safeParse(range.max).success).toBe(true);
      expect(field.safeParse(range.min - 1).success).toBe(false);
      expect(field.safeParse(range.max + 1).success).toBe(false);
    }
  });
});

describe('settingsResponseSchema', () => {
  it('carries the ignored rows alongside the settings', () => {
    const parsed = settingsResponseSchema.parse({
      settings: settingsSchema.parse({}),
      invalidKeys: ['ai.maxToolIterations'],
    });

    expect(parsed.invalidKeys).toEqual(['ai.maxToolIterations']);
  });

  it('demands the list, so a producer cannot quietly stop reporting', () => {
    expect(settingsResponseSchema.safeParse({ settings: settingsSchema.parse({}) }).success).toBe(
      false,
    );
  });

  it('accepts setting keys only', () => {
    expect(
      settingsResponseSchema.safeParse({
        settings: settingsSchema.parse({}),
        invalidKeys: ['not.a.real.setting'],
      }).success,
    ).toBe(false);
  });
});
