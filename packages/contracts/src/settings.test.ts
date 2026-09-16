import { describe, expect, it } from 'vitest';

import {
  resolveSettings,
  SETTING_CEILINGS,
  SETTING_KEYS,
  SETTING_NUMBER_RANGES,
  SETTING_SCOPES,
  SETTING_VALUE_RANKS,
  settingsResponseSchema,
  settingsSchema,
  updateSettingsRequestSchema,
  updateWorkspaceSettingsRequestSchema,
  WORKSPACE_SETTING_KEYS,
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

describe('workspace overrides', () => {
  it('lets a workspace row win over the deployment row', () => {
    const { settings, overriddenKeys } = resolveSettings({
      rows: [{ key: 'ai.systemPrompt', value: 'deployment' }],
      workspaceRows: [{ key: 'ai.systemPrompt', value: 'workspace' }],
    });
    expect(settings['ai.systemPrompt']).toBe('workspace');
    expect(overriddenKeys).toEqual(['ai.systemPrompt']);
  });

  it('inherits every key the workspace did not set', () => {
    const { settings, overriddenKeys } = resolveSettings({
      rows: [{ key: 'ai.systemPrompt', value: 'deployment' }],
      workspaceRows: [{ key: 'ai.toolsEnabled', value: false }],
    });
    expect(settings['ai.systemPrompt']).toBe('deployment');
    expect(overriddenKeys).toEqual(['ai.toolsEnabled']);
  });

  it('behaves exactly as before when no workspace rows are given', () => {
    const without = resolveSettings({ rows: [{ key: 'ai.enabled', value: false }] });
    const empty = resolveSettings({
      rows: [{ key: 'ai.enabled', value: false }],
      workspaceRows: [],
    });
    expect(without.settings).toEqual(empty.settings);
    expect(without.overriddenKeys).toEqual([]);
  });

  it('clamps a ceiling key to the deployment value instead of raising it', () => {
    const { settings, overriddenKeys } = resolveSettings({
      rows: [{ key: 'ai.budgetMicroUsdPerRun', value: 100_000 }],
      workspaceRows: [{ key: 'ai.budgetMicroUsdPerRun', value: 5_000_000 }],
    });
    expect(settings['ai.budgetMicroUsdPerRun']).toBe(100_000);
    // Still reported as set: the workspace has a row, the ceiling just bites.
    expect(overriddenKeys).toEqual(['ai.budgetMicroUsdPerRun']);
  });

  it('refuses to let a workspace switch a capability the deployment switched off back on', () => {
    const { settings, overriddenKeys } = resolveSettings({
      rows: [{ key: 'automations.enabled', value: false }],
      workspaceRows: [{ key: 'automations.enabled', value: true }],
    });
    expect(settings['automations.enabled']).toBe(false);
    expect(overriddenKeys).toEqual(['automations.enabled']);
  });

  it('lets a workspace switch off what the deployment allows', () => {
    const { settings } = resolveSettings({
      rows: [{ key: 'automations.enabled', value: true }],
      workspaceRows: [{ key: 'automations.enabled', value: false }],
    });
    expect(settings['automations.enabled']).toBe(false);
  });

  it('lets a ceiling key go below the deployment value', () => {
    const { settings } = resolveSettings({
      rows: [{ key: 'ai.budgetMicroUsdPerRun', value: 100_000 }],
      workspaceRows: [{ key: 'ai.budgetMicroUsdPerRun', value: 20_000 }],
    });
    expect(settings['ai.budgetMicroUsdPerRun']).toBe(20_000);
  });

  it('follows a lowered ceiling without rewriting the workspace row', () => {
    const stored = [{ key: 'ai.maxRunMs', value: 800_000 }];
    const before = resolveSettings({ rows: [], workspaceRows: stored });
    expect(before.settings['ai.maxRunMs']).toBe(800_000);
    const after = resolveSettings({
      rows: [{ key: 'ai.maxRunMs', value: 120_000 }],
      workspaceRows: stored,
    });
    expect(after.settings['ai.maxRunMs']).toBe(120_000);
  });

  it('clamps an ordered enum to the stricter of the two values', () => {
    const { settings } = resolveSettings({
      rows: [{ key: 'ai.untrustedContentPolicy', value: 'guarded' }],
      workspaceRows: [{ key: 'ai.untrustedContentPolicy', value: 'allow' }],
    });
    expect(settings['ai.untrustedContentPolicy']).toBe('guarded');
  });

  it('lets a workspace be stricter than the deployment about foreign content', () => {
    const { settings } = resolveSettings({
      rows: [{ key: 'ai.untrustedContentPolicy', value: 'allow' }],
      workspaceRows: [{ key: 'ai.untrustedContentPolicy', value: 'deny' }],
    });
    expect(settings['ai.untrustedContentPolicy']).toBe('deny');
  });

  it('ignores a workspace row for a deployment-scoped key', () => {
    const { settings, overriddenKeys, invalidKeys } = resolveSettings({
      rows: [],
      workspaceRows: [{ key: 'search.semanticEnabled', value: true }],
    });
    expect(settings['search.semanticEnabled']).toBe(false);
    expect(overriddenKeys).toEqual([]);
    expect(invalidKeys).toEqual([]);
  });

  it('drops an invalid workspace row and keeps the deployment value', () => {
    const { settings, invalidKeys, overriddenKeys } = resolveSettings({
      rows: [{ key: 'ai.maxOutputTokens', value: 8_192 }],
      workspaceRows: [{ key: 'ai.maxOutputTokens', value: 'not-a-number' }],
    });
    expect(settings['ai.maxOutputTokens']).toBe(8_192);
    expect(invalidKeys).toEqual(['ai.maxOutputTokens']);
    expect(overriddenKeys).toEqual([]);
  });
});

describe('SETTING_SCOPES', () => {
  it('classifies every key exactly once', () => {
    expect(Object.keys(SETTING_SCOPES).sort()).toEqual([...SETTING_KEYS].sort());
  });

  it('never puts a deployment-scoped key on the workspace list', () => {
    for (const key of WORKSPACE_SETTING_KEYS) {
      expect(SETTING_SCOPES[key]).toBe('workspace');
    }
  });

  it('lists every ranked value the schema accepts, in order', () => {
    for (const [key, ranks] of Object.entries(SETTING_VALUE_RANKS)) {
      const shape = settingsSchema.shape[key as SettingKey];
      for (const value of ranks!) expect(shape.safeParse(value).success).toBe(true);
    }
  });

  it('keeps every ceiling key overridable and clampable', () => {
    const defaults = settingsSchema.parse({});
    for (const key of SETTING_CEILINGS) {
      expect(WORKSPACE_SETTING_KEYS).toContain(key);
      // A ceiling only means something on a value that can be held down: a
      // number takes the smaller of the two, a boolean the conjunction, an
      // ordered enum whichever of the two sits nearer the strict end.
      // Anything else would pass through the clamp unchanged and the entry
      // would be a promise the resolver does not keep.
      const clampable =
        SETTING_NUMBER_RANGES[key] !== undefined ||
        typeof defaults[key] === 'boolean' ||
        SETTING_VALUE_RANKS[key] !== undefined;
      expect(clampable).toBe(true);
    }
  });
});

describe('updateWorkspaceSettingsRequestSchema', () => {
  it('keeps absent keys absent', () => {
    const parsed = updateWorkspaceSettingsRequestSchema.parse({ 'ai.toolsEnabled': false });
    expect(Object.keys(parsed)).toEqual(['ai.toolsEnabled']);
  });

  it('refuses a deployment-scoped key', () => {
    const result = updateWorkspaceSettingsRequestSchema.safeParse({ 'mcp.enabled': false });
    // Unknown keys are stripped rather than rejected, which is what keeps a
    // patch forward-compatible -- what matters is that it never reaches the row.
    expect(result.success).toBe(true);
    expect(result.success && Object.hasOwn(result.data, 'mcp.enabled')).toBe(false);
  });

  it('refuses setting and resetting the same key in one request', () => {
    const result = updateWorkspaceSettingsRequestSchema.safeParse({
      'ai.systemPrompt': 'x',
      reset: ['ai.systemPrompt'],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a reset-only request', () => {
    const parsed = updateWorkspaceSettingsRequestSchema.parse({ reset: ['ai.systemPrompt'] });
    expect(parsed.reset).toEqual(['ai.systemPrompt']);
  });
});
