/**
 * A minimal USTAR writer (issue #44).
 *
 * The build's input reaches the container on stdin as a tar stream and the
 * finished file comes back on stdout. Nothing is written to disk on either side,
 * which is what keeps the runner free of bind mounts, temporary directories and
 * their cleanup -- and free of the systemd `PrivateTmp` trap, where the path the
 * worker sees is not the path the Docker daemon would resolve.
 *
 * Twenty lines of header format beat a dependency here: the archive contains a
 * handful of regular files with names this code chooses itself, so none of the
 * cases a real tar library exists for (symlinks, long names, sparse files,
 * permissions) can occur.
 */

const BLOCK_SIZE = 512;

export interface TarEntry {
  /** Path inside the archive. ASCII, at most 99 characters. */
  name: string;
  content: Uint8Array;
}

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function writeString(block: Uint8Array, value: string, offset: number, length: number): void {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) {
    throw new Error(`Tar field does not fit: ${value}`);
  }
  block.set(bytes, offset);
}

/**
 * Splits a path across USTAR's `name` and `prefix` fields.
 *
 * `name` holds 100 bytes and `prefix` another 155, joined with a slash by every
 * reader. Without the split, a project with a path longer than 99 characters --
 * `chapters/anhang/messreihen/2026-03/auswertung.tex` and two more levels -- is
 * a build that fails on an archive it could have written.
 */
function splitPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path, 'utf8') <= 99) return { name: path, prefix: '' };
  // The last separator that leaves a name short enough is the one to cut at.
  for (let at = path.indexOf('/'); at !== -1; at = path.indexOf('/', at + 1)) {
    const prefix = path.slice(0, at);
    const name = path.slice(at + 1);
    if (Buffer.byteLength(name, 'utf8') <= 99 && Buffer.byteLength(prefix, 'utf8') <= 154) {
      return { name, prefix };
    }
  }
  throw new Error(`Path does not fit into a tar header: ${path}`);
}

function header(entry: TarEntry): Uint8Array {
  const block = new Uint8Array(BLOCK_SIZE);
  const { name, prefix } = splitPath(entry.name);
  writeString(block, name, 0, 100);
  writeString(block, octal(0o644, 8), 100, 8);
  writeString(block, octal(0, 8), 108, 8); // uid
  writeString(block, octal(0, 8), 116, 8); // gid
  writeString(block, octal(entry.content.length, 12), 124, 12);
  writeString(block, octal(0, 12), 136, 12); // mtime: zero, so the archive of
  // identical inputs is byte-identical and a build stays reproducible.
  block.fill(0x20, 148, 156); // checksum field, spaces while computing
  block[156] = 0x30; // type flag '0': regular file
  writeString(block, 'ustar\0', 257, 6);
  writeString(block, '00', 263, 2);
  if (prefix.length > 0) writeString(block, prefix, 345, 155);

  let checksum = 0;
  for (const byte of block) checksum += byte;
  writeString(block, `${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);

  return block;
}

/** Packs the entries into one tar archive, terminator included. */
export function createTar(entries: readonly TarEntry[]): Buffer {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    parts.push(header(entry));
    parts.push(entry.content);
    const padding = (BLOCK_SIZE - (entry.content.length % BLOCK_SIZE)) % BLOCK_SIZE;
    if (padding > 0) parts.push(new Uint8Array(padding));
  }
  // Two empty blocks end the archive; tar implementations read them as EOF.
  parts.push(new Uint8Array(BLOCK_SIZE * 2));
  return Buffer.concat(parts);
}

/**
 * Reads a tar archive back into its entries (issue #43, ADR-027).
 *
 * The other direction, for the other runner: a project build produces several
 * files (the PDF, the TeX log, the SyncTeX map) where a render produces one, so
 * its container answers with an archive on stdout instead of raw bytes.
 *
 * Deliberately forgiving about what it does not understand. Anything that is
 * not a regular file -- a directory entry, a GNU long-name block, a pax header
 * -- is skipped rather than refused: the archive is produced by `tar` inside a
 * container we started, and a build must not fail because that `tar` decided to
 * describe a directory it created.
 */
export function readTar(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;

  while (offset + BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE);
    // Two zero blocks end the archive; one is enough to stop reading.
    if (header.every((byte) => byte === 0)) break;

    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const name = prefix.length > 0 ? `${prefix}/${rawName}` : rawName;
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeField === '' ? '0' : sizeField, 8);
    if (!Number.isFinite(size) || size < 0) break;

    const typeFlag = String.fromCharCode(header[156] ?? 0);
    const start = offset + BLOCK_SIZE;
    const end = start + size;
    if (end > archive.length) break;

    if ((typeFlag === '0' || typeFlag === '\0') && name.length > 0) {
      entries.push({ name, content: archive.subarray(start, end) });
    }

    offset = end + ((BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE);
  }

  return entries;
}
