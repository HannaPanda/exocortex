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

/**
 * A ZIP archive whose first local file header carries `name` and, stored
 * uncompressed, `contents`.
 *
 * Built here rather than checked in as a binary: what the detection reads is
 * the two length fields and the bytes they point at, so a fixture would hide
 * exactly the part worth asserting. Verified against real files produced by
 * pandoc and by Word on 2026-09-20 before this was written.
 */
function zipEntry(name: string, contents = ''): Uint8Array {
  const nameBytes = textBytes(name);
  const contentBytes = textBytes(contents);
  const header = new Uint8Array(30 + nameBytes.length + contentBytes.length);
  header.set([0x50, 0x4b, 0x03, 0x04], 0);
  // Bytes 18 to 25 are the two sizes and 26 to 29 the two lengths the reader
  // needs: the name's, and the extra field's, which is what sits between the
  // name and the contents. Leaving the extra field at zero is what every real
  // producer of these files does.
  header[26] = nameBytes.length & 0xff;
  header[27] = (nameBytes.length >> 8) & 0xff;
  header.set(nameBytes, 30);
  header.set(contentBytes, 30 + nameBytes.length);
  return header;
}

/** An OLE compound file whose directory names `stream`, as UTF-16LE. */
function oleWithStream(stream: string): Uint8Array {
  const name = new Uint8Array(stream.length * 2);
  for (const [index, character] of Array.from(stream).entries()) {
    name[index * 2] = character.charCodeAt(0) & 0xff;
    name[index * 2 + 1] = character.charCodeAt(0) >> 8;
  }
  const bytes = new Uint8Array(512 + name.length);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  bytes.set(name, 512);
  return bytes;
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

  it('reads the OpenDocument and EPUB type out of the first archive entry', () => {
    expect(
      detectMimeType(zipEntry('mimetype', 'application/vnd.oasis.opendocument.text'), undefined)
        ?.mimeType,
    ).toBe('application/vnd.oasis.opendocument.text');
    expect(detectMimeType(zipEntry('mimetype', 'application/epub+zip'), undefined)?.mimeType).toBe(
      'application/epub+zip',
    );
  });

  it('identifies an OOXML package by the part only its own kind has', () => {
    expect(detectMimeType(zipEntry('word/document.xml'), undefined)?.extension).toBe('docx');
    expect(detectMimeType(zipEntry('xl/workbook.xml'), undefined)?.extension).toBe('xlsx');
    expect(detectMimeType(zipEntry('ppt/presentation.xml'), undefined)?.extension).toBe('pptx');
  });

  it('identifies the legacy Office formats by their OLE stream', () => {
    expect(detectMimeType(oleWithStream('WordDocument'), undefined)?.mimeType).toBe(
      'application/msword',
    );
    expect(detectMimeType(oleWithStream('Workbook'), undefined)?.mimeType).toBe(
      'application/vnd.ms-excel',
    );
    expect(detectMimeType(oleWithStream('PowerPoint Document'), undefined)?.mimeType).toBe(
      'application/vnd.ms-powerpoint',
    );
  });

  it('leaves an archive that is only an archive alone', () => {
    // The regression this whole look-inside exists for: every docx is a ZIP, so
    // matching the ZIP signature first would have stored one as a plain archive
    // and never offered it an extraction.
    expect(detectMimeType(zipEntry('notes.txt', 'hallo'), undefined)?.mimeType).toBe(
      'application/zip',
    );
  });

  it('refuses an OLE compound file that is not a document', () => {
    // The fallback type is not on the upload allow list, so an Outlook message
    // is rejected rather than stored as something nothing can read.
    expect(detectMimeType(oleWithStream('__substg1.0_0037001F'), undefined)?.mimeType).toBe(
      'application/x-ole-storage',
    );
  });

  it('detects RTF by its open group', () => {
    expect(detectMimeType(textBytes('{\\rtf1\\ansi Hallo}'), undefined)?.mimeType).toBe(
      'application/rtf',
    );
  });

  it('accepts CSV only when declared, like the other text formats', () => {
    expect(detectMimeType(textBytes('a,b\n1,2\n'), 'text/csv')?.mimeType).toBe('text/csv');
    expect(detectMimeType(textBytes('a,b\n1,2\n'), undefined)).toBeNull();
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
