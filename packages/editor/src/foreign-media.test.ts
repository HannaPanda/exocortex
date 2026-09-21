import { describe, expect, it } from 'vitest';

import { collectForeignMediaSources, isForeignMediaSource } from './foreign-media';
import { parseMarkdown } from './markdown';

const ORIGIN = 'https://exocortex.app';

describe('isForeignMediaSource', () => {
  it('accepts the address an attachment actually has', () => {
    expect(isForeignMediaSource('/api/attachments/abc/download', ORIGIN)).toBe(false);
  });

  it('accepts data and blob addresses, which the policy allows', () => {
    expect(isForeignMediaSource('data:image/png;base64,AAAA', ORIGIN)).toBe(false);
    expect(isForeignMediaSource('blob:https://exocortex.app/1234', ORIGIN)).toBe(false);
  });

  it('accepts an absolute address to this deployment', () => {
    expect(isForeignMediaSource('https://exocortex.app/api/attachments/a/download', ORIGIN)).toBe(
      false,
    );
  });

  it('rejects somebody else’s host, however alive it is', () => {
    expect(isForeignMediaSource('https://haushalt.example.de/schild.jpg', ORIGIN)).toBe(true);
  });
});

describe('collectForeignMediaSources', () => {
  it('finds the image an agent linked instead of uploading', () => {
    const document = parseMarkdown(
      'Text.\n\n![Schild](https://haushalt.example.de/schild.jpg)',
    ).document;
    expect(collectForeignMediaSources(document, ORIGIN)).toEqual([
      { type: 'image', src: 'https://haushalt.example.de/schild.jpg' },
    ]);
  });

  it('says nothing about a page that does it right', () => {
    const document = parseMarkdown('![Schild](/api/attachments/abc/download)').document;
    expect(collectForeignMediaSources(document, ORIGIN)).toEqual([]);
  });

  it('leaves ordinary links alone: a link to another host is a link', () => {
    const document = parseMarkdown('[Quelle](https://example.org/artikel)').document;
    expect(collectForeignMediaSources(document, ORIGIN)).toEqual([]);
  });
});
