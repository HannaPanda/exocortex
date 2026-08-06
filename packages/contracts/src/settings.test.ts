import { describe, expect, it } from 'vitest';

import { resolveSettings, settingsSchema, updateSettingsRequestSchema } from './settings';

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
    expect(updateSettingsRequestSchema.safeParse({ 'ai.maxToolIterations': 99 }).success).toBe(
      false,
    );
    expect(updateSettingsRequestSchema.safeParse({ 'ai.enabled': 'yes' }).success).toBe(false);
  });

  it('parses an empty patch to an empty object', () => {
    expect(updateSettingsRequestSchema.parse({})).toEqual({});
  });
});
