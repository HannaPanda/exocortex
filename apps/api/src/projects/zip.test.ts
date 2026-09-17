import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { createZip, readZip, ZipError } from './zip';

/**
 * The reader and the writer, against each other and against archives this code
 * did not write (issue #54).
 *
 * The round trip is the cheap half. What actually matters is the second group:
 * an archive is foreign input, and every one of those cases is a shape a real
 * `zip` produces or a real attacker sends.
 */

const LIMIT = 8 * 1024 * 1024;

function read(archive: Buffer) {
  return readZip(archive, { maxTotalBytes: LIMIT });
}

describe('createZip and readZip', () => {
  it('returns what went in', () => {
    const entries = [
      { name: 'main.tex', content: Buffer.from('\\documentclass{article}', 'utf8') },
      { name: 'kapitel/intro.tex', content: Buffer.from('Hallo Welt', 'utf8') },
      { name: 'bilder/plot.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]) },
    ];

    const result = read(createZip(entries));

    expect(result.skipped).toEqual([]);
    expect(result.entries.map((entry) => entry.name)).toEqual([
      'main.tex',
      'kapitel/intro.tex',
      'bilder/plot.png',
    ]);
    for (const [index, entry] of result.entries.entries()) {
      expect(entry.content.equals(entries[index]?.content as Buffer)).toBe(true);
    }
  });

  it('survives an empty file and a long path', () => {
    const long = `${'ordner/'.repeat(20)}datei.tex`;
    const result = read(
      createZip([
        { name: 'leer.tex', content: Buffer.alloc(0) },
        { name: long, content: Buffer.from('x') },
      ]),
    );

    expect(result.entries.map((entry) => entry.name)).toEqual(['leer.tex', long]);
    expect(result.entries[0]?.content.byteLength).toBe(0);
  });

  it('keeps non-ASCII names', () => {
    const result = read(createZip([{ name: 'kapitel/Übersicht.tex', content: Buffer.from('ä') }]));
    expect(result.entries[0]?.name).toBe('kapitel/Übersicht.tex');
  });

  it('writes the same bytes twice for the same input', () => {
    const entries = [{ name: 'main.tex', content: Buffer.from('gleich') }];
    expect(createZip(entries).equals(createZip(entries))).toBe(true);
  });

  it('stores rather than deflates when deflating would grow the file', () => {
    // Random bytes do not compress; the writer must not make the archive bigger
    // than the data it holds.
    const noise = Buffer.from(Array.from({ length: 2048 }, (_, index) => (index * 37) % 251));
    const archive = createZip([{ name: 'rauschen.bin', content: noise }]);
    expect(archive.byteLength).toBeLessThan(noise.byteLength + 256);
    expect(read(archive).entries[0]?.content.equals(noise)).toBe(true);
  });
});

describe('readZip on foreign archives', () => {
  it('refuses something that is not an archive at all', () => {
    expect(() => read(Buffer.from('nicht einmal in der Nähe'))).toThrow(ZipError);
  });

  it('skips a directory entry rather than reporting it', () => {
    const archive = withDirectoryEntry();
    const result = read(archive);
    expect(result.entries.map((entry) => entry.name)).toEqual(['ordner/datei.tex']);
    expect(result.skipped).toEqual([]);
  });

  it('names an encrypted entry instead of dropping it', () => {
    const archive = createZip([{ name: 'geheim.tex', content: Buffer.from('x') }]);
    // Set bit 0 of the general purpose flags in both headers.
    setFlag(archive, 0x0001);
    const result = read(archive);
    expect(result.entries).toEqual([]);
    expect(result.skipped).toEqual([{ name: 'geheim.tex', reason: 'encrypted' }]);
  });

  it('names an entry packed with a method it does not read', () => {
    const archive = createZip([{ name: 'bzip.tex', content: Buffer.from('x'.repeat(200)) }]);
    setMethod(archive, 12);
    expect(read(archive).skipped).toEqual([{ name: 'bzip.tex', reason: 'unsupported_method' }]);
  });

  it('refuses a bomb before inflating it', () => {
    // A central directory that claims a gigabyte, so the refusal has to come
    // from the claim rather than from the memory it would take to disprove it.
    const zeros = Buffer.alloc(64 * 1024);
    const archive = createZip([{ name: 'bombe.bin', content: zeros }]);
    setUncompressedSize(archive, 1024 * 1024 * 1024);
    expect(() => read(archive)).toThrow(/uncompressed bytes/);
  });

  it('stops an entry that inflates past the budget its directory promised', () => {
    // The declared size is ten bytes, the deflate stream is two hundred
    // thousand. The budget taken from the central directory cannot catch this,
    // because the central directory is what lied; `maxOutputLength` on the
    // inflate is the guard that does, and the entry is reported rather than
    // silently truncated.
    const payload = deflateRawSync(Buffer.alloc(200_000));
    const archive = handBuilt('luege.bin', payload, 10);
    const result = readZip(archive, { maxTotalBytes: 1_000 });
    expect(result.entries).toEqual([]);
    expect(result.skipped).toEqual([{ name: 'luege.bin', reason: 'corrupt' }]);
  });

  it('turns a backslash separator into a slash', () => {
    const archive = createZip([{ name: 'ordner\\datei.tex', content: Buffer.from('x') }]);
    expect(read(archive).entries[0]?.name).toBe('ordner/datei.tex');
  });
});

// ---------------------------------------------------------------------------
// Archives this code would never write
// ---------------------------------------------------------------------------

/** The offset of the one central directory header in a single-entry archive. */
function centralOffset(archive: Buffer): number {
  return archive.readUInt32LE(archive.byteLength - 6);
}

function setFlag(archive: Buffer, flag: number): void {
  archive.writeUInt16LE(archive.readUInt16LE(6) | flag, 6);
  const central = centralOffset(archive);
  archive.writeUInt16LE(archive.readUInt16LE(central + 8) | flag, central + 8);
}

function setMethod(archive: Buffer, method: number): void {
  archive.writeUInt16LE(method, 8);
  archive.writeUInt16LE(method, centralOffset(archive) + 10);
}

function setUncompressedSize(archive: Buffer, size: number): void {
  archive.writeUInt32LE(size, centralOffset(archive) + 24);
}

/** A single-entry archive whose central directory says what the caller wants. */
function handBuilt(name: string, payload: Buffer, declaredSize: number): Buffer {
  const nameBytes = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30 + nameBytes.byteLength);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(payload.byteLength, 18);
  local.writeUInt32LE(declaredSize, 22);
  local.writeUInt16LE(nameBytes.byteLength, 26);
  nameBytes.copy(local, 30);

  const central = Buffer.alloc(46 + nameBytes.byteLength);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(payload.byteLength, 20);
  central.writeUInt32LE(declaredSize, 24);
  central.writeUInt16LE(nameBytes.byteLength, 28);
  central.writeUInt32LE(0, 42);
  nameBytes.copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.byteLength, 12);
  end.writeUInt32LE(local.byteLength + payload.byteLength, 16);

  return Buffer.concat([local, payload, central, end]);
}

/** What `zip` writes when it describes the folders it packed. */
function withDirectoryEntry(): Buffer {
  return createZip([
    { name: 'ordner/', content: Buffer.alloc(0) },
    { name: 'ordner/datei.tex', content: Buffer.from('x') },
  ]);
}
