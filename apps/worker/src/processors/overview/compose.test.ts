import { describe, expect, it } from 'vitest';

import {
  type CompositionMaterial,
  digestSystemPrompt,
  MAX_INTRO_CHARS,
  overviewSystemPrompt,
  parseComposition,
  renderDigestInput,
  renderOverviewInput,
} from './compose';

/**
 * The pure half of composing an overview (issue #53, ADR-028).
 *
 * The parser is the part that breaks when a model is swapped: every model gets
 * a two-line format slightly wrong in its own way, and the failure is silent --
 * a page quietly keeps the composition it had, or stores an apology as its
 * digest.
 */

const material: CompositionMaterial = {
  title: 'Creative & Media',
  path: ['AI & Tools'],
  ownText: '',
  children: [
    { title: 'Fish Audio S2', summary: 'Sprachsynthese.', isOverview: false, childCount: 0 },
    { title: 'Higgsfield AI', summary: null, isOverview: true, childCount: 3 },
  ],
};

describe('parseComposition', () => {
  it('reads both fields out of the expected answer', () => {
    const answer =
      'VORSPANN: Hier liegen die Medienwerkzeuge.\nSTECKBRIEF: Werkzeuge für Bild und Ton.';
    expect(parseComposition(answer)).toEqual({
      intro: 'Hier liegen die Medienwerkzeuge.',
      summary: 'Werkzeuge für Bild und Ton.',
    });
  });

  it('survives the decorations models add around a marker', () => {
    const answer = '**VORSPANN:** Erste Zeile\nzweite Zeile\n\n- STECKBRIEF: Kurz.';
    expect(parseComposition(answer)).toEqual({
      intro: 'Erste Zeile zweite Zeile',
      summary: 'Kurz.',
    });
  });

  it('accepts a marker in lower case', () => {
    expect(parseComposition('steckbrief: Kurz gefasst.').summary).toBe('Kurz gefasst.');
  });

  it('yields nothing when the answer has no markers at all', () => {
    // A paragraph of apology stored as a page's digest is worse than no digest.
    expect(parseComposition('Ich kann dazu leider nichts sagen.')).toEqual({
      intro: null,
      summary: null,
    });
  });

  it('leaves the half that was not answered null', () => {
    expect(parseComposition('STECKBRIEF: Nur der Steckbrief.')).toEqual({
      intro: null,
      summary: 'Nur der Steckbrief.',
    });
  });

  it('cuts an overlong answer at a sentence end rather than mid-word', () => {
    const long = `VORSPANN: ${'Ein Satz über die Seite. '.repeat(120)}`;
    const intro = parseComposition(long).intro;
    expect(intro).not.toBeNull();
    expect((intro as string).length).toBeLessThanOrEqual(MAX_INTRO_CHARS);
    expect(intro as string).toMatch(/\.$/);
  });

  it('drops an empty marker line instead of storing an empty string', () => {
    expect(parseComposition('STECKBRIEF:\nVORSPANN: Text.').summary).toBeNull();
  });
});

describe('renderOverviewInput', () => {
  it('names a child that has no digest yet instead of leaving it out', () => {
    const rendered = renderOverviewInput(material);
    expect(rendered).toContain('Fish Audio S2');
    expect(rendered).toContain('Higgsfield AI');
    expect(rendered).toContain('noch keine Beschreibung');
  });

  it('says how much hangs under a child and which children are overviews', () => {
    const rendered = renderOverviewInput(material);
    expect(rendered).toContain('Übersichtsseite');
    expect(rendered).toContain('3 Unterseiten');
  });

  it('carries the page body when there is one, marked as the human part', () => {
    const rendered = renderOverviewInput({ ...material, ownText: 'Von Hand geschrieben.' });
    expect(rendered).toContain('Von Hand geschrieben.');
  });
});

describe('renderDigestInput', () => {
  it('says so when the page has no text, rather than sending an empty prompt', () => {
    expect(renderDigestInput({ ...material, children: [] })).toContain('(leer)');
  });
});

describe('the prompts', () => {
  it('ask for the marker lines the parser reads', () => {
    expect(overviewSystemPrompt()).toContain('VORSPANN:');
    expect(overviewSystemPrompt()).toContain('STECKBRIEF:');
    expect(digestSystemPrompt()).toContain('STECKBRIEF:');
  });

  it('forbid the dashes this deployment does not use in prose', () => {
    expect(overviewSystemPrompt()).toContain('Keine Gedankenstriche');
    expect(digestSystemPrompt()).toContain('Keine Gedankenstriche');
  });
});
