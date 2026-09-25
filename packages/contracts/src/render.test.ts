import { describe, expect, it } from 'vitest';

import {
  missingRenderVariables,
  renderErrorKey,
  type RenderVariable,
  renderVariableSchema,
  resolveRenderVariable,
  startRenderRequestSchema,
} from './render';

/**
 * Variable resolution (issue #44, ADR-026).
 *
 * It lives in the contracts package because the API resolves the values when it
 * accepts a request (which is what the input hash covers) while the browser
 * previews the same values in the form. These tests are what keeps the two from
 * being two implementations.
 */

const context = {
  explicit: {},
  title: 'Technische Dokumentation',
  path: 'Technik / Technische Dokumentation',
  author: 'Johanna',
  today: '2026-09-13',
  properties: { Kunde: 'Musterfirma' },
};

function variable(overrides: Partial<RenderVariable> = {}): RenderVariable {
  return renderVariableSchema.parse({ name: 'wert', label: 'Wert', ...overrides });
}

describe('resolveRenderVariable', () => {
  it('reads each origin from the right place', () => {
    expect(resolveRenderVariable(variable({ origin: 'TITLE' }), context)).toBe(
      'Technische Dokumentation',
    );
    expect(resolveRenderVariable(variable({ origin: 'PATH' }), context)).toBe(
      'Technik / Technische Dokumentation',
    );
    expect(resolveRenderVariable(variable({ origin: 'AUTHOR' }), context)).toBe('Johanna');
    expect(resolveRenderVariable(variable({ origin: 'TODAY' }), context)).toBe('2026-09-13');
    expect(
      resolveRenderVariable(variable({ origin: 'PROPERTY', property: 'Kunde' }), context),
    ).toBe('Musterfirma');
  });

  it('lets an explicit value win over every origin', () => {
    const explicit = { ...context, explicit: { wert: 'Von Hand' } };
    expect(resolveRenderVariable(variable({ origin: 'TITLE' }), explicit)).toBe('Von Hand');
  });

  it('falls back to the default when a property is not set on the page', () => {
    expect(
      resolveRenderVariable(
        variable({ origin: 'PROPERTY', property: 'Fehlt', defaultValue: 'unbekannt' }),
        context,
      ),
    ).toBe('unbekannt');
  });

  it('treats an empty explicit value as nothing typed', () => {
    const empty = { ...context, explicit: { wert: '' } };
    expect(resolveRenderVariable(variable({ origin: 'TODAY' }), empty)).toBe('2026-09-13');
  });

  it('answers with the default for a manual variable nobody filled in', () => {
    expect(resolveRenderVariable(variable({ defaultValue: 'Standard' }), context)).toBe('Standard');
    expect(resolveRenderVariable(variable(), context)).toBe('');
  });
});

describe('missingRenderVariables', () => {
  it('names the required ones that stayed empty', () => {
    const variables = [
      variable({ name: 'kunde', required: true }),
      variable({ name: 'datum', required: true }),
      variable({ name: 'notiz' }),
    ];
    expect(missingRenderVariables(variables, { datum: '2026-09-13' })).toEqual(['kunde']);
  });

  it('says nothing when everything required has a value', () => {
    expect(
      missingRenderVariables([variable({ name: 'kunde', required: true })], { kunde: 'x' }),
    ).toEqual([]);
  });
});

describe('renderErrorKey', () => {
  it('is silent while nothing has failed', () => {
    expect(renderErrorKey(null)).toBeNull();
  });

  it('keeps a code it knows and folds one it does not into unknown', () => {
    expect(renderErrorKey('render_timeout')).toBe('render_timeout');
    expect(renderErrorKey('something_new')).toBe('unknown');
    // A code out of a database row is a string, and `toString` is not a code.
    expect(renderErrorKey('toString')).toBe('unknown');
  });
});

describe('startRenderRequestSchema', () => {
  it('defaults to the page alone, no forcing, no variables', () => {
    const parsed = startRenderRequestSchema.parse({ templateId: 'tmpl1234' });
    expect(parsed).toMatchObject({ source: 'DOCUMENT', force: false, variables: {} });
  });
});

describe('renderVariableSchema', () => {
  it('refuses a name Pandoc could not address', () => {
    expect(renderVariableSchema.safeParse({ name: 'Kunde Name', label: 'x' }).success).toBe(false);
    expect(renderVariableSchema.safeParse({ name: 'kunde-name', label: 'x' }).success).toBe(true);
  });
});
