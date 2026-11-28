import { describe, expect, it } from 'vitest';

import { type DatabasePropertyOption } from '@exocortex/contracts';

import { databaseProperty } from '@/test-support/database';

import {
  filterValueChoices,
  filterValueLabel,
  operatorsForType,
  uniquePropertyName,
} from './property-types';

const options: DatabasePropertyOption[] = [
  { id: 'opt-1', label: 'Offen', color: 'blue', orderKey: 'a0' },
  { id: 'opt-2', label: 'Erledigt', color: 'green', orderKey: 'a1' },
];

const select = databaseProperty('p-select', { type: 'SELECT', options });

// The words are handed in by `useFilterWording`; any pair shows they are used.
const words = { checked: 'angehakt', unchecked: 'nicht angehakt' };

describe('operatorsForType', () => {
  it('offers comparisons for numbers and dates, not "contains"', () => {
    expect(operatorsForType('NUMBER')).toContain('greater_than');
    expect(operatorsForType('NUMBER')).not.toContain('contains');
    expect(operatorsForType('DATE')).toEqual([
      'on_or_after',
      'on_or_before',
      'is_empty',
      'is_not_empty',
    ]);
  });

  it('treats the computed time properties like a date', () => {
    expect(operatorsForType('CREATED_TIME')).toEqual(operatorsForType('DATE'));
    expect(operatorsForType('UPDATED_TIME')).toEqual(operatorsForType('DATE'));
  });

  it('gives a checkbox the one operator it can answer', () => {
    // "is empty" on a checkbox is a question with no meaning: it is always
    // either checked or not.
    expect(operatorsForType('CHECKBOX')).toEqual(['equals']);
  });

  it('asks a multi-value property what it contains, never what it equals', () => {
    expect(operatorsForType('MULTI_SELECT')).toEqual([
      'contains',
      'not_contains',
      'is_empty',
      'is_not_empty',
    ]);
  });

  it('falls back to the text operators', () => {
    expect(operatorsForType('TEXT')).toContain('equals');
    expect(operatorsForType('TEXT')).toContain('contains');
  });
});

describe('filterValueChoices', () => {
  it('offers the option labels and stores their ids', () => {
    expect(filterValueChoices(select, words)).toEqual([
      { value: 'opt-1', label: 'Offen' },
      { value: 'opt-2', label: 'Erledigt' },
    ]);
  });

  it('spells out both sides of a checkbox', () => {
    expect(filterValueChoices(databaseProperty('p', { type: 'CHECKBOX' }), words)).toHaveLength(2);
  });

  it('leaves free text free', () => {
    expect(filterValueChoices(databaseProperty('p', { type: 'TEXT' }), words)).toEqual([]);
  });
});

describe('filterValueLabel', () => {
  it('reads a stored option id back as its label', () => {
    expect(filterValueLabel(select, 'opt-2', words)).toBe('Erledigt');
  });

  it('shows the raw value when the option is gone', () => {
    // A deleted option must leave the chip readable rather than empty, or a
    // filter nobody can see is a filter nobody can remove.
    expect(filterValueLabel(select, 'opt-gone', words)).toBe('opt-gone');
  });

  it('reads a checkbox in words, however the value was stored', () => {
    const checkbox = databaseProperty('p', { type: 'CHECKBOX' });

    expect(filterValueLabel(checkbox, true, words)).toBe('angehakt');
    expect(filterValueLabel(checkbox, 'true', words)).toBe('angehakt');
    expect(filterValueLabel(checkbox, false, words)).toBe('nicht angehakt');
  });

  it('survives a filter whose property no longer exists', () => {
    expect(filterValueLabel(undefined, 'Berlin', words)).toBe('Berlin');
  });
});

describe('uniquePropertyName', () => {
  const numbered = (name: string, number: number) => `${name} ${number}`;

  it('offers the plain name while no column carries it', () => {
    expect(uniquePropertyName('Datum', ['Status', 'Dateien'], numbered)).toBe('Datum');
  });

  it('counts on from 2 when the name is taken', () => {
    expect(uniquePropertyName('Datum', ['Datum'], numbered)).toBe('Datum 2');
    expect(uniquePropertyName('Datum', ['Datum', 'Datum 2', 'Datum 3'], numbered)).toBe('Datum 4');
  });

  it('fills the first gap rather than the end', () => {
    expect(uniquePropertyName('Datum', ['Datum', 'Datum 3'], numbered)).toBe('Datum 2');
  });

  it('treats a name differing only in case or spaces as taken', () => {
    // A formula's prop("datum") beside a column "Datum" would not say which
    // one it means, so the offer steps around both.
    expect(uniquePropertyName('Datum', [' datum '], numbered)).toBe('Datum 2');
  });

  it('spells the suffix the way it is told to', () => {
    expect(uniquePropertyName('Date', ['Date'], (name, number) => `${name} (${number})`)).toBe(
      'Date (2)',
    );
  });
});
