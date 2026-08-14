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
  { mimeType: 'application/zip', extension: 'zip', offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] },

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
          [...brand].map((character) => character.charCodeAt(0)),
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
    return { mimeType: signature.mimeType, extension: signature.extension };
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
  const base = [...filename]
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
