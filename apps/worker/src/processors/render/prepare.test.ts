import { describe, expect, it } from 'vitest';

import {
  bindAssetName,
  buildMetadataYaml,
  collectAttachmentImages,
  dropAsset,
  flattenWikiLinks,
} from './prepare';
import { createTar } from './tar';

/**
 * Everything that happens to a document before it reaches the container
 * (issue #44, ADR-026).
 *
 * All of it is pure, and all of it is the kind of thing that fails silently:
 * a wiki link printed with its brackets, an image pointing at a URL no
 * container can reach, a YAML file that a quotation mark cut in half.
 */

describe('collectAttachmentImages', () => {
  it('rewrites an attachment image to a local name and reports the id', () => {
    const result = collectAttachmentImages(
      'Text\n\n![Ein Bild](/api/attachments/abc123def456/download)\n',
    );
    expect(result.markdown).toContain('![Ein Bild](assets/abc123def456)');
    expect(result.attachmentIds).toEqual(['abc123def456']);
  });

  it('reports an id once even when the page shows the picture twice', () => {
    const result = collectAttachmentImages(
      '![a](/api/attachments/abc123def456/download)\n![b](/api/attachments/abc123def456/download)\n',
    );
    expect(result.attachmentIds).toEqual(['abc123def456']);
  });

  it('leaves an external image alone', () => {
    const markdown = '![extern](https://example.org/bild.png)\n';
    expect(collectAttachmentImages(markdown).markdown).toBe(markdown);
  });

  it('survives the query string a preview variant adds', () => {
    const result = collectAttachmentImages(
      '![a](/api/attachments/abc123def456/download?variant=preview)\n',
    );
    expect(result.markdown).toContain('](assets/abc123def456)');
  });
});

describe('bindAssetName and dropAsset', () => {
  it('points the image at the file the archive carries', () => {
    const bound = bindAssetName('![a](assets/abc123)\n', 'abc123', 'abc123.png');
    expect(bound).toBe('![a](assets/abc123.png)\n');
  });

  it('keeps the alt text of a picture that could not be fetched', () => {
    expect(dropAsset('Vorher ![Das Diagramm](assets/abc123) nachher\n', 'abc123')).toBe(
      'Vorher _[Das Diagramm]_ nachher\n',
    );
  });

  it('removes an unfetchable picture that had nothing to say', () => {
    expect(dropAsset('![](assets/abc123)\n', 'abc123')).toBe('\n');
  });
});

describe('flattenWikiLinks', () => {
  it('prints the target of a bare wiki link', () => {
    expect(flattenWikiLinks('Siehe [[Architektur]].')).toBe('Siehe Architektur.');
  });

  it('prefers the label when the link carries one', () => {
    expect(flattenWikiLinks('Siehe [[Architektur|dort]].')).toBe('Siehe dort.');
  });

  it('flattens the mention form too', () => {
    expect(flattenWikiLinks('@[[Johanna]] hat das geschrieben')).toBe(
      'Johanna hat das geschrieben',
    );
  });
});

describe('buildMetadataYaml', () => {
  it('writes the keys Pandoc templates expect', () => {
    const yaml = buildMetadataYaml({
      title: 'Bericht',
      date: '2026-09-13',
      author: 'Johanna',
      variables: {},
    });
    expect(yaml).toContain('title: "Bericht"');
    expect(yaml).toContain('date: "2026-09-13"');
    expect(yaml).toContain('author: "Johanna"');
    expect(yaml).toContain('lang: "de-DE"');
  });

  it('leaves the author out rather than writing an empty one', () => {
    const yaml = buildMetadataYaml({ title: 'T', date: 'd', author: '', variables: {} });
    expect(yaml).not.toContain('author:');
  });

  it('escapes a quotation mark instead of ending the string', () => {
    const yaml = buildMetadataYaml({
      title: 'Der "Bericht"',
      date: 'd',
      author: '',
      variables: { note: 'a\\b\nc' },
    });
    expect(yaml).toContain('title: "Der \\"Bericht\\""');
    expect(yaml).toContain('note: "a\\\\b\\nc"');
    // One line per key: a raw newline in a value would make the next line a key.
    expect(yaml.trim().split('\n')).toHaveLength(4);
  });

  it('lets a declared variable override the title a template prints', () => {
    const yaml = buildMetadataYaml({
      title: 'Seitentitel',
      date: 'd',
      author: '',
      variables: { title: 'Eigener Titel' },
    });
    expect(yaml).toContain('title: "Eigener Titel"');
    expect(yaml).not.toContain('title: "Seitentitel"');
  });
});

describe('createTar', () => {
  it('writes a ustar header tar itself recognises', () => {
    const archive = createTar([{ name: 'input.md', content: Buffer.from('# Titel\n', 'utf8') }]);

    expect(archive.subarray(0, 8).toString('utf8')).toBe('input.md');
    expect(archive.subarray(257, 262).toString('utf8')).toBe('ustar');
    // Size field, octal, NUL-terminated: eight bytes for "# Titel\n".
    expect(archive.subarray(124, 135).toString('utf8')).toBe('00000000010');
    // Header, one content block, two terminator blocks.
    expect(archive.length).toBe(512 * 4);
  });

  it('pads every entry to a block boundary', () => {
    const archive = createTar([
      { name: 'a.txt', content: Buffer.alloc(513, 0x61) },
      { name: 'b.txt', content: Buffer.from('b') },
    ]);
    // (header + 2 blocks) + (header + 1 block) + 2 terminator blocks.
    expect(archive.length).toBe(512 * 7);
  });

  it('computes a checksum over the header with the field blanked', () => {
    const archive = createTar([{ name: 'x', content: Buffer.alloc(0) }]);
    const header = archive.subarray(0, 512);
    const stated = Number.parseInt(header.subarray(148, 154).toString('utf8'), 8);

    const blanked = Buffer.from(header);
    blanked.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of blanked) sum += byte;
    expect(stated).toBe(sum);
  });

  it('refuses a name that does not fit rather than writing a corrupt header', () => {
    expect(() => createTar([{ name: 'a'.repeat(120), content: Buffer.from('x') }])).toThrow();
  });
});
