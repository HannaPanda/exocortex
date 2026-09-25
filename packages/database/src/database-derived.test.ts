import { describe, expect, it } from 'vitest';

import { FormulaError } from '@exocortex/contracts';

import {
  assertRollupTargetIsUsable,
  buildDerivedSchema,
  compileDerived,
  type DatabasePropertyRef,
  DerivedPropertyError,
  derivedResultType,
} from './database-derived';

const TASKS = 'coll_tasks';
const PROJECTS = 'coll_projects';

const taskCost: DatabasePropertyRef = {
  id: 'prop_cost',
  documentId: TASKS,
  name: 'Kosten',
  type: 'NUMBER',
};
const taskDue: DatabasePropertyRef = {
  id: 'prop_due',
  documentId: TASKS,
  name: 'Fällig',
  type: 'DATE',
};
const taskTitle: DatabasePropertyRef = {
  id: 'prop_title',
  documentId: TASKS,
  name: 'Kurztitel',
  type: 'TEXT',
};
const projectTasks: DatabasePropertyRef = {
  id: 'prop_tasks',
  documentId: PROJECTS,
  name: 'Aufgaben',
  type: 'RELATION',
  config: { targetCollectionId: TASKS, allowMultiple: true },
};
const projectBudget: DatabasePropertyRef = {
  id: 'prop_budget',
  documentId: PROJECTS,
  name: 'Budget',
  type: 'NUMBER',
};

function rollup(id: string, config: Record<string, unknown>): DatabasePropertyRef {
  return { id, documentId: PROJECTS, name: id, type: 'ROLLUP', config };
}

function formula(id: string, expression: string, documentId = PROJECTS): DatabasePropertyRef {
  return { id, documentId, name: id, type: 'FORMULA', config: { expression } };
}

const BASE = [taskCost, taskDue, taskTitle, projectTasks, projectBudget];

describe('compileDerived for a rollup', () => {
  it('counts the linked rows without touching the target database', () => {
    const property = rollup('prop_count', {
      relationPropertyId: projectTasks.id,
      targetPropertyId: null,
      aggregate: 'count',
    });
    const sql = compileDerived(property, buildDerivedSchema([...BASE, property]));
    expect(sql.sql).toContain('jsonb_array_length');
    expect(sql.sql).not.toContain('link_document');
    expect(sql.values).toContain(projectTasks.id);
  });

  it('treats a cleared relation value as an empty list rather than raising', () => {
    const property = rollup('prop_count', {
      relationPropertyId: projectTasks.id,
      targetPropertyId: null,
      aggregate: 'count',
    });
    const sql = compileDerived(property, buildDerivedSchema([...BASE, property]));
    expect(sql.sql).toContain('jsonb_typeof');
    expect(sql.sql).toContain("'[]'::jsonb");
  });

  it('sums a number column of the linked database and leaves out archived rows', () => {
    const property = rollup('prop_sum', {
      relationPropertyId: projectTasks.id,
      targetPropertyId: taskCost.id,
      aggregate: 'sum',
    });
    const sql = compileDerived(property, buildDerivedSchema([...BASE, property]));
    expect(sql.sql).toContain('COALESCE(SUM(');
    expect(sql.sql).toContain('"archivedAt" IS NULL');
    expect(sql.values).toContain(taskCost.id);
  });

  it('reads the date column for earliest', () => {
    const property = rollup('prop_first', {
      relationPropertyId: projectTasks.id,
      targetPropertyId: taskDue.id,
      aggregate: 'earliest',
    });
    const sql = compileDerived(property, buildDerivedSchema([...BASE, property]));
    expect(sql.sql).toContain('MIN(');
    expect(sql.sql).toContain('"dateValue"');
  });

  it('refuses a sum over a text column', () => {
    const property = rollup('prop_sum', {
      relationPropertyId: projectTasks.id,
      targetPropertyId: taskTitle.id,
      aggregate: 'sum',
    });
    expect(() => compileDerived(property, buildDerivedSchema([...BASE, property]))).toThrow(
      /number column/,
    );
  });

  it('refuses a rollup whose relation is not a relation', () => {
    const property = rollup('prop_bad', {
      relationPropertyId: projectBudget.id,
      targetPropertyId: null,
      aggregate: 'count',
    });
    expect(() => compileDerived(property, buildDerivedSchema([...BASE, property]))).toThrow(
      DerivedPropertyError,
    );
  });

  it('refuses to aggregate over another derived column', () => {
    const inner = rollup('prop_inner', {
      relationPropertyId: projectTasks.id,
      targetPropertyId: null,
      aggregate: 'count',
    });
    expect(() => assertRollupTargetIsUsable('sum', inner)).toThrow(/plain column/);
  });

  it('answers a number for a count and a date for a latest', () => {
    const count = rollup('prop_count', {
      relationPropertyId: projectTasks.id,
      targetPropertyId: null,
      aggregate: 'count',
    });
    const latest = rollup('prop_latest', {
      relationPropertyId: projectTasks.id,
      targetPropertyId: taskDue.id,
      aggregate: 'latest',
    });
    const schema = buildDerivedSchema([...BASE, count, latest]);
    expect(derivedResultType(count, schema)).toBe('number');
    expect(derivedResultType(latest, schema)).toBe('date');
  });
});

describe('compileDerived for a formula', () => {
  it('resolves a column by its name inside its own database', () => {
    const property = formula('prop_double', 'prop("Budget") * 2');
    const sql = compileDerived(property, buildDerivedSchema([...BASE, property]));
    expect(sql.values).toContain(projectBudget.id);
    expect(sql.sql).toContain('::numeric');
  });

  it('resolves a column by its id as well', () => {
    const property = formula('prop_double', `prop("${projectBudget.id}") * 2`);
    expect(() => compileDerived(property, buildDerivedSchema([...BASE, property]))).not.toThrow();
  });

  it('does not see a column of another database', () => {
    const property = formula('prop_wrong', 'prop("Kosten") + 1');
    expect(() => compileDerived(property, buildDerivedSchema([...BASE, property]))).toThrow(
      /Unknown column/,
    );
  });

  it('guards a division so a zero cannot take the query down', () => {
    const property = formula('prop_share', 'prop("Budget") / prop("Budget")');
    const sql = compileDerived(property, buildDerivedSchema([...BASE, property]));
    expect(sql.sql).toContain('NULLIF(');
  });

  it('reads a rollup of the same database', () => {
    const count = rollup('prop_count', {
      relationPropertyId: projectTasks.id,
      targetPropertyId: null,
      aggregate: 'count',
    });
    const property = formula('prop_per', 'prop("Budget") / prop("prop_count")');
    const schema = buildDerivedSchema([...BASE, count, property]);
    const sql = compileDerived(property, schema);
    expect(sql.sql).toContain('jsonb_array_length');
    expect(derivedResultType(property, schema)).toBe('number');
  });

  it('catches a formula that reads itself', () => {
    const property = formula('prop_self', 'prop("prop_self") + 1');
    expect(() => compileDerived(property, buildDerivedSchema([...BASE, property]))).toThrow(
      FormulaError,
    );
  });

  it('catches two formulas defined in terms of each other', () => {
    const left = formula('prop_left', 'prop("prop_right") + 1');
    const right = formula('prop_right', 'prop("prop_left") + 1');
    expect(() => compileDerived(left, buildDerivedSchema([...BASE, left, right]))).toThrow(
      /depends on itself|nested too deeply/,
    );
  });

  it('reads an unchecked box as false rather than as unknown', () => {
    const done: DatabasePropertyRef = {
      id: 'prop_done',
      documentId: PROJECTS,
      name: 'Erledigt',
      type: 'CHECKBOX',
    };
    const property = formula('prop_state', 'if(prop("Erledigt"); "fertig"; "offen")');
    const sql = compileDerived(property, buildDerivedSchema([...BASE, done, property]));
    expect(sql.sql).toContain('COALESCE(');
    expect(sql.sql).toContain('false');
  });

  it('refuses to read a files column', () => {
    const files: DatabasePropertyRef = {
      id: 'prop_files',
      documentId: PROJECTS,
      name: 'Dateien',
      type: 'FILES',
    };
    const property = formula('prop_files_text', 'prop("Dateien")');
    expect(() => compileDerived(property, buildDerivedSchema([...BASE, files, property]))).toThrow(
      /FILES/,
    );
  });

  it('passes every literal as a bind parameter, never as SQL text', () => {
    const property = formula('prop_inject', 'concat("\'; DROP TABLE document; --")');
    const sql = compileDerived(property, buildDerivedSchema([...BASE, property]));
    expect(sql.sql).not.toContain('DROP TABLE');
    expect(sql.values).toContain("'; DROP TABLE document; --");
  });
});
