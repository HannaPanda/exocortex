import { describe, expect, it } from 'vitest';

import { type ClipRequest, type WebFetchResponse } from '@exocortex/contracts';

import { buildClipNote } from './clip-note';

const AT = new Date('2026-09-18T14:32:00');

function request(overrides: Partial<ClipRequest> = {}): ClipRequest {
  return { url: 'https://www.example.com/artikel', fetchPage: false, ...overrides };
}

function page(overrides: Partial<WebFetchResponse> = {}): WebFetchResponse {
  return {
    requestedUrl: 'https://www.example.com/artikel',
    url: 'https://www.example.com/artikel',
    title: 'Ein Artikel',
    description: null,
    statusCode: 200,
    markdown: 'Der erste Absatz.',
    truncated: false,
    links: [],
    tookMs: 12,
    ...overrides,
  };
}

describe('buildClipNote', () => {
  it('writes the provenance first, before anything the web said', () => {
    const note = buildClipNote({ request: request(), page: null, at: AT });
    expect(note.markdown).toBe(
      'Quelle: [example.com/artikel](https://www.example.com/artikel) ' +
        '(erfasst am 18.09.2026, 14:32)',
    );
  });

  it('names the clip after the title the browser handed over', () => {
    const note = buildClipNote({
      request: request({ title: 'Warum Eingänge' }),
      page: null,
      at: AT,
    });
    expect(note.title).toBe('Warum Eingänge');
  });

  it('falls back to the fetched title, then to host and path', () => {
    expect(buildClipNote({ request: request(), page: page(), at: AT }).title).toBe('Ein Artikel');
    expect(buildClipNote({ request: request(), page: null, at: AT }).title).toBe(
      'example.com/artikel',
    );
  });

  it('keeps the selection as a quote, because it is somebody else’s sentence', () => {
    const note = buildClipNote({
      request: request({ selection: 'Erste Zeile\n\nZweite Zeile' }),
      page: null,
      at: AT,
    });
    expect(note.markdown.split('\n\n')[1]).toBe('> Erste Zeile\n>\n> Zweite Zeile');
  });

  it('separates the fetched text from the provenance with a rule', () => {
    const note = buildClipNote({ request: request(), page: page(), at: AT });
    expect(note.markdown.endsWith('\n\n---\n\nDer erste Absatz.')).toBe(true);
  });

  it('drops the article’s own headline so the title is not on the page twice', () => {
    const note = buildClipNote({
      request: request(),
      page: page({ markdown: '# Ein Artikel\n\nDer erste Absatz.' }),
      at: AT,
    });
    expect(note.markdown).toContain('---\n\nDer erste Absatz.');
    expect(note.markdown).not.toContain('# Ein Artikel');
  });

  it('keeps a headline that is not the title', () => {
    const note = buildClipNote({
      request: request({ title: 'Meine Notiz' }),
      page: page({ markdown: '# Ein Artikel\n\nDer erste Absatz.' }),
      at: AT,
    });
    expect(note.markdown).toContain('# Ein Artikel');
  });

  it('says where the text really came from when a redirect moved it', () => {
    const note = buildClipNote({
      request: request(),
      page: page({ url: 'https://www.example.com/artikel-2026' }),
      at: AT,
    });
    expect(note.markdown).toContain('Gelesen von: https://www.example.com/artikel-2026');
  });

  it('carries selection and article at once, in that order', () => {
    const note = buildClipNote({
      request: request({ selection: 'Der wichtige Satz.' }),
      page: page(),
      at: AT,
    });
    const parts = note.markdown.split('\n\n');
    expect(parts[1]).toBe('> Der wichtige Satz.');
    expect(parts[2]).toBe('---');
    expect(parts[3]).toBe('Der erste Absatz.');
  });
});
