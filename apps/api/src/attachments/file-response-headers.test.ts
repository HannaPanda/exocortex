import { describe, expect, it } from 'vitest';

import { FILE_CONTENT_SECURITY_POLICY, fileResponseHeaders } from './file-response-headers';

const svg = {
  mimeType: 'image/svg+xml',
  byteSize: 120,
  filename: 'bild.svg',
  disposition: 'inline' as const,
};

describe('fileResponseHeaders', () => {
  it('sandboxes an SVG so a direct visit runs no script under our origin (#177)', () => {
    const headers = fileResponseHeaders(svg);
    expect(headers['content-security-policy']).toBe(FILE_CONTENT_SECURITY_POLICY);
    expect(FILE_CONTENT_SECURITY_POLICY).toMatch(/(^|; )sandbox$/);
    expect(FILE_CONTENT_SECURITY_POLICY).not.toContain('allow-scripts');
    expect(FILE_CONTENT_SECURITY_POLICY).not.toContain('allow-same-origin');
    expect(FILE_CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['content-disposition']).toBe('inline; filename="bild.svg"');
  });

  it('sandboxes every other type too, a download included', () => {
    for (const mimeType of ['image/png', 'text/plain', 'application/json', 'video/mp4']) {
      const headers = fileResponseHeaders({ ...svg, mimeType, disposition: 'attachment' });
      expect(headers['content-security-policy']).toBe(FILE_CONTENT_SECURITY_POLICY);
      expect(headers['content-disposition']).toMatch(/^attachment; /);
    }
  });

  it('leaves a PDF unsandboxed, because Chromium will not open a sandboxed one', () => {
    const headers = fileResponseHeaders({ ...svg, mimeType: 'application/pdf' });
    expect(headers['content-security-policy']).toBeUndefined();
    expect(headers['x-content-type-options']).toBe('nosniff');
  });

  it('keeps the filename inside its quoted string', () => {
    const headers = fileResponseHeaders({ ...svg, filename: 'a"b\\c\r\nÄ.svg' });
    expect(headers['content-disposition']).toBe('inline; filename="a_b_c___.svg"');
    expect(headers['content-length']).toBe('120');
  });
});
