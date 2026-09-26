/**
 * Magic-byte MIME detection.
 *
 * The browser-provided `Content-Type` of an upload is a hint, never a decision:
 * a renamed executable would otherwise be accepted as an image. Only the formats
 * Exocortex actually allows are recognized, so the check is an allow list rather
 * than a best-effort guess.
 *
 * Implemented locally instead of pulling in a large detection library: the
 * signature table is short, auditable and test-covered.
 */

export interface DetectedMimeType {
  mimeType: string;
  /** Extension without a leading dot, for display purposes only. */
  extension: string;
}

interface Signature {
  mimeType: string;
  extension: string;
  offset: number;
  bytes: number[];
  /** Optional secondary check (for containers such as RIFF/WEBP). */
  verify?: (buffer: Uint8Array) => boolean;
  /**
   * Optional look inside the container, for the families whose signature only
   * says which box the document came in.
   *
   * A docx, an xlsx, an odt and an epub are all ZIP archives, and a .doc, a
   * .xls and a .ppt are all OLE compound files, so the eight bytes at the front
   * identify the packaging and not the document. Returning null falls back to
   * the signature's own type, which is how a plain zip stays a plain zip.
   */
  resolve?: (buffer: Uint8Array) => DetectedMimeType | null;
}

const SIGNATURES: Signature[] = [
  {
    mimeType: 'image/png',
    extension: 'png',
    offset: 0,
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  { mimeType: 'image/jpeg', extension: 'jpg', offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { mimeType: 'image/gif', extension: 'gif', offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] },
  {
    mimeType: 'image/webp',
    extension: 'webp',
    offset: 0,
    bytes: [0x52, 0x49, 0x46, 0x46],
    verify: (buffer) => matches(buffer, 8, [0x57, 0x45, 0x42, 0x50]),
  },
  {
    mimeType: 'image/avif',
    extension: 'avif',
    offset: 4,
    bytes: [0x66, 0x74, 0x79, 0x70],
    verify: (buffer) => matches(buffer, 8, [0x61, 0x76, 0x69, 0x66]),
  },
  {
    mimeType: 'application/pdf',
    extension: 'pdf',
    offset: 0,
    bytes: [0x25, 0x50, 0x44, 0x46, 0x2d],
  },
  {
    mimeType: 'application/zip',
    extension: 'zip',
    offset: 0,
    bytes: [0x50, 0x4b, 0x03, 0x04],
    resolve: resolveZipContainer,
  },
  {
    // OLE2 compound file: the legacy Word, Excel and PowerPoint documents.
    mimeType: 'application/x-ole-storage',
    extension: 'bin',
    offset: 0,
    bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
    resolve: resolveOleContainer,
  },
  {
    // `{\rtf`, the open group and control word every RTF file starts with.
    mimeType: 'application/rtf',
    extension: 'rtf',
    offset: 0,
    bytes: [0x7b, 0x5c, 0x72, 0x74, 0x66],
  },

  // Media for the video and audio blocks. The ISO base media container (`ftyp`)
  // is shared by MP4 and M4A, so the brand at offset 8 decides which it is; the
  // audio brands are checked first because `M4A ` also passes an `isom` test on
  // some encoders.
  {
    mimeType: 'audio/mp4',
    extension: 'm4a',
    offset: 4,
    bytes: [0x66, 0x74, 0x79, 0x70],
    verify: (buffer) => matches(buffer, 8, [0x4d, 0x34, 0x41, 0x20]),
  },
  {
    mimeType: 'video/mp4',
    extension: 'mp4',
    offset: 4,
    bytes: [0x66, 0x74, 0x79, 0x70],
    // `isom`, `iso2`, `mp41`, `mp42` and `avc1` are all MP4 video brands.
    verify: (buffer) =>
      ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V '].some((brand) =>
        matches(
          buffer,
          8,
          Array.from(brand, (character) => character.charCodeAt(0)),
        ),
      ),
  },
  {
    // Matroska and WebM share the EBML header; the DocType decides.
    mimeType: 'video/webm',
    extension: 'webm',
    offset: 0,
    bytes: [0x1a, 0x45, 0xdf, 0xa3],
  },
  { mimeType: 'audio/mpeg', extension: 'mp3', offset: 0, bytes: [0x49, 0x44, 0x33] },
  { mimeType: 'audio/mpeg', extension: 'mp3', offset: 0, bytes: [0xff, 0xfb] },
  {
    mimeType: 'audio/wav',
    extension: 'wav',
    offset: 0,
    bytes: [0x52, 0x49, 0x46, 0x46],
    verify: (buffer) => matches(buffer, 8, [0x57, 0x41, 0x56, 0x45]),
  },
  {
    mimeType: 'audio/ogg',
    extension: 'ogg',
    offset: 0,
    bytes: [0x4f, 0x67, 0x67, 0x53],
  },
];

function matches(buffer: Uint8Array, offset: number, bytes: readonly number[]): boolean {
  if (buffer.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => buffer[offset + index] === byte);
}

/** Byte offset of the first local file header's name, per the ZIP specification. */
const ZIP_FIRST_NAME_OFFSET = 30;

/**
 * OpenDocument and EPUB both require their first archive entry to be a stored
 * (uncompressed) `mimetype` whose contents are the media type. That makes the
 * type readable at a fixed offset without inflating anything, which is exactly
 * what the two specifications intended it for.
 */
const ODF_LIKE_MIME_TYPES: Readonly<Record<string, string>> = {
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/epub+zip': 'epub',
};

/**
 * OOXML has no such marker, so the document is identified by the part that only
 * its own kind of document has. Entry names are never compressed, so they are
 * readable in the raw bytes whatever the archive did with the parts themselves.
 */
const OOXML_PARTS: readonly (readonly [part: string, mimeType: string, extension: string])[] = [
  [
    'word/document.xml',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'docx',
  ],
  ['xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  [
    'ppt/presentation.xml',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'pptx',
  ],
];

/** Null for an archive that is just an archive, which keeps a zip a zip. */
function resolveZipContainer(buffer: Uint8Array): DetectedMimeType | null {
  const nameLength = readUint16(buffer, 26);
  if (nameLength === 8 && asciiAt(buffer, ZIP_FIRST_NAME_OFFSET, 8) === 'mimetype') {
    // Stored, so the declared type follows the name -- but not necessarily
    // directly: bytes 28 and 29 are the extra field's length, and the extra
    // field is what sits between the two. Reading the type at a fixed 38 works
    // on every file a normal producer writes and silently reads the wrong
    // bytes on the one that uses the field. An entry that was deflated after
    // all leaves garbage here, which simply matches nothing.
    const extraFieldLength = readUint16(buffer, 28);
    const declared = asciiAt(buffer, ZIP_FIRST_NAME_OFFSET + 8 + extraFieldLength, 64);
    for (const [mimeType, extension] of Object.entries(ODF_LIKE_MIME_TYPES)) {
      if (declared.startsWith(mimeType)) return { mimeType, extension };
    }
  }

  // Only the head is scanned: the parts below sit in the first entries of every
  // OOXML package, and scanning tens of megabytes to answer a type question
  // would make a large upload pay for a small fact.
  const head = asciiAt(buffer, 0, 64 * 1_024);
  for (const [part, mimeType, extension] of OOXML_PARTS) {
    if (head.includes(part)) return { mimeType, extension };
  }
  return null;
}

/**
 * The stream that identifies each legacy format, as its directory names it.
 * Directory entry names are UTF-16LE, so they are searched in that encoding.
 */
const OLE_STREAMS: readonly (readonly [stream: string, mimeType: string, extension: string])[] = [
  ['WordDocument', 'application/msword', 'doc'],
  ['Workbook', 'application/vnd.ms-excel', 'xls'],
  ['PowerPoint Document', 'application/vnd.ms-powerpoint', 'ppt'],
];

/**
 * Null for any other OLE compound file, and that is the useful answer: the
 * fallback type is not on the upload allow list, so an Outlook message or an
 * old Visio drawing is refused rather than stored as a document nothing reads.
 */
function resolveOleContainer(buffer: Uint8Array): DetectedMimeType | null {
  const head = utf16LeAt(buffer, 0, 512 * 1_024);
  for (const [stream, mimeType, extension] of OLE_STREAMS) {
    if (head.includes(stream)) return { mimeType, extension };
  }
  return null;
}

function readUint16(buffer: Uint8Array, offset: number): number {
  if (buffer.length < offset + 2) return 0;
  return (buffer[offset] ?? 0) | ((buffer[offset + 1] ?? 0) << 8);
}

/** Latin-1 rather than UTF-8: a byte that is not ASCII must not end the scan. */
function asciiAt(buffer: Uint8Array, offset: number, length: number): string {
  return new TextDecoder('latin1').decode(buffer.subarray(offset, offset + length));
}

/**
 * Decodes as UTF-16LE with the surrogate halves left alone, which is what makes
 * a search for a plain ASCII stream name work: each of its characters lands on
 * one code unit whatever surrounds it in the directory.
 */
function utf16LeAt(buffer: Uint8Array, offset: number, length: number): string {
  const slice = buffer.subarray(offset, offset + length);
  // An odd tail byte cannot start a code unit, so it is dropped rather than
  // shifting every character after it.
  const units = slice.length - (slice.length % 2);
  return new TextDecoder('utf-16le').decode(slice.subarray(0, units));
}

const SVG_PATTERN = /<svg[\s>]/i;
const XML_DECLARATION_PATTERN = /^\s*<\?xml/i;

/**
 * Detects the MIME type of a buffer. Text formats are only accepted when the
 * declared type says so *and* the content is valid UTF-8 without control bytes,
 * because text has no magic bytes.
 */
export function detectMimeType(
  buffer: Uint8Array,
  declaredMimeType: string | undefined,
): DetectedMimeType | null {
  for (const signature of SIGNATURES) {
    if (!matches(buffer, signature.offset, signature.bytes)) continue;
    if (signature.verify !== undefined && !signature.verify(buffer)) continue;
    return (
      signature.resolve?.(buffer) ?? {
        mimeType: signature.mimeType,
        extension: signature.extension,
      }
    );
  }

  const head = new TextDecoder('utf-8', { fatal: false }).decode(buffer.subarray(0, 4_096));

  if (SVG_PATTERN.test(head) || (XML_DECLARATION_PATTERN.test(head) && SVG_PATTERN.test(head))) {
    return { mimeType: 'image/svg+xml', extension: 'svg' };
  }

  if (!isProbablyText(buffer)) return null;

  switch (declaredMimeType) {
    case 'application/json':
      return isParsableJson(head, buffer)
        ? { mimeType: 'application/json', extension: 'json' }
        : null;
    case 'text/markdown':
      return { mimeType: 'text/markdown', extension: 'md' };
    // Like the two below it, a declared type and valid text is all there is to
    // go on. The distinction is worth keeping even so: it is what routes the
    // file to the converter that reads a table out of it rather than storing
    // the commas as prose.
    case 'text/csv':
      return { mimeType: 'text/csv', extension: 'csv' };
    case 'text/plain':
      return { mimeType: 'text/plain', extension: 'txt' };
    default:
      return null;
  }
}

/** Rejects binary content masquerading as text. */
export function isProbablyText(buffer: Uint8Array): boolean {
  const sample = buffer.subarray(0, 8_192);
  for (const byte of sample) {
    if (byte === 0) return false;
    // Allow tab, newline, carriage return and everything from space upwards.
    if (byte < 0x09) return false;
    if (byte > 0x0d && byte < 0x20) return false;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

function isParsableJson(head: string, buffer: Uint8Array): boolean {
  // Only fully decode small payloads; large JSON is accepted based on its head.
  if (buffer.length > 4_096)
    return head.trimStart().startsWith('{') || head.trimStart().startsWith('[');
  try {
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
    return true;
  } catch {
    return false;
  }
}

/** Sanitizes a client-provided filename for storage and Content-Disposition. */
export function sanitizeFilename(filename: string, fallbackExtension: string): string {
  const base = Array.from(filename)
    // Drop C0/C1 control characters and DEL without a control-character regex.
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join('')
    // Path separators become underscores so a name can never escape its prefix.
    .replace(/[\\/]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200);
  if (base.length === 0) return `datei.${fallbackExtension}`;
  return base;
}
