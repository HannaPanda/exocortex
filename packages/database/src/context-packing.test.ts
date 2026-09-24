import { describe, expect, it } from 'vitest';

import { chunkPlainText } from './chunking';
import {
  defaultPerSourceMaxChars,
  fusePassages,
  keywordCoverage,
  type KeywordPage,
  keywordPassageList,
  keywordTokens,
  packContext,
  type PackSource,
  type PassageCandidate,
  passagesOfPage,
  type RankedPassage,
  withoutOverlap,
} from './context-packing';

/**
 * The evaluation set of the context compiler (issue #110).
 *
 * Synthetic pages, built so each case has one answer a reader would agree
 * with, and asserted on *which* passages come back rather than on scores. The
 * two lists handed to `fusePassages` stand in for what the database returns:
 * the keyword list is built by the real `keywordPassageList` from page text,
 * the semantic list is written down, because a vector ranking is exactly the
 * part that cannot be reproduced without a model.
 *
 * The scope cases (a page-confined token, several workspaces) need the
 * database and live in the API's integration test.
 */

const UPDATED = '2026-09-20T10:00:00.000Z';

function page(documentId: string, title: string, plainText: string): KeywordPage {
  return { documentId, workspaceId: 'ws-brain', title, updatedAt: UPDATED, plainText };
}

function semanticHit(documentId: string, ordinal: number, text: string): RankedPassage {
  return {
    documentId,
    workspaceId: 'ws-brain',
    title: documentId,
    updatedAt: UPDATED,
    ordinal,
    text,
    section: { blockId: `h-${documentId}-${ordinal}`, path: ['Abschnitt'] },
    exact: false,
  };
}

function sourcesFor(candidates: readonly PassageCandidate[]): Map<string, PackSource> {
  return new Map(
    candidates.map((candidate) => [
      candidate.documentId,
      {
        documentId: candidate.documentId,
        workspaceId: candidate.workspaceId,
        workspaceName: 'Second Brain',
        title: candidate.title,
        path: [{ id: 'root', title: 'Technik' }],
        updatedAt: candidate.updatedAt,
      },
    ]),
  );
}

/** Filler prose that matches none of the questions below. */
function filler(label: string, blocks: number): string {
  return Array.from({ length: blocks }, (_, index) =>
    `${label} ${index} ${'Lorem ipsum dolor sit amet consectetur '.repeat(8)}`.trim(),
  ).join('\n');
}

function compile(
  keywordPages: readonly KeywordPage[],
  semantic: readonly RankedPassage[],
  query: string,
  maxChars = 12_000,
  maxSources = 12,
) {
  const candidates = fusePassages(
    keywordPassageList(keywordPages, keywordTokens(query)),
    semantic,
    0.5,
  );
  const result = packContext(candidates, sourcesFor(candidates), {
    maxChars,
    maxSources,
    perSourceMaxChars: defaultPerSourceMaxChars(maxChars, maxSources),
  });
  return { candidates, result };
}

describe('keyword passages', () => {
  it('judges a passage by the words of the question, prefix-matched like the full-text index', () => {
    expect(keywordTokens('Docker-Stack  docker Zertifikat')).toEqual([
      'docker',
      'stack',
      'zertifikat',
    ]);
    expect(keywordCoverage('Die Zertifikate im Dockerfile', ['docker', 'zertifikat'])).toEqual({
      distinct: 2,
      occurrences: 2,
    });
  });

  it('keeps a short page whole and cuts a long one exactly as the embeddings did', () => {
    expect(passagesOfPage('  kurz  ')).toEqual([{ ordinal: 0, text: 'kurz' }]);
    const long = filler('Block', 40);
    expect(passagesOfPage(long).map((passage) => passage.text)).toEqual(
      chunkPlainText(long).map((chunk) => chunk.text),
    );
  });
});

describe('context compiler evaluation set', () => {
  it('an exact file name wins even when the vectors prefer something else', () => {
    const exact = page(
      'nginx',
      'Reverse Proxy',
      `${filler('Vorwort', 12)}\nDie Datei exocortex-api.conf liegt unter /etc/nginx.`,
    );
    const semantic = Array.from({ length: 20 }, (_, index) =>
      semanticHit(`fremd-${index}`, 0, `Allgemeines über Webserver Nummer ${index}.`),
    );
    const { result } = compile([exact], semantic, 'exocortex-api.conf', 1_500);
    expect(result.sources[0]?.documentId).toBe('nginx');
    expect(result.sources[0]?.passages[0]?.text).toContain('exocortex-api.conf');
    expect(result.sources[0]?.passages[0]?.match).toBe('keyword');
  });

  it('a synonym is answered by meaning when no word matches', () => {
    const { result } = compile(
      [],
      [semanticHit('termine', 0, 'Verabredungen stehen im Kalender unter Erinnerungen.')],
      'Termine',
    );
    expect(result.sources.map((source) => source.documentId)).toEqual(['termine']);
    expect(result.sources[0]?.passages[0]?.section).toEqual({
      blockId: 'h-termine-0',
      path: ['Abschnitt'],
    });
  });

  it('finds the relevant section far down a long page, not its beginning', () => {
    const long = page(
      'handbuch',
      'Betriebshandbuch',
      `${filler('Kapitel', 60)}\nDas Backup läuft über megacmd alle sechs Stunden.\n${filler('Anhang', 10)}`,
    );
    const { result } = compile([long], [], 'megacmd backup');
    const passages = result.sources[0]?.passages ?? [];
    expect(passages).toHaveLength(1);
    expect(passages[0]?.text).toContain('megacmd');
    expect(passages[0]?.text).not.toContain('Kapitel 0 ');
  });

  it('delivers several relevant sections of the same long page together', () => {
    const long = page(
      'server',
      'Server',
      [
        filler('Einleitung', 10),
        'Postgres läuft als Container mit pgvector.',
        filler('Mitte', 20),
        'Das Postgres-Backup wird wöchentlich geprüft.',
        filler('Ende', 10),
      ].join('\n'),
    );
    const { result } = compile([long], [], 'postgres');
    const texts = result.sources[0]?.passages.map((passage) => passage.text) ?? [];
    expect(texts.some((text) => text.includes('pgvector'))).toBe(true);
    expect(texts.some((text) => text.includes('wöchentlich'))).toBe(true);
  });

  it('does not let one huge page crowd out other relevant pages', () => {
    const huge = page(
      'riesig',
      'Alles über Hermes',
      Array.from(
        { length: 80 },
        (_, index) => `Hermes Abschnitt ${index} ${'Hermes läuft als Timer. '.repeat(12)}`,
      ).join('\n'),
    );
    const others = ['a', 'b', 'c'].map((id) =>
      page(`hermes-${id}`, `Hermes ${id}`, `Hermes Notiz ${id}: kurz und relevant.`),
    );
    const { result } = compile([huge, ...others], [], 'hermes', 6_000);
    expect(result.sources.map((source) => source.documentId).sort()).toEqual(
      ['hermes-a', 'hermes-b', 'hermes-c', 'riesig'].sort(),
    );
    const hugeChars = result.sources
      .filter((source) => source.documentId === 'riesig')
      .flatMap((source) => source.passages)
      .reduce((sum, passage) => sum + passage.text.length, 0);
    expect(hugeChars).toBeLessThanOrEqual(defaultPerSourceMaxChars(6_000, 12));
  });

  it('ranks a page the vectors confirm above a similarly named page they do not', () => {
    const right = page('richtig', 'Kalender-Sync', 'Kalender-Sync mit Google: Plan und Stand.');
    const wrong = page(
      'falsch',
      'Kalender-Sync (Entwurf alt)',
      'Kalender-Sync Entwurf, verworfen.',
    );
    const { result } = compile(
      [wrong, right],
      [semanticHit('richtig', 0, 'Kalender-Sync mit Google: Plan und Stand.')],
      'kalender sync',
    );
    // Both words occur on both pages, so both are protected; the fused score
    // then decides between them, and only one of them has the vectors behind it.
    expect(result.sources.map((source) => source.documentId)).toEqual(['richtig', 'falsch']);
    expect(result.sources[0]?.passages[0]?.match).toBe('both');
  });

  it('keeps a very small budget exactly and says that it cut', () => {
    const pages = ['x', 'y', 'z'].map((id) =>
      page(id, `Seite ${id}`, `Zertifikat ${id} ${'Text '.repeat(200)}`),
    );
    const { result } = compile(pages, [], 'zertifikat', 500);
    expect(result.text.length).toBeLessThanOrEqual(500);
    expect(result.truncated).toBe(true);
    expect(result.selected).toBeGreaterThan(0);
  });

  it('answers nothing, and not an error, when nothing matches', () => {
    const { result, candidates } = compile([], [], 'gibtsnicht');
    expect(candidates).toEqual([]);
    expect(result).toEqual({ sources: [], text: '', truncated: false, selected: 0 });
  });

  it('is reproducible: identical candidates pack to the identical answer', () => {
    const pages = ['p1', 'p2', 'p3'].map((id) => page(id, id, `Tailscale ${id} ${filler(id, 8)}`));
    const semantic = [semanticHit('p2', 0, 'Tailscale Netz'), semanticHit('p3', 1, 'VPN')];
    expect(compile(pages, semantic, 'tailscale', 3_000).result).toEqual(
      compile(pages, semantic, 'tailscale', 3_000).result,
    );
  });

  it('never exceeds maxChars, whatever the budget', () => {
    const pages = Array.from({ length: 8 }, (_, index) =>
      page(`seite-${index}`, `Seite ${index}`, `Redis ${filler(`Redis ${index}`, 6 + index * 4)}`),
    );
    for (let budget = 500; budget <= 9_000; budget += 350) {
      const { result } = compile(pages, [], 'redis', budget, 5);
      expect(result.text.length).toBeLessThanOrEqual(budget);
      expect(result.sources.length).toBeLessThanOrEqual(5);
    }
  });
});

describe('attachment text', () => {
  it('a page found only by words outside its own text contributes nothing', () => {
    // The search found it through its PDF; the page itself says nothing about it.
    const { result } = compile(
      [page('pdf', 'Rechnungen 2025', 'Hier hängt der Scan.')],
      [],
      'Stromanbieter',
    );
    expect(result.sources).toEqual([]);
  });

  it('a page whose title matched still offers its opening', () => {
    const { result } = compile(
      [page('pdf', 'Stromanbieter', 'Hier hängt der Scan.')],
      [],
      'Stromanbieter',
    );
    expect(result.sources[0]?.passages[0]?.text).toBe('Hier hängt der Scan.');
  });
});

describe('packing', () => {
  it('skips a passage already contained in a chosen passage of the same page', () => {
    const candidates = fusePassages(
      [],
      [
        semanticHit('doc', 0, 'Ganzer Text der Seite, mit Anfang und Ende.'),
        semanticHit('doc', 1, 'mit Anfang und Ende.'),
      ],
      1,
    );
    const result = packContext(candidates, sourcesFor(candidates), {
      maxChars: 5_000,
      maxSources: 5,
      perSourceMaxChars: 5_000,
    });
    expect(result.selected).toBe(1);
  });

  it('does not pay twice for the same paragraph on two pages', () => {
    const candidates = fusePassages(
      [],
      [semanticHit('eins', 0, 'Gleicher Absatz.'), semanticHit('zwei', 0, 'Gleicher  Absatz.')],
      1,
    );
    const result = packContext(candidates, sourcesFor(candidates), {
      maxChars: 5_000,
      maxSources: 5,
      perSourceMaxChars: 5_000,
    });
    expect(result.sources.map((source) => source.documentId)).toEqual(['eins']);
    expect(result.truncated).toBe(false);
  });

  it('removes the overlap two neighbouring passages share', () => {
    expect(withoutOverlap('erste Zeile\nEnde des Absatzes', 'des Absatzes\nneuer Text')).toBe(
      'neuer Text',
    );
    expect(withoutOverlap('ganz anders', 'des Absatzes\nneuer Text')).toBe(
      'des Absatzes\nneuer Text',
    );
  });

  it('prints passages in page order under a header naming the source', () => {
    const candidates = fusePassages(
      [],
      [semanticHit('doc', 3, 'Später.'), semanticHit('doc', 1, 'Früher.')],
      1,
    );
    const result = packContext(candidates, sourcesFor(candidates), {
      maxChars: 5_000,
      maxSources: 5,
      perSourceMaxChars: 5_000,
    });
    expect(result.text).toBe(
      [
        '## doc\nSecond Brain › Technik · Stand 2026-09-20 · id doc',
        'Abschnitt: Abschnitt (^h-doc-1)\nFrüher.',
        'Abschnitt: Abschnitt (^h-doc-3)\nSpäter.',
      ].join('\n\n'),
    );
  });

  it('stops at maxSources and says so', () => {
    const candidates = fusePassages(
      [],
      ['a', 'b', 'c'].map((id) => semanticHit(id, 0, `Text ${id}.`)),
      1,
    );
    const result = packContext(candidates, sourcesFor(candidates), {
      maxChars: 5_000,
      maxSources: 2,
      perSourceMaxChars: 5_000,
    });
    expect(result.sources.map((source) => source.documentId)).toEqual(['a', 'b']);
    expect(result.truncated).toBe(true);
  });
});
