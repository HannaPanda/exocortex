import { deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * A minimal ZIP reader and writer (issue #54).
 *
 * The same reasoning as the USTAR writer in the worker, one format further: the
 * cases a real archive library exists for are ones this code cannot meet. What
 * it writes are regular files whose names it has already validated with
 * `checkProjectPath`, and what it reads is refused rather than interpreted the
 * moment it is not a plain stored or deflated file. That leaves the header
 * layout, a CRC table and two calls into `node:zlib`.
 *
 * ZIP rather than tar because this end of the pipe is a person: an archive that
 * a file manager opens with a double click on every operating system is the
 * whole point of the feature, and `.tar.gz` is not that on Windows.
 *
 * What it deliberately does not do: encryption, multi-disk archives, and the
 * data-descriptor sizes that a streaming writer leaves behind the file data.
 * Sizes are read from the central directory, which is where every archive that
 * has been fully written carries them, and an entry it cannot account for is
 * reported as skipped rather than guessed at.
 */

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;

const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

/** Bit 0 of the general purpose flags: the entry is encrypted. */
const FLAG_ENCRYPTED = 0x0001;
/** Bit 11: the file name is UTF-8 rather than CP437. */
const FLAG_UTF8_NAMES = 0x0800;

/** A 32-bit field that is saturated points at a ZIP64 extra field instead. */
const UINT32_MAX = 0xffffffff;
const UINT16_MAX = 0xffff;

/**
 * 1980-01-01 00:00, the earliest a DOS timestamp can express.
 *
 * Fixed rather than the current time, for the reason the tar writer zeroes its
 * mtime: exporting an unchanged project twice produces two identical files, so
 * a hash over the archive means something.
 */
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;

export interface ZipEntry {
  /** Path inside the archive, with forward slashes. */
  name: string;
  content: Buffer;
}

/** Why one entry of an archive could not be read. */
export type ZipSkipReason = 'encrypted' | 'unsupported_method' | 'corrupt';

export interface ZipReadResult {
  entries: ZipEntry[];
  skipped: { name: string; reason: ZipSkipReason }[];
}

export class ZipError extends Error {
  public readonly code: 'not_a_zip' | 'archive_too_large';

  constructor(code: 'not_a_zip' | 'archive_too_large', message: string) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// CRC-32
// ---------------------------------------------------------------------------

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

interface PreparedEntry {
  nameBytes: Buffer;
  method: number;
  crc: number;
  compressed: Buffer;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function prepare(entry: ZipEntry, offset: number): PreparedEntry {
  const nameBytes = Buffer.from(entry.name, 'utf8');
  const deflated =
    entry.content.byteLength === 0 ? null : deflateRawSync(entry.content, { level: 6 });
  // Storing beats deflating whenever deflating made it bigger, which happens
  // for anything already compressed -- a PNG, a JPEG, a PDF.
  const useDeflate = deflated !== null && deflated.byteLength < entry.content.byteLength;
  return {
    nameBytes,
    method: useDeflate ? METHOD_DEFLATED : METHOD_STORED,
    crc: crc32(entry.content),
    compressed: useDeflate && deflated !== null ? deflated : entry.content,
    uncompressedSize: entry.content.byteLength,
    localHeaderOffset: offset,
  };
}

function localHeader(entry: PreparedEntry): Buffer {
  const header = Buffer.alloc(30 + entry.nameBytes.byteLength);
  header.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(FLAG_UTF8_NAMES, 6);
  header.writeUInt16LE(entry.method, 8);
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.compressed.byteLength, 18);
  header.writeUInt32LE(entry.uncompressedSize, 22);
  header.writeUInt16LE(entry.nameBytes.byteLength, 26);
  header.writeUInt16LE(0, 28); // no extra field
  entry.nameBytes.copy(header, 30);
  return header;
}

function centralHeader(entry: PreparedEntry): Buffer {
  const header = Buffer.alloc(46 + entry.nameBytes.byteLength);
  header.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(20, 4); // version made by
  header.writeUInt16LE(20, 6); // version needed
  header.writeUInt16LE(FLAG_UTF8_NAMES, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt16LE(DOS_TIME, 12);
  header.writeUInt16LE(DOS_DATE, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.compressed.byteLength, 20);
  header.writeUInt32LE(entry.uncompressedSize, 24);
  header.writeUInt16LE(entry.nameBytes.byteLength, 28);
  header.writeUInt16LE(0, 30); // extra length
  header.writeUInt16LE(0, 32); // comment length
  header.writeUInt16LE(0, 34); // disk number
  header.writeUInt16LE(0, 36); // internal attributes
  header.writeUInt32LE(0, 38); // external attributes
  header.writeUInt32LE(entry.localHeaderOffset, 42);
  entry.nameBytes.copy(header, 46);
  return header;
}

/** Packs the entries into one archive. Directories are implied by the paths. */
export function createZip(entries: readonly ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const prepared: PreparedEntry[] = [];
  let offset = 0;

  for (const entry of entries) {
    const item = prepare(entry, offset);
    const header = localHeader(item);
    parts.push(header, item.compressed);
    offset += header.byteLength + item.compressed.byteLength;
    prepared.push(item);
  }

  const directoryOffset = offset;
  let directorySize = 0;
  for (const item of prepared) {
    const header = centralHeader(item);
    parts.push(header);
    directorySize += header.byteLength;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the central directory
  end.writeUInt16LE(prepared.length, 8);
  end.writeUInt16LE(prepared.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(directoryOffset, 16);
  end.writeUInt16LE(0, 20); // comment length
  parts.push(end);

  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Where the central directory starts, following a ZIP64 record when there is one. */
function findCentralDirectory(archive: Buffer): { offset: number; count: number } {
  // The end record is last but for a comment of at most 65535 bytes.
  const from = Math.max(0, archive.byteLength - (22 + UINT16_MAX));
  let end = -1;
  for (let at = archive.byteLength - 22; at >= from; at -= 1) {
    if (archive.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      end = at;
      break;
    }
  }
  if (end === -1) throw new ZipError('not_a_zip', 'No end of central directory record');

  let offset = archive.readUInt32LE(end + 16);
  let count = archive.readUInt16LE(end + 10);

  if (offset === UINT32_MAX || count === UINT16_MAX) {
    // A saturated field means the real one is in the ZIP64 record, which the
    // locator immediately before the end record points at.
    const locator = end - 20;
    if (locator < 0 || archive.readUInt32LE(locator) !== ZIP64_LOCATOR_SIGNATURE) {
      throw new ZipError('not_a_zip', 'A ZIP64 archive without a locator');
    }
    const zip64 = Number(archive.readBigUInt64LE(locator + 8));
    if (
      zip64 < 0 ||
      zip64 + 56 > archive.byteLength ||
      archive.readUInt32LE(zip64) !== ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE
    ) {
      throw new ZipError('not_a_zip', 'A ZIP64 end record that is not there');
    }
    count = Number(archive.readBigUInt64LE(zip64 + 32));
    offset = Number(archive.readBigUInt64LE(zip64 + 48));
  }

  if (offset < 0 || offset >= archive.byteLength) {
    throw new ZipError('not_a_zip', 'The central directory points outside the archive');
  }
  return { offset, count };
}

interface DirectoryEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/**
 * Pulls the saturated fields of one entry out of its ZIP64 extra field.
 *
 * The order inside the extra field is positional, not tagged: uncompressed
 * size, compressed size, local header offset, each present only if the matching
 * 32-bit field was saturated.
 */
function applyZip64Extra(entry: DirectoryEntry, extra: Buffer): void {
  let at = 0;
  while (at + 4 <= extra.byteLength) {
    const id = extra.readUInt16LE(at);
    const size = extra.readUInt16LE(at + 2);
    const body = extra.subarray(at + 4, at + 4 + size);
    if (id === 0x0001) {
      let cursor = 0;
      const next = (): number | null => {
        if (cursor + 8 > body.byteLength) return null;
        const value = Number(body.readBigUInt64LE(cursor));
        cursor += 8;
        return value;
      };
      if (entry.uncompressedSize === UINT32_MAX) entry.uncompressedSize = next() ?? 0;
      if (entry.compressedSize === UINT32_MAX) entry.compressedSize = next() ?? 0;
      if (entry.localHeaderOffset === UINT32_MAX) entry.localHeaderOffset = next() ?? 0;
      return;
    }
    at += 4 + size;
  }
}

function readDirectory(archive: Buffer, start: number, count: number): DirectoryEntry[] {
  const entries: DirectoryEntry[] = [];
  let at = start;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > archive.byteLength) break;
    if (archive.readUInt32LE(at) !== CENTRAL_HEADER_SIGNATURE) break;

    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    const entry: DirectoryEntry = {
      name: archive.subarray(at + 46, at + 46 + nameLength).toString('utf8'),
      flags: archive.readUInt16LE(at + 8),
      method: archive.readUInt16LE(at + 10),
      compressedSize: archive.readUInt32LE(at + 20),
      uncompressedSize: archive.readUInt32LE(at + 24),
      localHeaderOffset: archive.readUInt32LE(at + 42),
    };
    if (extraLength > 0) {
      applyZip64Extra(
        entry,
        archive.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength),
      );
    }
    entries.push(entry);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The bytes of one entry, or null when the archive does not hold them. */
function readEntryBytes(archive: Buffer, entry: DirectoryEntry, budget: number): Buffer | null {
  const header = entry.localHeaderOffset;
  if (header + 30 > archive.byteLength) return null;
  if (archive.readUInt32LE(header) !== LOCAL_HEADER_SIGNATURE) return null;

  // The local header repeats the name and the extra field, and the extra field
  // may be a different length from the one in the central directory. Reading
  // both from here rather than reusing the directory's is the difference
  // between landing on the file data and landing a few bytes into it.
  const nameLength = archive.readUInt16LE(header + 26);
  const extraLength = archive.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > archive.byteLength) return null;

  const raw = archive.subarray(start, end);
  if (entry.method === METHOD_STORED) return Buffer.from(raw);
  // `maxOutputLength` is the second half of the zip-bomb guard: the first is
  // the budget taken from the central directory, this one catches a directory
  // that lied about it.
  return Buffer.from(inflateRawSync(raw, { maxOutputLength: budget }));
}

/**
 * Reads an archive into its regular files.
 *
 * Directory entries are dropped rather than reported: a directory is not a file
 * in a project (paths carry their own prefixes), so listing thirty of them as
 * "skipped" would bury the three entries a caller actually has to look at.
 */
export function readZip(archive: Buffer, options: { maxTotalBytes: number }): ZipReadResult {
  const directory = findCentralDirectory(archive);
  const listed = readDirectory(archive, directory.offset, directory.count);

  let total = 0;
  for (const entry of listed) total += entry.uncompressedSize;
  if (total > options.maxTotalBytes) {
    throw new ZipError(
      'archive_too_large',
      `The archive holds ${String(total)} uncompressed bytes, more than the allowed ${String(options.maxTotalBytes)}`,
    );
  }

  const entries: ZipEntry[] = [];
  const skipped: { name: string; reason: ZipSkipReason }[] = [];
  let remaining = options.maxTotalBytes;

  for (const entry of listed) {
    if (entry.name.length === 0 || entry.name.endsWith('/')) continue;
    if ((entry.flags & FLAG_ENCRYPTED) !== 0) {
      skipped.push({ name: entry.name, reason: 'encrypted' });
      continue;
    }
    if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATED) {
      skipped.push({ name: entry.name, reason: 'unsupported_method' });
      continue;
    }

    let content: Buffer | null;
    try {
      content = readEntryBytes(archive, entry, Math.max(remaining, 1));
    } catch {
      content = null;
    }
    if (content === null) {
      skipped.push({ name: entry.name, reason: 'corrupt' });
      continue;
    }

    remaining -= content.byteLength;
    if (remaining < 0) {
      throw new ZipError('archive_too_large', 'The archive unpacks to more than is allowed');
    }
    // Backslashes are a separator on the system some archives are written on,
    // and a character `checkProjectPath` refuses on this one.
    entries.push({ name: entry.name.replace(/\\/g, '/'), content });
  }

  return { entries, skipped };
}
