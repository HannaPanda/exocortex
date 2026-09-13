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

function header(entry: TarEntry): Uint8Array {
  const block = new Uint8Array(BLOCK_SIZE);
  writeString(block, entry.name, 0, 100);
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
