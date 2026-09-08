import { describe, expect, it } from 'vitest';

import { parseVerdicts } from './memory-consolidate';

/**
 * Reading the judge's answer (issue #46, ADR-021).
 *
 * The parser is where a model's sloppiness becomes a wrong memory, so it is
 * strict exactly where a mistake would be silent: an id that was never in the
 * batch, a correction with nothing to correct to, a model that says two
 * different things about one note.
 */
const NOTES = new Set(['note1', 'note2', 'note3']);

describe('parseVerdicts', () => {
  it('reads the five verdicts, and discards produce no work', () => {
    const parsed = parseVerdicts(
      [
        'NEU | note1 | - | Der Dienst hört auf Port 3211.',
        'BESTAETIGT | note2 | fact9 | -',
        'NICHTS | note3 | - | -',
      ].join('\n'),
      NOTES,
    );

    expect(parsed).toEqual([
      {
        kind: 'new',
        noteId: 'note1',
        factId: null,
        statement: 'Der Dienst hört auf Port 3211.',
        detail: '',
      },
      { kind: 'confirms', noteId: 'note2', factId: 'fact9', statement: null, detail: '' },
    ]);
  });

  it('accepts the umlaut spelling a German model will reach for', () => {
    const parsed = parseVerdicts('BESTÄTIGT | note1 | fact4 | -', NOTES);
    expect(parsed).toEqual([
      { kind: 'confirms', noteId: 'note1', factId: 'fact4', statement: null, detail: '' },
    ]);
  });

  it('drops a line about a note that was not in the batch', () => {
    // The shape a hallucinated id arrives in. Dropped here rather than sent on
    // to be rejected by the API, because nothing downstream can tell it apart
    // from a real one.
    expect(parseVerdicts('NEU | erfunden | - | Irgendetwas gilt.', NOTES)).toEqual([]);
  });

  it('drops a correction with nothing to correct and a creation with nothing to say', () => {
    const parsed = parseVerdicts(
      ['ERSETZT | note1 | fact2 | -', 'NEU | note2 | - | -'].join('\n'),
      NOTES,
    );
    expect(parsed).toEqual([]);
  });

  it('lets one note say several things', () => {
    // A distilled note holds three to eight bullet points. Forcing it into one
    // statement is what produced the 200-character run-on sentences the first
    // live run wrote.
    const parsed = parseVerdicts(
      [
        'NEU | note1 | - | Der Dienst hört auf Port 3211.',
        'NEU | note1 | - | Die Backups laufen alle sechs Stunden.',
      ].join('\n'),
      NOTES,
    );
    expect(parsed).toHaveLength(2);
  });

  it('caps one note at four statements', () => {
    const parsed = parseVerdicts(
      Array.from({ length: 6 }, (_, index) => `NEU | note1 | - | Aussage ${index}.`).join('\n'),
      NOTES,
    );
    expect(parsed).toHaveLength(4);
  });

  it('keeps only the first line about any one fact', () => {
    // A model that both confirms and replaces the same thing has lost the
    // thread; applying both would leave the memory holding two answers.
    const parsed = parseVerdicts(
      ['BESTAETIGT | note1 | fact1 | -', 'ERSETZT | note2 | fact1 | Etwas anderes gilt.'].join(
        '\n',
      ),
      NOTES,
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.kind).toBe('confirms');
  });

  it('cuts an over-long statement at a word boundary', () => {
    const long = `Die Anwendung ${'sehr '.repeat(40)}lang.`;
    const parsed = parseVerdicts(`NEU | note1 | - | ${long}`, NOTES);
    const statement = parsed[0]?.statement ?? '';
    expect(statement.length).toBeLessThanOrEqual(161);
    // "sehr…" rather than "se…": half a word in a page title reads as a bug.
    expect(statement.endsWith('sehr…')).toBe(true);
  });

  it('ignores prose the model wrapped its answer in', () => {
    const parsed = parseVerdicts(
      ['Gerne, hier meine Einschätzung:', '', 'NEU | note1 | - | Es gilt etwas.', 'Fertig.'].join(
        '\n',
      ),
      NOTES,
    );
    expect(parsed).toHaveLength(1);
  });
});
