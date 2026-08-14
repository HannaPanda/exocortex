import { describe, expect, it } from 'vitest';

import { detectMimeType, isProbablyText, sanitizeFilename } from './mime';
import { buildAttachmentKey } from './object-storage';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const webp = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe('detectMimeType', () => {
  it('detects images and documents by magic bytes', () => {
    expect(detectMimeType(png, 'image/png')?.mimeType).toBe('image/png');
    expect(detectMimeType(jpeg, 'image/jpeg')?.mimeType).toBe('image/jpeg');
    expect(detectMimeType(pdf, 'application/pdf')?.mimeType).toBe('application/pdf');
    expect(detectMimeType(webp, 'image/webp')?.mimeType).toBe('image/webp');
  });

  it('ignores a lying declared type', () => {
    // A PNG uploaded as "application/pdf" is still detected as a PNG.
    expect(detectMimeType(png, 'application/pdf')?.mimeType).toBe('image/png');
  });

  it('rejects an executable disguised as an image', () => {
    expect(detectMimeType(elf, 'image/png')).toBeNull();
  });

  it('detects SVG by content', () => {
    expect(
      detectMimeType(textBytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/svg+xml')
        ?.mimeType,
    ).toBe('image/svg+xml');
  });

  it('accepts plain text and Markdown only when declared', () => {
    expect(detectMimeType(textBytes('# Titel\n'), 'text/markdown')?.mimeType).toBe('text/markdown');
    expect(detectMimeType(textBytes('nur Text'), 'text/plain')?.mimeType).toBe('text/plain');
    expect(detectMimeType(textBytes('nur Text'), 'application/x-sh')).toBeNull();
  });

  it('validates JSON payloads', () => {
    expect(detectMimeType(textBytes('{"a":1}'), 'application/json')?.mimeType).toBe(
      'application/json',
    );
    expect(detectMimeType(textBytes('{not json'), 'application/json')).toBeNull();
  });

  it('treats NUL bytes as binary', () => {
    expect(isProbablyText(new Uint8Array([0x61, 0x00, 0x62]))).toBe(false);
    expect(isProbablyText(textBytes('Hallo Welt\n'))).toBe(true);
  });
});

describe('sanitizeFilename', () => {
  it('strips path separators and leading dots', () => {
    // Separators become underscores and the leading dots are removed, so the
    // result can never escape the storage prefix.
    expect(sanitizeFilename('../../etc/passwd', 'txt')).toBe('_.._etc_passwd');
    expect(sanitizeFilename('bild.png', 'png')).toBe('bild.png');
  });

  it('falls back for empty names', () => {
    expect(sanitizeFilename('   ', 'png')).toBe('datei.png');
    expect(sanitizeFilename('...', 'png')).toBe('datei.png');
  });
});

describe('buildAttachmentKey', () => {
  it('derives a workspace-scoped key from server-side data only', () => {
    const key = buildAttachmentKey({
      workspaceId: 'workspace_1',
      attachmentId: 'attachment_1',
      extension: 'png',
      now: new Date('2026-08-04T00:00:00.000Z'),
    });
    expect(key).toBe('workspaces/workspace_1/2026/08/attachment_1.png');
  });

  it('rejects an unsafe extension', () => {
    const key = buildAttachmentKey({
      workspaceId: 'workspace_1',
      attachmentId: 'attachment_1',
      extension: '../../evil',
      now: new Date('2026-08-04T00:00:00.000Z'),
    });
    expect(key.endsWith('.bin')).toBe(true);
  });
});
