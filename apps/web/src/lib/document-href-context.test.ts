import { describe, expect, it } from 'vitest';

import { sharedViewPath } from './document-href-context';

describe('sharedViewPath', () => {
  it('reads a workspace page address as the shared view of that page', () => {
    expect(sharedViewPath('/arbeitsbereich/ws1/seite/doc1')).toBe('/geteilt/doc1');
  });

  it('keeps a section fragment and a query', () => {
    expect(sharedViewPath('/arbeitsbereich/ws1/seite/doc1#block-7')).toBe('/geteilt/doc1#block-7');
    expect(sharedViewPath('/arbeitsbereich/ws1/seite/doc1?x=1')).toBe('/geteilt/doc1?x=1');
  });

  it('leaves every other address alone', () => {
    expect(sharedViewPath('/arbeitsbereich/ws1')).toBe('/arbeitsbereich/ws1');
    expect(sharedViewPath('/arbeitsbereich/ws1/projekt/p1')).toBe('/arbeitsbereich/ws1/projekt/p1');
    expect(sharedViewPath('/arbeitsbereich/ws1/seite/doc1/mehr')).toBe(
      '/arbeitsbereich/ws1/seite/doc1/mehr',
    );
    expect(sharedViewPath('/geteilt/doc1')).toBe('/geteilt/doc1');
  });
});
