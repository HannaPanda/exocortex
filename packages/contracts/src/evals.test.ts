import { describe, expect, it } from 'vitest';

import {
  assertionsProblem,
  createEvalCaseRequestSchema,
  evalAssertionSchema,
  evalFixtureSchema,
  evalReplayWriteMode,
  evalVariantLabel,
  evalVariantSchema,
  fixtureProblem,
  startEvalRunRequestSchema,
} from './evals';

const fixture = evalFixtureSchema.parse({
  pages: [
    { key: 'root', title: 'Projekt', markdown: '# Projekt' },
    { key: 'notes', title: 'Notizen', markdown: 'Text', parentKey: 'root' },
  ],
  startKey: 'notes',
});

describe('eval replay modes', () => {
  it('hold each mode to the matching write mode', () => {
    expect(evalReplayWriteMode('read_only')).toBe('read_only');
    expect(evalReplayWriteMode('propose')).toBe('propose');
    expect(evalReplayWriteMode('fixture')).toBe('direct');
  });
});

describe('fixtureProblem', () => {
  it('accepts pages listed parent first', () => {
    expect(fixtureProblem(fixture)).toBeNull();
  });

  it('refuses a parent listed after its child, a duplicate key and an unknown start', () => {
    const child = { key: 'a', title: 'A', markdown: '', parentKey: 'b' };
    const parent = { key: 'b', title: 'B', markdown: '', parentKey: null };
    expect(fixtureProblem({ pages: [child, parent], startKey: null })).toMatch(/parent/);
    expect(fixtureProblem({ pages: [parent, parent], startKey: null })).toMatch(/duplicate/);
    expect(fixtureProblem({ pages: [parent], startKey: 'x' })).toMatch(/start page/);
  });
});

describe('assertionsProblem', () => {
  const parse = (value: unknown) => evalAssertionSchema.parse(value);

  it('refuses a fixture check outside the fixture mode', () => {
    expect(
      assertionsProblem({
        replayMode: 'read_only',
        fixture: null,
        assertions: [parse({ id: 'p', kind: 'page_contains', page: 'notes', text: 'x' })],
      }),
    ).toMatch(/fixture mode/);
  });

  it('refuses a page the fixture does not bring, a duplicate id and a broken pattern', () => {
    expect(
      assertionsProblem({
        replayMode: 'fixture',
        fixture,
        assertions: [parse({ id: 'p', kind: 'page_contains', page: 'other', text: 'x' })],
      }),
    ).toMatch(/does not have/);
    expect(
      assertionsProblem({
        replayMode: 'read_only',
        fixture: null,
        assertions: [
          parse({ id: 'a', kind: 'no_changes' }),
          parse({ id: 'a', kind: 'max_tool_calls', max: 3 }),
        ],
      }),
    ).toMatch(/duplicate/);
    expect(
      assertionsProblem({
        replayMode: 'read_only',
        fixture: null,
        assertions: [parse({ id: 'r', kind: 'answer_matches', pattern: '(' })],
      }),
    ).toMatch(/compile/);
  });

  it('refuses max below min', () => {
    expect(
      assertionsProblem({
        replayMode: 'read_only',
        fixture: null,
        assertions: [parse({ id: 't', kind: 'tool_called', tool: 'exo_search', min: 3, max: 1 })],
      }),
    ).toMatch(/max below min/);
  });
});

describe('createEvalCaseRequestSchema', () => {
  it('needs pages in the fixture mode and refuses them elsewhere', () => {
    const base = { name: 'Fall', prompt: 'Tu etwas' };
    expect(createEvalCaseRequestSchema.safeParse({ ...base, replayMode: 'fixture' }).success).toBe(
      false,
    );
    expect(
      createEvalCaseRequestSchema.safeParse({ ...base, replayMode: 'read_only', fixture }).success,
    ).toBe(false);
    expect(
      createEvalCaseRequestSchema.safeParse({ ...base, replayMode: 'fixture', fixture }).success,
    ).toBe(true);
  });
});

describe('startEvalRunRequestSchema', () => {
  it('takes cases or a suite, never both', () => {
    const variants = [{ modelSlug: 'deepseek/deepseek-v4.1-flash' }];
    expect(startEvalRunRequestSchema.safeParse({ variants }).success).toBe(false);
    expect(
      startEvalRunRequestSchema.safeParse({
        variants,
        suite: 'regression',
        caseIds: ['x'.repeat(10)],
      }).success,
    ).toBe(false);
    expect(startEvalRunRequestSchema.safeParse({ variants, suite: 'regression' }).success).toBe(
      true,
    );
  });
});

describe('evalVariantLabel', () => {
  it('names the model, the reasoning level and the providers it is held to', () => {
    expect(evalVariantLabel(evalVariantSchema.parse({ modelSlug: 'a/b' }))).toBe('a/b');
    expect(
      evalVariantLabel(
        evalVariantSchema.parse({
          modelSlug: 'a/b',
          reasoningLevel: 'high',
          providerRouting: { only: ['deepinfra'] },
        }),
      ),
    ).toBe('a/b · high @ deepinfra');
    expect(evalVariantLabel(evalVariantSchema.parse({ modelSlug: 'a/b', label: 'Cline' }))).toBe(
      'Cline',
    );
  });
});
