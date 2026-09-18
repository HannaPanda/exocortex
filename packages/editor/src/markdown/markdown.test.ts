import { describe, expect, it } from 'vitest';

import { BLOCK_ID_ATTRIBUTE } from '../block-id';
import {
  EXOCORTEX_SCHEMA_VERSION,
  type ProseMirrorDocument,
  type ProseMirrorNode,
} from '../contract';
import {
  BLOCK_ID_MARKDOWN,
  CALLOUT_MARKDOWN,
  KITCHEN_SINK_MARKDOWN,
  MARKDOWN_FIXTURES,
  TABLE_MARKDOWN,
  TASK_LIST_MARKDOWN,
} from '../fixtures';
import { collectBlockIds, findDuplicateBlockIds, serializePlainText } from '../plain-text';
import { validateProseMirrorDocument } from '../schema';

import { parseFrontmatter, serializeFrontmatter } from './frontmatter';
import { parseMarkdown } from './parse';
import { serializeMarkdown } from './serialize';

/** Strips block identifiers so two parses can be compared structurally. */
function withoutBlockIds(node: ProseMirrorNode): ProseMirrorNode {
  const attrs = { ...(node.attrs ?? {}) };
  delete attrs[BLOCK_ID_ATTRIBUTE];
  const result: ProseMirrorNode = { type: node.type };
  if (Object.keys(attrs).length > 0) result.attrs = attrs;
  if (node.text !== undefined) result.text = node.text;
  if (node.marks !== undefined) result.marks = node.marks;
  if (node.content !== undefined) result.content = node.content.map(withoutBlockIds);
  return result;
}

function roundTrip(markdown: string): { first: ProseMirrorDocument; second: ProseMirrorDocument } {
  const first = parseMarkdown(markdown).document;
  const exported = serializeMarkdown(first);
  const second = parseMarkdown(exported).document;
  return { first, second };
}

describe('frontmatter', () => {
  it('separates frontmatter from the body', () => {
    const { frontmatter, body } = parseFrontmatter(KITCHEN_SINK_MARKDOWN);
    expect(frontmatter.title).toBe('Vollständiges Beispiel');
    expect(frontmatter.icon).toBe('🧠');
    expect(body.startsWith('# Vollständiges Beispiel')).toBe(true);
  });

  it('preserves unknown properties', () => {
    const { frontmatter } = parseFrontmatter(KITCHEN_SINK_MARKDOWN);
    expect(frontmatter.unknown.customProperty).toBe('bleibt erhalten');
    expect(frontmatter.unknown.tags).toEqual(['beispiel', 'markdown']);

    const serialized = serializeFrontmatter(frontmatter);
    expect(serialized).toContain('customProperty: bleibt erhalten');
    expect(serialized).toContain('- beispiel');
  });

  it('handles documents without frontmatter', () => {
    const { frontmatter, body } = parseFrontmatter('# Ohne Frontmatter\n');
    expect(frontmatter.unknown).toEqual({});
    expect(body).toBe('# Ohne Frontmatter\n');
  });

  it('serializes deterministically', () => {
    const { frontmatter } = parseFrontmatter(KITCHEN_SINK_MARKDOWN);
    expect(serializeFrontmatter(frontmatter)).toBe(serializeFrontmatter(frontmatter));
  });

  it('carries the page cover, which is metadata and not a block', () => {
    const source = '---\ntitle: Mit Bild\ncover: att1234567\ncoverPosition: 12.5\n---\n\nText.\n';
    const { frontmatter } = parseFrontmatter(source);

    expect(frontmatter.cover).toBe('att1234567');
    expect(frontmatter.coverPosition).toBe(12.5);
    // No stray `cover:` line in the body: it never reaches it.
    expect(serializeFrontmatter(frontmatter)).toContain('cover: att1234567');
  });

  it('clamps a crop that claims to be outside the image', () => {
    const { frontmatter } = parseFrontmatter('---\ncoverPosition: 420\n---\n\nText.\n');
    expect(frontmatter.coverPosition).toBe(100);
  });
});

describe('markdown import', () => {
  it('produces a schema-valid document for every fixture', () => {
    for (const [name, markdown] of Object.entries(MARKDOWN_FIXTURES)) {
      const { document } = parseMarkdown(markdown);
      const validation = validateProseMirrorDocument(document);
      expect(validation.error ?? `${name}: ok`).toBe(`${name}: ok`);
      expect(validation.valid).toBe(true);
    }
  });

  it('keeps inline code exclusive instead of emitting a set the schema rejects', () => {
    // markdown-it reports these as an emphasis token wrapped around a code
    // token. Concatenating the marks produced `bold,code`, which `Node.check()`
    // refuses -- and since `markdownToYjsState` validates before building, one
    // such snippet used to make a whole imported note fail.
    const cases = [
      'Ein **`fetter Code`** Test.\n',
      'Ein *`kursiver Code`* Test.\n',
      'Ein [**`x`**](https://example.de) Test.\n',
    ];

    for (const markdown of cases) {
      const { document } = parseMarkdown(markdown);
      const validation = validateProseMirrorDocument(document);
      expect(validation.error ?? `${markdown.trim()}: ok`).toBe(`${markdown.trim()}: ok`);

      const paragraph = document.content?.[0];
      const codeNode = paragraph?.content?.find((child) =>
        (child.marks ?? []).some((mark) => mark.type === 'code'),
      );
      expect(codeNode?.marks).toEqual([{ type: 'code' }]);
    }
  });

  it('still combines marks that do not exclude each other', () => {
    const { document } = parseMarkdown('Ein [**fetter Link**](https://example.de).\n');
    const linked = document.content?.[0]?.content?.find((child) =>
      (child.marks ?? []).some((mark) => mark.type === 'link'),
    );

    expect((linked?.marks ?? []).map((mark) => mark.type).sort()).toEqual(['bold', 'link']);
  });

  it('assigns a unique block id to every addressable block', () => {
    const { document } = parseMarkdown(KITCHEN_SINK_MARKDOWN);
    const ids = collectBlockIds(document);
    expect(ids.length).toBeGreaterThan(10);
    expect(findDuplicateBlockIds(document)).toEqual([]);
  });

  it('imports task lists with their checked state', () => {
    const { document } = parseMarkdown(TASK_LIST_MARKDOWN);
    const list = document.content?.[0];
    expect(list?.type).toBe('taskList');
    expect(list?.content?.[0]?.attrs?.checked).toBe(true);
    expect(list?.content?.[1]?.attrs?.checked).toBe(false);
    expect(serializePlainText(document)).toContain('Noch offen');
  });

  it('imports callouts with variant and title', () => {
    const { document } = parseMarkdown(CALLOUT_MARKDOWN);
    const callout = document.content?.[0];
    expect(callout?.type).toBe('callout');
    expect(callout?.attrs?.variant).toBe('info');
    expect(callout?.attrs?.title).toBe('Wichtig');
    expect(serializePlainText(document)).toContain('Erste Zeile.');
  });

  it('imports a normal blockquote as a blockquote', () => {
    const { document } = parseMarkdown('> Nur ein Zitat.\n');
    expect(document.content?.[0]?.type).toBe('blockquote');
  });

  it('imports tables into rows and cells', () => {
    const { document } = parseMarkdown(TABLE_MARKDOWN);
    const table = document.content?.[0];
    expect(table?.type).toBe('table');
    expect(table?.content?.[0]?.content?.[0]?.type).toBe('tableHeader');
    expect(table?.content?.[1]?.content?.[0]?.type).toBe('tableCell');
  });

  it('imports wiki links as link marks with the wiki scheme', () => {
    const { document } = parseMarkdown('Siehe [[Andere Seite]] und [[Ziel|Label]].\n');
    const marks = (document.content?.[0]?.content ?? []).flatMap((node) => node.marks ?? []);
    const hrefs = marks.map((mark) => mark.attrs?.href);
    expect(hrefs).toContain('wiki:Andere Seite');
    expect(hrefs).toContain('wiki:Ziel');
  });

  it('derives the title from frontmatter, then from the first heading', () => {
    expect(parseMarkdown(KITCHEN_SINK_MARKDOWN).title).toBe('Vollständiges Beispiel');
    expect(parseMarkdown('# Nur Heading\n\nText.\n').title).toBe('Nur Heading');
    expect(parseMarkdown('Kein Heading.\n').title).toBeNull();
  });

  it('never returns an empty document', () => {
    const { document } = parseMarkdown('');
    expect(document.content).toHaveLength(1);
    expect(validateProseMirrorDocument(document).valid).toBe(true);
  });

  it('gives an empty list item the paragraph the schema demands', () => {
    // Issue #82. A line that is only `-` is a list with one empty item, and
    // people write it: in prose it is a scene break or a dash that went wrong.
    // It used to produce `listItem` without children, which `Node.check()`
    // refuses -- so a single character rejected an entire write.
    const cases = [
      '-\n',
      '- eins\n-\n- drei\n',
      '- eins\n-  \n- drei\n',
      '1. eins\n2.\n3. drei\n',
      '* eins\n*\n* drei\n',
      '- eins\n  -\n- drei\n',
      '> \n',
      '| a | b |\n| --- | --- |\n|  |  |\n',
    ];

    for (const markdown of cases) {
      const { document } = parseMarkdown(markdown);
      const validation = validateProseMirrorDocument(document);
      expect(validation.error ?? `${JSON.stringify(markdown)}: ok`).toBe(
        `${JSON.stringify(markdown)}: ok`,
      );
    }

    const { document } = parseMarkdown('-\n');
    expect(document.content?.[0]?.content?.[0]?.content?.[0]?.type).toBe('paragraph');
  });
});

describe('markdown export', () => {
  it('is deterministic', () => {
    const { document } = parseMarkdown(KITCHEN_SINK_MARKDOWN);
    expect(serializeMarkdown(document)).toBe(serializeMarkdown(document));
  });

  it('writes frontmatter including preserved unknown keys', () => {
    const parsed = parseMarkdown(KITCHEN_SINK_MARKDOWN);
    const markdown = serializeMarkdown(parsed.document, { frontmatter: parsed.frontmatter });
    expect(markdown.startsWith('---\n')).toBe(true);
    expect(markdown).toContain('title: Vollständiges Beispiel');
    expect(markdown).toContain('customProperty: bleibt erhalten');
    expect(markdown).toContain(`exocortexSchemaVersion: ${EXOCORTEX_SCHEMA_VERSION}`);
  });

  it('re-emits callouts using the eXocortex syntax', () => {
    const { document } = parseMarkdown(CALLOUT_MARKDOWN);
    expect(serializeMarkdown(document)).toContain('> [!info] Wichtig');
  });

  it('re-emits task list markers', () => {
    const { document } = parseMarkdown(TASK_LIST_MARKDOWN);
    const markdown = serializeMarkdown(document);
    expect(markdown).toContain('- [x] Fertig');
    expect(markdown).toContain('- [ ] Noch offen');
  });

  it('re-emits wiki links in wiki syntax', () => {
    const { document } = parseMarkdown('Siehe [[Andere Seite]] und [[Ziel|Label]].\n');
    const markdown = serializeMarkdown(document);
    expect(markdown).toContain('[[Andere Seite]]');
    expect(markdown).toContain('[[Ziel|Label]]');
  });

  it('re-emits GFM tables', () => {
    const { document } = parseMarkdown(TABLE_MARKDOWN);
    const markdown = serializeMarkdown(document);
    expect(markdown).toContain('| Kopf 1 | Kopf 2 |');
    expect(markdown).toContain('| --- | --- |');
  });
});

describe('markdown round trip', () => {
  it('preserves semantic content for every fixture', () => {
    for (const [name, markdown] of Object.entries(MARKDOWN_FIXTURES)) {
      const { first, second } = roundTrip(markdown);
      expect(withoutBlockIds(second), `fixture ${name} changed on round trip`).toEqual(
        withoutBlockIds(first),
      );
    }
  });

  /**
   * The page that found this read „*Text nach *[[Ziel]]*.*“: a wiki link owns
   * its whole span, so the emphasis around it was closed right after a space.
   * Markdown does not accept a closer there, the run reopened somewhere else,
   * and the text came back carrying `italic` twice -- which the schema refuses,
   * so the page could not be written back at all.
   */
  it('closes emphasis around a wiki link without leaving a space in front of it', () => {
    const document: ProseMirrorDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Rezepte sind umgezogen nach ', marks: [{ type: 'italic' }] },
            {
              type: 'text',
              text: 'Kochen und Backen',
              marks: [
                { type: 'italic' },
                { type: 'link', attrs: { href: 'wiki:Kochen und Backen' } },
              ],
            },
            { type: 'text', text: '.', marks: [{ type: 'italic' }] },
          ],
        },
      ],
    };

    const markdown = serializeMarkdown(document);
    expect(markdown).toContain('*Rezepte sind umgezogen nach* [[Kochen und Backen]]');
    expect(() => parseMarkdown(markdown)).not.toThrow();
    const marks = parseMarkdown(markdown).document.content?.[0]?.content?.map((child) =>
      (child.marks ?? []).map((mark) => mark.type).join(','),
    );
    expect(marks?.every((entry) => entry !== 'italic,italic')).toBe(true);
  });

  it('is stable across a second round trip', () => {
    const once = serializeMarkdown(parseMarkdown(KITCHEN_SINK_MARKDOWN).document);
    const twice = serializeMarkdown(parseMarkdown(once).document);
    expect(twice).toBe(once);
  });

  it('preserves the plain-text projection', () => {
    const { first, second } = roundTrip(KITCHEN_SINK_MARKDOWN);
    expect(serializePlainText(second)).toBe(serializePlainText(first));
  });

  it('preserves block ids when they are included in the export', () => {
    const { document } = parseMarkdown(BLOCK_ID_MARKDOWN);
    const idsBefore = collectBlockIds(document);
    expect(idsBefore).toContain('aaaaaaaaaaaa');
    expect(idsBefore).toContain('bbbbbbbbbbbb');
    expect(idsBefore).toContain('cccccccccccc');

    const exported = serializeMarkdown(document, { includeBlockIds: true });
    const reimported = parseMarkdown(exported).document;
    for (const id of ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc']) {
      expect(collectBlockIds(reimported)).toContain(id);
    }
    expect(findDuplicateBlockIds(reimported)).toEqual([]);
  });

  it('does not leak block ids into a normal export', () => {
    const { document } = parseMarkdown(BLOCK_ID_MARKDOWN);
    expect(serializeMarkdown(document)).not.toContain('^aaaaaaaaaaaa');
  });

  it('keeps nested lists nested', () => {
    const { first, second } = roundTrip(MARKDOWN_FIXTURES.nestedList);
    expect(withoutBlockIds(second)).toEqual(withoutBlockIds(first));
    const level2 = first.content?.[0]?.content?.[0]?.content?.[1];
    expect(level2?.type).toBe('bulletList');
  });

  it('escapes characters that would otherwise be Markdown syntax', () => {
    const source = 'Ein *Stern*, ein \\_Unterstrich\\_ und ein \\[Klammerpaar\\].\n';
    const { document } = parseMarkdown(source);
    const text = serializePlainText(document);
    const reimported = parseMarkdown(serializeMarkdown(document)).document;
    expect(serializePlainText(reimported)).toBe(text);
  });
});
