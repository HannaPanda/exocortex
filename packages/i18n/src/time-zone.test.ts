import { describe, expect, it } from 'vitest';

import { validTimeZone } from './time-zone.js';

describe('validTimeZone', () => {
  it('keeps a zone the runtime knows', () => {
    expect(validTimeZone('Europe/Berlin')).toBe('Europe/Berlin');
    expect(validTimeZone('America/Sao_Paulo')).toBe('America/Sao_Paulo');
  });

  it('refuses what a cookie can carry but is no zone', () => {
    expect(validTimeZone('Mars/Olympus')).toBeNull();
    expect(validTimeZone('')).toBeNull();
    expect(validTimeZone(null)).toBeNull();
    expect(validTimeZone(undefined)).toBeNull();
    expect(validTimeZone('x'.repeat(100))).toBeNull();
  });
});
