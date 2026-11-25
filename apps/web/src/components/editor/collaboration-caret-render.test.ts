import { describe, expect, it } from 'vitest';

import { caretColor } from './collaboration-caret-render';

describe('caretColor', () => {
  it('keeps a presence token, which the library turned into transparent', () => {
    expect(caretColor('var(--presence-4)')).toBe('var(--presence-4)');
  });

  it('refuses anything else another browser might send over awareness', () => {
    expect(caretColor('red; background-image: url(x)')).toBe('var(--presence-2)');
    expect(caretColor('#ff0000')).toBe('var(--presence-2)');
    expect(caretColor(undefined)).toBe('var(--presence-2)');
  });
});
