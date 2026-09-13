import { describe, expect, it } from 'vitest';

import { createTar, readTar } from './tar';

/**
 * The archive both build runners speak through (issue #44 and issue #43).
 *
 * Worth its own test because nothing else notices when it is wrong: a header
 * field off by one byte produces an archive `tar` reads as empty, and the
 * failure surfaces as a build that compiled nothing with no explanation.
 */

function entry(name: string, content: string) {
  return { name, content: Buffer.from(content, 'utf8') };
}

describe('tar', () => {
  it('round-trips what was packed', () => {
    const archive = createTar([entry('main.tex', 'hallo'), entry('a/b.tex', 'welt')]);

    const read = readTar(archive);
    expect(read.map((file) => file.name)).toEqual(['main.tex', 'a/b.tex']);
    expect(Buffer.from(read[1]?.content ?? []).toString('utf8')).toBe('welt');
  });

  it('carries a path longer than the 99 bytes the name field holds', () => {
    const deep = `${'kapitel/'.repeat(12)}auswertung.tex`;
    expect(deep.length).toBeGreaterThan(99);

    const read = readTar(createTar([entry(deep, 'x')]));
    expect(read[0]?.name).toBe(deep);
  });

  it('pads every entry to a block boundary', () => {
    // 512-byte header, 512-byte padded content, two 512-byte end blocks.
    expect(createTar([entry('a.txt', 'x')]).length).toBe(512 * 4);
  });

  it('keeps content that is exactly one block long', () => {
    const content = 'x'.repeat(512);

    const read = readTar(createTar([entry('a.txt', content)]));
    expect(Buffer.from(read[0]?.content ?? []).toString('utf8')).toBe(content);
  });

  it('reads nothing out of an empty archive', () => {
    expect(readTar(createTar([]))).toEqual([]);
  });

  it('writes a checksum a reader can verify', () => {
    const archive = createTar([entry('a.txt', 'x')]);
    const header = archive.subarray(0, 512);
    const stated = Number.parseInt(header.subarray(148, 156).toString('utf8').trim(), 8);

    let computed = 0;
    for (let index = 0; index < 512; index += 1) {
      computed += index >= 148 && index < 156 ? 0x20 : (header[index] as number);
    }
    expect(stated).toBe(computed);
  });
});
