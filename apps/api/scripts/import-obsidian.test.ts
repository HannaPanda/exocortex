import { describe, expect, it } from 'vitest';

import { type Frontmatter, markdownToYjsState, yjsStateToMarkdown } from '@exocortex/editor';

import {
  buildBasenameIndex,
  buildTitleIndex,
  comparePath,
  extractTitle,
  normalizeWikiTarget,
  renderFrontmatterHeader,
  rewriteWikilinks,
  type VaultNote,
} from './import-obsidian';

function note(relativePath: string, raw = ''): VaultNote {
  const segments = relativePath.split('/');
  const filename = segments[segments.length - 1] as string;
  return {
    relativePath,
    folders: segments.slice(0, -1),
    basename: filename.replace(/\.md$/, ''),
    raw,
  };
}

function emptyFrontmatter(unknown: Record<string, unknown> = {}): Frontmatter {
  return { unknown };
}

describe('comparePath', () => {
  it('orders strings deterministically', () => {
    const paths = ['b.md', 'a.md', 'Kreativ/z.md', 'Kreativ/a.md'];
    const sorted = [...paths].sort(comparePath);
    expect(sorted).toEqual(['Kreativ/a.md', 'Kreativ/z.md', 'a.md', 'b.md']);
  });
});

describe('normalizeWikiTarget', () => {
  it('lower-cases, trims, collapses whitespace and strips a leading ./', () => {
    expect(normalizeWikiTarget('  Andere   Seite  ')).toBe('andere seite');
    expect(normalizeWikiTarget('./Ziel')).toBe('ziel');
    expect(normalizeWikiTarget('ZIEL')).toBe('ziel');
  });
});

describe('buildBasenameIndex', () => {
  it('maps a unique basename directly', () => {
    const notes = [note('Technik/Skyvern.md'), note('Gaming/Elden Ring.md')];
    const { byBasename, ambiguousBasenames } = buildBasenameIndex(notes);
    expect(byBasename.get('skyvern')).toBe('Technik/Skyvern.md');
    expect(byBasename.get('elden ring')).toBe('Gaming/Elden Ring.md');
    expect(ambiguousBasenames.size).toBe(0);
  });

  it('resolves a duplicate basename to the shortest relativePath and records the rest', () => {
    const notes = [
      note('Kreativ/Rezepte/Snacks/Cookies.md'),
      note('Cookies.md'),
      note('Medien/Cookies.md'),
    ];
    const { byBasename, ambiguousBasenames } = buildBasenameIndex(notes);
    expect(byBasename.get('cookies')).toBe('Cookies.md');
    expect(ambiguousBasenames.get('cookies')).toEqual(
      ['Cookies.md', 'Kreativ/Rezepte/Snacks/Cookies.md', 'Medien/Cookies.md'].sort(comparePath),
    );
  });
});

describe('extractTitle', () => {
  it('prefers frontmatter title', () => {
    const raw = '---\ntitle: "Aus Frontmatter"\n---\n\n# Aus Heading\n\nText.\n';
    expect(extractTitle(raw, 'basename')).toBe('Aus Frontmatter');
  });

  it('falls back to the first heading when there is no frontmatter title', () => {
    const raw = '# Aus Heading\n\nText.\n';
    expect(extractTitle(raw, 'basename')).toBe('Aus Heading');
  });

  it('falls back to the basename when there is neither', () => {
    const raw = 'Nur Text, kein Heading.\n';
    expect(extractTitle(raw, 'Mein Dateiname')).toBe('Mein Dateiname');
  });

  it('never throws on malformed frontmatter', () => {
    const raw = '---\ntitle: ["unterminated\n---\n\nText.\n';
    expect(extractTitle(raw, 'Fallback')).toBe('Fallback');
  });
});

describe('buildTitleIndex', () => {
  it('assigns the plain title when there is no collision', () => {
    const notes = [
      note('Technik/Skyvern.md', '# Skyvern\n'),
      note('Gaming/Elden Ring.md', '# Elden Ring\n'),
    ];
    const titleOf = buildTitleIndex(notes);
    expect(titleOf.get('Technik/Skyvern.md')).toBe('Skyvern');
    expect(titleOf.get('Gaming/Elden Ring.md')).toBe('Elden Ring');
  });

  it('disambiguates two different notes that extract the same title in the same folder', () => {
    // Real case from the vault: two independently saved bookmarks under
    // "Gaming" whose first heading is identical text, but the files (and their
    // content) are different.
    const notes = [
      note(
        'Gaming/RP-0 Realistic Progression Zero Kerbal.md',
        '# RP-0 Realistic Progression Zero\n',
      ),
      note('Gaming/RP-0 Realistic Progression Zero.md', '# RP-0 Realistic Progression Zero\n'),
    ];
    const titleOf = buildTitleIndex(notes);
    // Sorted by relativePath: "...Kerbal.md" < "...Zero.md" (byte order).
    expect(titleOf.get('Gaming/RP-0 Realistic Progression Zero Kerbal.md')).toBe(
      'RP-0 Realistic Progression Zero',
    );
    expect(titleOf.get('Gaming/RP-0 Realistic Progression Zero.md')).toBe(
      'RP-0 Realistic Progression Zero (2)',
    );
    // Both titles must be unique so the (workspaceId, parentId, title)
    // identity never collapses the two notes into one document.
    const titles = [...titleOf.values()];
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('does not disambiguate the same title across different folders', () => {
    const notes = [note('A/Setup.md', '# Setup\n'), note('B/Setup.md', '# Setup\n')];
    const titleOf = buildTitleIndex(notes);
    expect(titleOf.get('A/Setup.md')).toBe('Setup');
    expect(titleOf.get('B/Setup.md')).toBe('Setup');
  });
});

describe('renderFrontmatterHeader', () => {
  it('renders the bookmark shape', () => {
    const frontmatter = emptyFrontmatter({
      source_url: 'https://example.com/article',
      saved_at: '2026-05-14T13:05:57.814Z',
      domain: 'unrelated-domain-marker.test',
      folder: 'AI & Tools',
      review_due: '2026-05-28',
      tags: ['Musikvideo', 'TX2'],
    });
    const header = renderFrontmatterHeader(frontmatter);
    expect(header).toContain('> [!info] Details');
    expect(header).toContain('**Quelle:** https://example.com/article');
    expect(header).toContain('**Gespeichert:** 2026-05-14T13:05:57.814Z');
    expect(header).toContain('**Tags:** #Musikvideo #TX2');
    // Fields the brief does not ask to render: not part of the visible page.
    expect(header).not.toContain('unrelated-domain-marker.test');
    expect(header).not.toContain('2026-05-28');
  });

  it('renders the recipe shape', () => {
    const frontmatter = emptyFrontmatter({
      quelle: 'https://www.einfachmalene.de/triple-chocolate-cookies',
      portionen: '20 Stück',
      notiert: '2026-06-10',
    });
    const header = renderFrontmatterHeader(frontmatter);
    expect(header).toContain('**Quelle:** https://www.einfachmalene.de/triple-chocolate-cookies');
    expect(header).toContain('**Portionen:** 20 Stück');
    expect(header).not.toContain('2026-06-10');
  });

  it('renders nothing for empty frontmatter', () => {
    expect(renderFrontmatterHeader(emptyFrontmatter())).toBe('');
  });
});

describe('rewriteWikilinks', () => {
  const byBasename = new Map<string, string>([
    ['a', 'Ordner/A.md'],
    ['b', 'B.md'],
  ]);
  const titleOf = new Map<string, string>([
    ['Ordner/A.md', 'A'],
    ['B.md', 'Titel B'],
  ]);

  it('rewrites a plain resolved link to the native wiki syntax', () => {
    const result = rewriteWikilinks('Siehe [[A]] hier.', byBasename, titleOf);
    expect(result.text).toBe('Siehe [[A]] hier.');
    expect(result.resolved).toBe(1);
    expect(result.totalFound).toBe(1);
    expect(result.unresolvedTargets).toEqual([]);
  });

  it('rewrites an alias link, using the label when it differs from the title', () => {
    const result = rewriteWikilinks('Siehe [[B|Mein Label]] hier.', byBasename, titleOf);
    expect(result.text).toBe('Siehe [[Titel B|Mein Label]] hier.');
    expect(result.resolved).toBe(1);
  });

  it('turns an unresolved link into plain text, never a broken link', () => {
    const result = rewriteWikilinks('Siehe [[Nope]] hier.', byBasename, titleOf);
    expect(result.text).toBe('Siehe Nope hier.');
    expect(result.resolved).toBe(0);
    expect(result.unresolvedTargets).toEqual(['Nope']);
    expect(result.totalFound).toBe(1);
  });

  it('leaves a link inside a fenced code block untouched', () => {
    const input = 'Text davor.\n\n```\n[[A]] bleibt im Code.\n```\n\nText danach [[B]].';
    const result = rewriteWikilinks(input, byBasename, titleOf);
    expect(result.text).toContain('```\n[[A]] bleibt im Code.\n```');
    expect(result.text).toContain('[[Titel B]]');
    // Both links are still "found"; only the un-fenced one is resolved.
    expect(result.totalFound).toBe(2);
    expect(result.resolved).toBe(1);
  });

  it('leaves a link inside an inline code span untouched', () => {
    const input = 'Ein `[[A]]` Beispiel und ein echter [[B]] Link.';
    const result = rewriteWikilinks(input, byBasename, titleOf);
    expect(result.text).toContain('`[[A]]`');
    expect(result.text).toContain('[[Titel B]]');
    expect(result.totalFound).toBe(2);
    expect(result.resolved).toBe(1);
  });

  it('rewrites two links on one line independently', () => {
    const result = rewriteWikilinks('[[A]] und [[Nope]] und [[B]].', byBasename, titleOf);
    expect(result.text).toBe('[[A]] und Nope und [[Titel B]].');
    expect(result.totalFound).toBe(3);
    expect(result.resolved).toBe(2);
    expect(result.unresolvedTargets).toEqual(['Nope']);
  });

  it('resolves a folder-qualified target by its last path segment (Obsidian accepts both forms)', () => {
    const result = rewriteWikilinks('Siehe [[Ordner/A]] hier.', byBasename, titleOf);
    expect(result.text).toBe('Siehe [[A]] hier.');
    expect(result.resolved).toBe(1);
    expect(result.unresolvedTargets).toEqual([]);
  });
});

describe('round trip through the real editor pipeline', () => {
  it('markdownToYjsState -> yjsStateToMarkdown preserves the wiki link', () => {
    const byBasename = new Map<string, string>([
      ['ziel mit leerzeichen', 'Ziel mit Leerzeichen.md'],
    ]);
    const titleOf = new Map<string, string>([['Ziel mit Leerzeichen.md', 'Ziel mit Leerzeichen']]);

    const rewritten = rewriteWikilinks(
      'Ein Verweis auf [[Ziel mit Leerzeichen|Mein Label]].',
      byBasename,
      titleOf,
    );
    expect(rewritten.resolved).toBe(1);

    const imported = markdownToYjsState(rewritten.text);
    const wikiMark = imported.proseMirrorJson.content
      ?.flatMap((block) => block.content ?? [])
      .flatMap((node) => node.marks ?? [])
      .find((mark) => typeof mark.attrs?.href === 'string' && mark.attrs.href.startsWith('wiki:'));
    expect(wikiMark?.attrs?.href).toBe('wiki:Ziel mit Leerzeichen');

    const exported = yjsStateToMarkdown(imported.yjsState);
    expect(exported).toContain('[[Ziel mit Leerzeichen|Mein Label]]');
  });
});
