import { describe, expect, it } from 'vitest';

import {
  analyzeFormula,
  compileFormulaSource,
  FormulaError,
  formulaPropertyRefs,
  type FormulaPropertyResolver,
  parseFormula,
  renameFormulaProperty,
} from './database-formula';

const resolve: FormulaPropertyResolver = (ref) => {
  if (ref === 'Preis' || ref === 'Menge') return 'number';
  if (ref === 'Titel') return 'text';
  if (ref === 'Erledigt') return 'boolean';
  if (ref === 'Fällig') return 'date';
  return null;
};

describe('parseFormula', () => {
  it('reads a property reference', () => {
    expect(parseFormula('prop("Preis")')).toEqual({ kind: 'property', ref: 'Preis' });
  });

  it('gives multiplication a tighter grip than addition', () => {
    const node = parseFormula('1 + 2 * 3');
    expect(node).toEqual({
      kind: 'binary',
      operator: '+',
      left: { kind: 'number', value: 1 },
      right: {
        kind: 'binary',
        operator: '*',
        left: { kind: 'number', value: 2 },
        right: { kind: 'number', value: 3 },
      },
    });
  });

  it('keeps subtraction left-associative', () => {
    const node = parseFormula('10 - 3 - 2');
    expect(node).toMatchObject({ operator: '-', left: { operator: '-' }, right: { value: 2 } });
  });

  it('accepts both argument separators', () => {
    expect(parseFormula('min(1; 2)')).toEqual(parseFormula('min(1, 2)'));
  });

  it('refuses an unknown function', () => {
    expect(() => parseFormula('frobnicate(1)')).toThrow(FormulaError);
  });

  it('refuses a bare identifier, and says how a column is written', () => {
    expect(() => parseFormula('Preis')).toThrow(/prop\("Name"\)/);
  });

  it('refuses an unterminated string', () => {
    expect(() => parseFormula('concat("a)')).toThrow(FormulaError);
  });

  it('refuses trailing rubbish rather than ignoring it', () => {
    expect(() => parseFormula('1 + 2)')).toThrow(FormulaError);
  });
});

describe('analyzeFormula', () => {
  it('types arithmetic over number columns', () => {
    expect(compileFormulaSource('prop("Preis") * prop("Menge")', resolve).type).toBe('number');
  });

  it('types a comparison as a yes/no', () => {
    expect(compileFormulaSource('prop("Preis") > 10', resolve).type).toBe('boolean');
  });

  it('refuses arithmetic on text', () => {
    expect(() => compileFormulaSource('prop("Titel") + 1', resolve)).toThrow(
      /Typen müssen gleich sein|nicht anwendbar/,
    );
  });

  it('refuses a comparison between different types', () => {
    expect(() => compileFormulaSource('prop("Preis") == prop("Titel")', resolve)).toThrow(
      FormulaError,
    );
  });

  it('names the column that does not exist', () => {
    expect(() => compileFormulaSource('prop("Gibtsnicht")', resolve)).toThrow(/Gibtsnicht/);
  });

  it('takes the type of both branches of an if', () => {
    expect(compileFormulaSource('if(prop("Erledigt"); prop("Preis"); 0)', resolve).type).toBe(
      'number',
    );
  });

  it('refuses an if whose branches disagree', () => {
    expect(() =>
      compileFormulaSource('if(prop("Erledigt"); prop("Preis"); "nein")', resolve),
    ).toThrow(/beide Zweige/);
  });

  it('accepts empty() on any column and answers a yes/no', () => {
    expect(compileFormulaSource('empty(prop("Fällig"))', resolve).type).toBe('boolean');
  });

  it('counts a variadic call as one argument list', () => {
    expect(compileFormulaSource('concat(prop("Titel"); " - "; prop("Titel"))', resolve).type).toBe(
      'text',
    );
  });

  it('refuses too few arguments', () => {
    expect(() => compileFormulaSource('dateAdd(prop("Fällig"))', resolve)).toThrow(/dateAdd/);
  });

  it('refuses a formula nested past the depth limit', () => {
    const deep = `${'('.repeat(40)}1${')'.repeat(40)}`;
    expect(() => parseFormula(deep)).toThrow(/verschachtelt/);
  });

  it('reports the type of a date function', () => {
    expect(compileFormulaSource('dateDiffDays(prop("Fällig"); now())', resolve).type).toBe(
      'number',
    );
  });

  it('lets a resolver refuse a column type outright', () => {
    const node = parseFormula('prop("Anhänge")');
    expect(() =>
      analyzeFormula(node, () => {
        throw new FormulaError('Die Spalte "Anhänge" lässt sich nicht verwenden');
      }),
    ).toThrow(/Anhänge/);
  });
});

describe('formulaPropertyRefs', () => {
  it('collects every column a formula reads', () => {
    const node = parseFormula('if(prop("Erledigt"); prop("Preis") * prop("Menge"); 0)');
    expect(formulaPropertyRefs(node).sort()).toEqual(['Erledigt', 'Menge', 'Preis']);
  });
});

describe('renameFormulaProperty', () => {
  it('rewrites the column a formula names', () => {
    expect(renameFormulaProperty('prop("Preis") * 2', 'Preis', 'Nettopreis')).toBe(
      'prop("Nettopreis") * 2',
    );
  });

  it('rewrites every occurrence', () => {
    expect(renameFormulaProperty('prop("A") + prop("A")', 'A', 'B')).toBe('prop("B") + prop("B")');
  });

  it('leaves a string that merely looks like the column alone', () => {
    expect(renameFormulaProperty('concat("Preis"; prop("Preis"))', 'Preis', 'Netto')).toBe(
      'concat("Preis"; prop("Netto"))',
    );
  });

  it('leaves a formula that does not mention the column untouched', () => {
    expect(renameFormulaProperty('prop("Menge") + 1', 'Preis', 'Netto')).toBe('prop("Menge") + 1');
  });
});
