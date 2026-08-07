import { describe, expect, it } from 'vitest';

import { normalizeWikiTitle, parseLinkHref } from './link-target';

describe('parseLinkHref', () => {
  it('parses wiki: links', () => {
    expect(parseLinkHref('wiki:Titel')).toEqual({ kind: 'wiki', title: 'Titel' });
  });

  it('parses wiki:// links (optionalSlashes)', () => {
    expect(parseLinkHref('wiki://Titel')).toEqual({ kind: 'wiki', title: 'Titel' });
  });

  it('matches the wiki scheme case-insensitively', () => {
    expect(parseLinkHref('WIKI:Titel')).toEqual({ kind: 'wiki', title: 'Titel' });
  });

  it('decodes a percent-encoded title', () => {
    expect(parseLinkHref('wiki:Titel%20mit%20Leerzeichen')).toEqual({
      kind: 'wiki',
      title: 'Titel mit Leerzeichen',
    });
  });

  it('collapses internal whitespace and trims the title', () => {
    expect(parseLinkHref('wiki:  Doppelter   Leerraum ')).toEqual({
      kind: 'wiki',
      title: 'Doppelter Leerraum',
    });
  });

  it('treats an empty wiki title as unknown', () => {
    expect(parseLinkHref('wiki:')).toEqual({ kind: 'unknown' });
  });

  it('parses https: links as external', () => {
    expect(parseLinkHref('https://example.com')).toEqual({
      kind: 'external',
      url: 'https://example.com',
    });
  });

  it('parses http: links as external', () => {
    expect(parseLinkHref('http://example.com')).toEqual({
      kind: 'external',
      url: 'http://example.com',
    });
  });

  it('parses mailto: links', () => {
    expect(parseLinkHref('mailto:jemand@example.com')).toEqual({
      kind: 'mailto',
      url: 'mailto:jemand@example.com',
    });
  });

  it('parses an in-app route', () => {
    expect(parseLinkHref('/arbeitsbereich/w/seite/d')).toEqual({
      kind: 'route',
      path: '/arbeitsbereich/w/seite/d',
    });
  });

  it('parses an attachment path', () => {
    expect(parseLinkHref('/api/attachments/x/download')).toEqual({
      kind: 'attachment',
      path: '/api/attachments/x/download',
    });
  });

  it('treats a protocol-relative address as external, not as a route', () => {
    expect(parseLinkHref('//evil.example')).toEqual({ kind: 'external', url: '//evil.example' });
  });

  it('parses a same-page anchor', () => {
    expect(parseLinkHref('#blk_1')).toEqual({ kind: 'anchor', blockId: 'blk_1' });
  });

  it('never classifies a javascript: address as anything but unknown', () => {
    // The security barrier: this is the value a click handler must refuse to
    // hand to `window.open` or `window.location`.
    expect(parseLinkHref('javascript:alert(1)')).toEqual({ kind: 'unknown' });
  });

  it('treats a data: address as unknown', () => {
    expect(parseLinkHref('data:text/html,<script>alert(1)</script>')).toEqual({
      kind: 'unknown',
    });
  });

  it('treats an empty string as unknown', () => {
    expect(parseLinkHref('')).toEqual({ kind: 'unknown' });
  });

  it('treats null as unknown', () => {
    expect(parseLinkHref(null)).toEqual({ kind: 'unknown' });
  });

  it('treats undefined as unknown', () => {
    expect(parseLinkHref(undefined)).toEqual({ kind: 'unknown' });
  });
});

describe('normalizeWikiTitle', () => {
  it('trims and collapses whitespace runs', () => {
    expect(normalizeWikiTitle('  a   b  c ')).toBe('a b c');
  });
});
