import { describe, expect, it } from 'vitest';

import { parseMarkdown, serializeMarkdown } from './markdown';
import { findHeadingSections, resolvePatchEdits, resolveSectionEdit } from './page-edit';

const PAGE = parseMarkdown(
  [
    '## Stand',
    '',
    'Erster Absatz.',
    '',
    'Zweiter Absatz.',
    '',
    '## Nächstes',
    '',
    'Etwas anderes.',
  ].join('\n'),
).document;

/** The identifier of the nth top-level block, which the tests address by. */
function idAt(index: number): string {
  return (PAGE.content ?? [])[index]?.attrs?.blockId as string;
}

describe('findHeadingSections', () => {
  it('reads a section as the heading plus what is under it', () => {
    const [section] = findHeadingSections(PAGE, 'Stand');
    expect(section?.blockId).toBe(idAt(0));
    expect(section?.bodyFromBlockId).toBe(idAt(1));
    expect(section?.bodyToBlockId).toBe(idAt(2));
  });

  it('ignores case and surrounding space, because a person types from memory', () => {
    expect(findHeadingSections(PAGE, '  stand ')).toHaveLength(1);
  });

  it('stops at the next heading of the same level', () => {
    const [section] = findHeadingSections(PAGE, 'Nächstes');
    expect(section?.bodyFromBlockId).toBe(idAt(4));
    expect(section?.bodyToBlockId).toBe(idAt(4));
  });
});

describe('resolveSectionEdit', () => {
  it('replaces the body and keeps the heading, because the heading is the address', () => {
    const resolved = resolveSectionEdit(PAGE, 'Stand', 'replace');
    expect(resolved).toEqual({
      ok: true,
      value: { fromBlockId: idAt(1), toBlockId: idAt(2), placement: 'replace' },
    });
  });

  it('appends at the end of the section, not at the end of the page', () => {
    const resolved = resolveSectionEdit(PAGE, 'Stand', 'append');
    expect(resolved).toEqual({
      ok: true,
      value: { fromBlockId: idAt(2), toBlockId: null, placement: 'after' },
    });
  });

  it('prepends directly under the heading', () => {
    const resolved = resolveSectionEdit(PAGE, 'Stand', 'prepend');
    expect(resolved).toEqual({
      ok: true,
      value: { fromBlockId: idAt(0), toBlockId: null, placement: 'after' },
    });
  });

  it('writes into an empty section without needing a body to address', () => {
    const empty = parseMarkdown('## Leer\n\n## Danach\n\nText.').document;
    const resolved = resolveSectionEdit(empty, 'Leer', 'replace');
    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.value.placement).toBe('after');
  });

  it('refuses a heading that is not there', () => {
    const resolved = resolveSectionEdit(PAGE, 'Gibt es nicht', 'replace');
    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.reason).toBe('heading_not_found');
  });

  it('refuses a section whose last block carries no identifier', () => {
    // It used to cast that missing identifier to a string, which made
    // `replace` swap the section's *first* block and leave the rest standing:
    // the page came back holding its section twice.
    const page = parseMarkdown('## Stand\n\nErster Absatz.\n\nZweiter Absatz.').document;
    const last = (page.content ?? [])[2];
    if (last !== undefined) last.attrs = {};

    for (const mode of ['replace', 'append'] as const) {
      const resolved = resolveSectionEdit(page, 'Stand', mode);
      expect(resolved.ok).toBe(false);
      expect(!resolved.ok && resolved.reason).toBe('section_end_unaddressable');
    }
    // Prepending lands under the heading and never touches the end.
    expect(resolveSectionEdit(page, 'Stand', 'prepend').ok).toBe(true);
  });

  it('refuses a heading that occurs twice, and names both blocks', () => {
    const twice = parseMarkdown('## Stand\n\nA\n\n## Stand\n\nB').document;
    const resolved = resolveSectionEdit(twice, 'Stand', 'replace');
    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.count).toBe(2);
    expect(!resolved.ok && resolved.blockIds).toHaveLength(2);
  });
});

describe('resolvePatchEdits', () => {
  it('replaces a unique piece of text inside the one block that carries it', () => {
    const resolved = resolvePatchEdits(PAGE, {
      oldText: 'Erster Absatz.',
      newText: 'Erster Absatz, korrigiert.',
      replaceAll: false,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value).toHaveLength(1);
    expect(resolved.value[0]?.edit).toEqual({
      fromBlockId: idAt(1),
      toBlockId: null,
      placement: 'replace',
    });
    expect(resolved.value[0]?.markdown).toBe('Erster Absatz, korrigiert.');
  });

  it('matches against the page as exo_page_read prints it', () => {
    // A caller copies a line out of what it read, so what it read has to be
    // what is searched.
    const markdown = serializeMarkdown(PAGE);
    expect(markdown).toContain('Etwas anderes.');
    const resolved = resolvePatchEdits(PAGE, {
      oldText: 'Etwas anderes.',
      newText: 'Etwas Drittes.',
      replaceAll: false,
    });
    expect(resolved.ok).toBe(true);
  });

  it('spans the blocks a multi-line match covers', () => {
    const resolved = resolvePatchEdits(PAGE, {
      oldText: 'Erster Absatz.\n\nZweiter Absatz.',
      newText: 'Nur noch einer.',
      replaceAll: false,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value[0]?.edit).toEqual({
      fromBlockId: idAt(1),
      toBlockId: idAt(2),
      placement: 'replace',
    });
  });

  it('writes nothing when the text is not there', () => {
    const resolved = resolvePatchEdits(PAGE, {
      oldText: 'kommt nicht vor',
      newText: 'x',
      replaceAll: false,
    });
    expect(!resolved.ok && resolved.reason).toBe('patch_not_found');
  });

  it('writes nothing when the text occurs twice and replaceAll was not asked for', () => {
    const twice = parseMarkdown('Hallo\n\nHallo').document;
    const resolved = resolvePatchEdits(twice, {
      oldText: 'Hallo',
      newText: 'Moin',
      replaceAll: false,
    });
    expect(!resolved.ok && resolved.reason).toBe('patch_not_unique');
    expect(!resolved.ok && resolved.count).toBe(2);
  });

  it('replaces every occurrence when it was', () => {
    const twice = parseMarkdown('Hallo\n\nHallo').document;
    const resolved = resolvePatchEdits(twice, {
      oldText: 'Hallo',
      newText: 'Moin',
      replaceAll: true,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.map((edit) => edit.markdown)).toEqual(['Moin', 'Moin']);
  });

  it('carries two matches inside one block as one edit', () => {
    const one = parseMarkdown('Hallo und Hallo').document;
    const resolved = resolvePatchEdits(one, {
      oldText: 'Hallo',
      newText: 'Moin',
      replaceAll: true,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value).toHaveLength(1);
    expect(resolved.value[0]?.markdown).toBe('Moin und Moin');
    expect(resolved.value[0]?.replacements).toBe(2);
  });
});
