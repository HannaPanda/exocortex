import { describe, expect, it } from 'vitest';

import { type DatabaseFilterGroup, type DatabaseSort, EMPTY_DATABASE_FILTER_GROUP } from '@exocortex/contracts';

import {
  buildPropertyMap,
  compileFilterGroup,
  compileSorts,
  InvalidDatabaseFilterError,
  UnknownDatabasePropertyError,
} from './database-query';

const TEXT = { id: 'prop_text', type: 'TEXT' as const };
const NUMBER = { id: 'prop_number', type: 'NUMBER' as const };
const DATE = { id: 'prop_date', type: 'DATE' as const };
const CHECKBOX = { id: 'prop_checkbox', type: 'CHECKBOX' as const };
const MULTI_SELECT = { id: 'prop_multi', type: 'MULTI_SELECT' as const };
const CREATED_TIME = { id: 'prop_created', type: 'CREATED_TIME' as const };

const properties = buildPropertyMap([TEXT, NUMBER, DATE, CHECKBOX, MULTI_SELECT, CREATED_TIME]);

describe('compileFilterGroup', () => {
  it('compiles to TRUE for an empty group', () => {
    const sql = compileFilterGroup(EMPTY_DATABASE_FILTER_GROUP, properties);
    expect(sql.sql).toBe('TRUE');
    expect(sql.values).toEqual([]);
  });

  it('rejects a propertyId that is not in the property map', () => {
    const group: DatabaseFilterGroup = {
      combinator: 'and',
      conditions: [{ propertyId: 'not_this_collection', operator: 'equals', value: 'x' }],
    };
    expect(() => compileFilterGroup(group, properties)).toThrow(UnknownDatabasePropertyError);
  });

  it('never lets Prisma.raw see anything but the five known column names', () => {
    const group: DatabaseFilterGroup = {
      combinator: 'and',
      conditions: [
        { propertyId: TEXT.id, operator: 'contains', value: '"; DROP TABLE document; --' },
        { propertyId: NUMBER.id, operator: 'greater_than', value: 1 },
      ],
    };
    const sql = compileFilterGroup(group, properties);
    // The malicious payload must appear only as a bound parameter (wrapped in
    // ILIKE wildcards by the "contains" operator), never spliced into the SQL
    // text itself.
    expect(sql.sql).not.toContain('DROP TABLE');
    expect(sql.values).toContain('%"; DROP TABLE document; --%');
    // Every column reference the compiler can emit is one of these five.
    const rawColumnPattern = /"(textValue|numberValue|boolValue|dateValue|jsonValue)"/g;
    const matches = sql.sql.match(rawColumnPattern) ?? [];
    expect(matches.length).toBeGreaterThan(0);
    for (const match of sql.sql.matchAll(/SELECT dpv\."(\w+)"/g)) {
      expect(['textValue', 'numberValue', 'boolValue', 'dateValue', 'jsonValue']).toContain(match[1]);
    }
  });

  it('compiles equals for a TEXT property as a direct comparison', () => {
    const group: DatabaseFilterGroup = {
      combinator: 'and',
      conditions: [{ propertyId: TEXT.id, operator: 'equals', value: 'Hallo' }],
    };
    const sql = compileFilterGroup(group, properties);
    expect(sql.sql).toContain('"textValue"');
    expect(sql.sql.trim().endsWith('= ?')).toBe(true);
    expect(sql.values).toEqual([TEXT.id, 'Hallo']);
  });

  it('compiles contains for a MULTI_SELECT property as jsonb containment', () => {
    const group: DatabaseFilterGroup = {
      combinator: 'and',
      conditions: [{ propertyId: MULTI_SELECT.id, operator: 'contains', value: 'opt_1' }],
    };
    const sql = compileFilterGroup(group, properties);
    expect(sql.sql).toContain('"jsonValue"');
    expect(sql.sql).toContain('@>');
    expect(sql.values).toEqual([MULTI_SELECT.id, JSON.stringify(['opt_1'])]);
  });

  it('compiles is_empty/is_not_empty without a bound value', () => {
    const group: DatabaseFilterGroup = {
      combinator: 'or',
      conditions: [
        { propertyId: NUMBER.id, operator: 'is_empty' },
        { propertyId: NUMBER.id, operator: 'is_not_empty' },
      ],
    };
    const sql = compileFilterGroup(group, properties);
    expect(sql.sql).toContain('IS NULL');
    expect(sql.sql).toContain('IS NOT NULL');
    expect(sql.sql).toContain(' OR ');
    // Only the propertyId lookups are bound; no value parameter for either leaf.
    expect(sql.values).toEqual([NUMBER.id, NUMBER.id]);
  });

  it('reads CREATED_TIME directly off the document row, never document_property_value', () => {
    const group: DatabaseFilterGroup = {
      combinator: 'and',
      conditions: [{ propertyId: CREATED_TIME.id, operator: 'on_or_after', value: '2026-01-01' }],
    };
    const sql = compileFilterGroup(group, properties);
    expect(sql.sql).toContain('document."createdAt"');
    expect(sql.sql).not.toContain('document_property_value');
  });

  it('nests AND/OR groups with parentheses', () => {
    const group: DatabaseFilterGroup = {
      combinator: 'or',
      conditions: [
        { propertyId: CHECKBOX.id, operator: 'equals', value: true },
        {
          combinator: 'and',
          conditions: [
            { propertyId: TEXT.id, operator: 'is_not_empty' },
            { propertyId: DATE.id, operator: 'on_or_before', value: '2026-12-31' },
          ],
        },
      ],
    };
    const sql = compileFilterGroup(group, properties);
    expect(sql.sql).toMatch(/\([\s\S]*AND[\s\S]*\)/);
    expect(sql.sql).toContain(' OR ');
  });
});

describe('compileFilterGroup with the overlaps operator', () => {
  const overlaps = (propertyId: string, value: unknown): DatabaseFilterGroup => ({
    combinator: 'and',
    // The operand is deliberately typed loosely here: the point of these cases
    // is what the compiler does with an operand the type system did not vet.
    conditions: [{ propertyId, operator: 'overlaps', value: value as string[] }],
  });

  it('compares both ends of the span and binds the window as parameters', () => {
    const sql = compileFilterGroup(overlaps(DATE.id, ['2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']), properties);
    expect(sql.sql).toContain('EXISTS');
    expect(sql.sql).toContain('"dateEndValue"');
    // The propertyId, plus both window bounds once per CASE branch: the window
    // never reaches the SQL as literal text.
    expect(sql.values).toHaveLength(5);
    expect(sql.values[0]).toBe(DATE.id);
  });

  it('treats a value without an end as a point in time, not as an open span', () => {
    const sql = compileFilterGroup(overlaps(DATE.id, ['2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']), properties);
    // The NULL branch is bounded on both sides; the span branch is not.
    expect(sql.sql).toContain('WHEN dpv."dateEndValue" IS NULL');
    expect(sql.sql).toContain('THEN dpv."dateValue" >= ? AND dpv."dateValue" < ?');
    expect(sql.sql).toContain('ELSE dpv."dateValue" < ? AND dpv."dateEndValue" > ?');
  });

  it('rejects the operator on a property type that has no span', () => {
    expect(() => compileFilterGroup(overlaps(TEXT.id, ['2026-08-01', '2026-09-01']), properties)).toThrow(
      InvalidDatabaseFilterError,
    );
  });

  it.each([
    ['a single bound', ['2026-08-01']],
    ['three bounds', ['2026-08-01', '2026-09-01', '2026-10-01']],
    ['a non-string bound', [1, 2]],
    ['an unparsable date', ['not-a-date', '2026-09-01']],
    ['a reversed window', ['2026-09-01', '2026-08-01']],
  ])('rejects %s', (_label, value) => {
    expect(() => compileFilterGroup(overlaps(DATE.id, value), properties)).toThrow(InvalidDatabaseFilterError);
  });
});

describe('compileSorts', () => {
  it('falls back to orderKey when there are no sorts', () => {
    const sql = compileSorts([], properties);
    expect(sql.sql).toBe('document."orderKey" ASC');
  });

  it('rejects a sort on a propertyId outside the map', () => {
    const sorts: DatabaseSort[] = [{ propertyId: 'unknown', direction: 'asc' }];
    expect(() => compileSorts(sorts, properties)).toThrow(UnknownDatabasePropertyError);
  });

  it('always appends orderKey as a deterministic tiebreaker', () => {
    const sorts: DatabaseSort[] = [{ propertyId: NUMBER.id, direction: 'desc' }];
    const sql = compileSorts(sorts, properties);
    expect(sql.sql).toContain('DESC NULLS LAST');
    expect(sql.sql.trim().endsWith('document."orderKey" ASC')).toBe(true);
  });
});
