import { describe, expect, it } from 'vitest';

import {
  type AiFillColumn,
  aiFillConfigProblems,
  aiFillInstructionText,
  coerceAiFillAnswer,
  isEmptyCellValue,
  parseAiFillAnswerText,
  presetsForType,
} from './database-ai-fill';

function column(overrides: Partial<AiFillColumn>): AiFillColumn {
  return {
    type: 'TEXT',
    isRange: false,
    includeTime: false,
    timeZone: null,
    options: [],
    members: [],
    allowNewOptions: false,
    ...overrides,
  };
}

const sources = { useContent: true, useProperties: true, useAttachments: true };

describe('parseAiFillAnswerText', () => {
  it('reads the value out of the object, inside a code fence too', () => {
    expect(parseAiFillAnswerText('{"value": "Hallo"}')).toEqual({ ok: true, value: 'Hallo' });
    expect(parseAiFillAnswerText('Hier:\n```json\n{"value": 3}\n```')).toEqual({
      ok: true,
      value: 3,
    });
    expect(parseAiFillAnswerText('{"value": null}')).toEqual({ ok: true, value: null });
  });

  it('refuses anything that is not that object', () => {
    expect(parseAiFillAnswerText('Hallo')).toEqual({ ok: false });
    expect(parseAiFillAnswerText('{"answer": 1}')).toEqual({ ok: false });
    expect(parseAiFillAnswerText('{"value": {"nested": true}}')).toEqual({ ok: false });
    expect(parseAiFillAnswerText('{broken')).toEqual({ ok: false });
  });
});

describe('coerceAiFillAnswer', () => {
  it('treats a blank answer as nothing found', () => {
    for (const raw of [null, '', '   ', []]) {
      expect(coerceAiFillAnswer(column({ type: 'NUMBER' }), raw)).toEqual({
        ok: true,
        value: null,
        newOptions: [],
      });
    }
  });

  it('writes text, joining a list into lines and capping the length', () => {
    expect(coerceAiFillAnswer(column({}), ' Kurz. ')).toMatchObject({ ok: true, value: 'Kurz.' });
    expect(coerceAiFillAnswer(column({}), ['a', 'b'])).toMatchObject({
      ok: true,
      value: '- a\n- b',
    });
    const long = coerceAiFillAnswer(column({}), 'x'.repeat(9_000));
    expect(long.ok && typeof long.value === 'string' && long.value.length).toBe(5_000);
  });

  it('reads numbers in both decimal conventions and refuses words', () => {
    const number = column({ type: 'NUMBER' });
    expect(coerceAiFillAnswer(number, 12.5)).toMatchObject({ value: 12.5 });
    expect(coerceAiFillAnswer(number, '1.234,50')).toMatchObject({ value: 1234.5 });
    expect(coerceAiFillAnswer(number, '1,234.50')).toMatchObject({ value: 1234.5 });
    expect(coerceAiFillAnswer(number, 'zwölf')).toEqual({ ok: false, code: 'answer_invalid' });
  });

  it('keeps a whole day a day and refuses a date that does not exist', () => {
    const date = column({ type: 'DATE' });
    expect(coerceAiFillAnswer(date, '2026-03-05')).toMatchObject({ value: '2026-03-05' });
    expect(coerceAiFillAnswer(date, '2026-03-05T14:00:00Z')).toMatchObject({
      value: '2026-03-05',
    });
    expect(coerceAiFillAnswer(date, '2026-02-30')).toEqual({ ok: false, code: 'answer_invalid' });
    expect(coerceAiFillAnswer(date, 'nächsten Montag')).toEqual({
      ok: false,
      code: 'answer_invalid',
    });
    expect(
      coerceAiFillAnswer(column({ type: 'DATE', includeTime: true }), '2026-03-05T14:00:00Z'),
    ).toMatchObject({ value: '2026-03-05T14:00:00.000Z' });
  });

  it('answers a span for a range column, and refuses one that ends first', () => {
    const range = column({ type: 'DATE', isRange: true });
    expect(coerceAiFillAnswer(range, { start: '2026-03-05', end: '2026-03-07' })).toMatchObject({
      value: { start: '2026-03-05', end: '2026-03-07', allDay: true },
    });
    expect(coerceAiFillAnswer(range, '2026-03-05')).toMatchObject({
      value: { start: '2026-03-05', end: null, allDay: true },
    });
    expect(coerceAiFillAnswer(range, { start: '2026-03-07', end: '2026-03-05' })).toEqual({
      ok: false,
      code: 'answer_invalid',
    });
  });

  it('maps option labels to ids and refuses an unknown one unless options may be added', () => {
    const options = [
      { id: 'opt_rechnung_0001', label: 'Rechnung' },
      { id: 'opt_brief_000002', label: 'Brief' },
    ];
    expect(coerceAiFillAnswer(column({ type: 'SELECT', options }), 'rechnung')).toEqual({
      ok: true,
      value: 'opt_rechnung_0001',
      newOptions: [],
    });
    expect(coerceAiFillAnswer(column({ type: 'SELECT', options }), 'Vertrag')).toEqual({
      ok: false,
      code: 'option_unknown',
    });
    expect(
      coerceAiFillAnswer(column({ type: 'MULTI_SELECT', options, allowNewOptions: true }), [
        'Brief',
        'Vertrag',
        'brief',
      ]),
    ).toEqual({ ok: true, value: ['opt_brief_000002'], newOptions: ['Vertrag'] });
  });

  it('names only members, by id, address or name', () => {
    const members = [{ id: 'user_anna_000001', name: 'Anna Beispiel', email: 'anna@example.org' }];
    const person = column({ type: 'PERSON', members });
    expect(coerceAiFillAnswer(person, 'anna beispiel')).toMatchObject({
      value: ['user_anna_000001'],
    });
    expect(coerceAiFillAnswer(person, ['anna@example.org', 'user_anna_000001'])).toMatchObject({
      value: ['user_anna_000001'],
    });
    expect(coerceAiFillAnswer(person, 'Bernd')).toEqual({ ok: false, code: 'person_unknown' });
  });

  it('checks URLs, addresses and checkboxes', () => {
    expect(coerceAiFillAnswer(column({ type: 'URL' }), 'https://example.org/a')).toMatchObject({
      ok: true,
    });
    expect(coerceAiFillAnswer(column({ type: 'URL' }), 'javascript:alert(1)')).toMatchObject({
      ok: false,
    });
    expect(coerceAiFillAnswer(column({ type: 'EMAIL' }), 'kein Name')).toMatchObject({
      ok: false,
    });
    expect(coerceAiFillAnswer(column({ type: 'CHECKBOX' }), 'Ja')).toMatchObject({ value: true });
    expect(coerceAiFillAnswer(column({ type: 'CHECKBOX' }), 'vielleicht')).toMatchObject({
      ok: false,
    });
  });
});

describe('aiFillConfigProblems', () => {
  it('accepts a preset on the types it is for', () => {
    expect(aiFillConfigProblems('TEXT', { preset: 'summary', ...sources })).toEqual([]);
    expect(aiFillConfigProblems('DATE', { preset: 'document_date', ...sources })).toEqual([]);
  });

  it('names every problem at once', () => {
    expect(
      aiFillConfigProblems('NUMBER', {
        preset: 'summary',
        allowNewOptions: true,
        useContent: false,
        useProperties: false,
        useAttachments: false,
      }),
    ).toEqual(['preset_type', 'options_type', 'no_source']);
    expect(
      aiFillConfigProblems('TEXT', { preset: 'custom', instruction: ' ', ...sources }),
    ).toEqual(['instruction_required']);
    expect(aiFillConfigProblems('TEXT', { preset: 'translate', ...sources })).toEqual([
      'language_required',
    ]);
    expect(aiFillConfigProblems('FILES', { preset: 'custom', ...sources })).toEqual([
      'type_unsupported',
    ]);
  });

  it('offers the presets that fit a type', () => {
    expect(presetsForType('DATE')).toEqual(['document_date', 'custom']);
    expect(presetsForType('RELATION')).toEqual([]);
  });
});

describe('aiFillInstructionText', () => {
  it('adds the person’s words to a preset and stands alone for a custom one', () => {
    expect(
      aiFillInstructionText({
        preset: 'custom',
        instruction: 'Nur die Stadt.',
        targetLanguage: null,
      }),
    ).toBe('Nur die Stadt.');
    expect(
      aiFillInstructionText({
        preset: 'translate',
        instruction: null,
        targetLanguage: 'Französische',
      }),
    ).toContain('ins Französische');
    expect(
      aiFillInstructionText({
        preset: 'summary',
        instruction: 'Auf Deutsch.',
        targetLanguage: null,
      }),
    ).toMatch(/Zusätzlich: Auf Deutsch\.$/u);
  });
});

describe('isEmptyCellValue', () => {
  it('counts nothing, blank text and an empty list as empty', () => {
    expect(isEmptyCellValue(null)).toBe(true);
    expect(isEmptyCellValue(' ')).toBe(true);
    expect(isEmptyCellValue([])).toBe(true);
    expect(isEmptyCellValue(false)).toBe(false);
    expect(isEmptyCellValue(0)).toBe(false);
  });
});
