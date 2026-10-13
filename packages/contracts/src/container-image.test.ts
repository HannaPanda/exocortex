import { describe, expect, it } from 'vitest';

import {
  CONTAINER_IMAGE_SETTING_KEYS,
  isContainerImageReference,
  isContainerImageSettingKey,
} from './container-image';
import { resolveSettings, settingsSchema, updateSettingsRequestSchema } from './settings';

describe('isContainerImageReference', () => {
  it.each([
    'pandoc/extra:latest',
    'exocortex-render:latest',
    'texlive/texlive:latest-full',
    'ghcr.io/owner/image:1.2.3',
    'localhost:5000/render',
    `pandoc/extra@sha256:${'a'.repeat(64)}`,
  ])('accepts %s', (value) => {
    expect(isContainerImageReference(value)).toBe(true);
  });

  it.each([
    ['an option', '--privileged'],
    ['a leading dash', '-image'],
    ['whitespace', 'pandoc/extra latest'],
    ['a trailing newline', 'pandoc/extra:latest\n'],
    ['a shell character', 'image;rm'],
    ['nothing', ''],
    ['too much', `a${'b'.repeat(300)}`],
  ])('refuses %s', (_reason, value) => {
    expect(isContainerImageReference(value)).toBe(false);
  });
});

describe('the image settings', () => {
  it('are the two the build processors read', () => {
    expect(CONTAINER_IMAGE_SETTING_KEYS).toEqual(['render.image', 'projects.image']);
    expect(isContainerImageSettingKey('render.image')).toBe(true);
    expect(isContainerImageSettingKey('render.timeoutSeconds')).toBe(false);
  });

  it('default to an image the pattern accepts', () => {
    const defaults = settingsSchema.parse({});
    for (const key of CONTAINER_IMAGE_SETTING_KEYS) {
      expect(isContainerImageReference(defaults[key])).toBe(true);
    }
  });

  it('round-trip a custom image through a save and a resolve', () => {
    const patch = updateSettingsRequestSchema.parse({
      'projects.image': 'exocortex-render:latest',
    });
    const { settings, invalidKeys } = resolveSettings({
      rows: [{ key: 'projects.image', value: patch['projects.image'] }],
    });
    expect(settings['projects.image']).toBe('exocortex-render:latest');
    expect(invalidKeys).toEqual([]);
  });

  it('refuse a value the sandbox would refuse on every build', () => {
    expect(updateSettingsRequestSchema.safeParse({ 'render.image': '--privileged' }).success).toBe(
      false,
    );
  });

  it('fall back to the default for a stored row the pattern refuses', () => {
    const { settings, invalidKeys } = resolveSettings({
      rows: [{ key: 'render.image', value: 'two words' }],
    });
    expect(settings['render.image']).toBe(settingsSchema.parse({})['render.image']);
    expect(invalidKeys).toEqual(['render.image']);
  });
});
