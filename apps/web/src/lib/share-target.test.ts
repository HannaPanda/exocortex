import { describe, expect, it } from 'vitest';

import { bookmarkletFor, readShare } from './share-target';

describe('readShare', () => {
  it('takes the address the sender named', () => {
    expect(readShare({ url: 'https://example.com/a', title: 'A', text: 'Ein Satz' })).toEqual({
      url: 'https://example.com/a',
      title: 'A',
      text: 'Ein Satz',
    });
  });

  it('reads the address out of the text when the sender put it there', () => {
    expect(readShare({ text: 'Lies das: https://example.com/a' })).toEqual({
      url: 'https://example.com/a',
      title: null,
      text: 'Lies das:',
    });
  });

  it('leaves nothing behind when the text was only the address', () => {
    expect(readShare({ text: 'https://example.com/a' }).text).toBeNull();
  });

  it('keeps plain text as plain text', () => {
    expect(readShare({ text: 'Kaffee kaufen' })).toEqual({
      url: null,
      title: null,
      text: 'Kaffee kaufen',
    });
  });

  it('treats blank fields as absent', () => {
    expect(readShare({ url: '  ', title: '', text: '\n' })).toEqual({
      url: null,
      title: null,
      text: null,
    });
  });
});

describe('bookmarkletFor', () => {
  it('points at the deployment it was copied from', () => {
    const code = bookmarkletFor('https://exocortex.app');
    expect(code.startsWith('javascript:')).toBe(true);
    expect(code).toContain("https://exocortex.app/teilen?url='+encodeURIComponent(location.href)");
  });
});
