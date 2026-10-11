import { z } from 'zod';

import { idSchema } from './primitives';
import {
  WORKFLOW_LIMITS,
  workflowFieldNameSchema,
  type WorkflowOutputField,
  workflowOutputFieldSchema,
} from './workflow-graph';

/**
 * The structured result of a piece of work (issue #162).
 *
 * An agent node promises fields (`outputFields`); the work item it creates
 * carries them as `resultFields`, the run fills them in as
 * `structuredResult`, and a condition downstream branches on them instead of
 * parsing prose. A value is trusted because it was checked against the
 * declared fields, never because it parsed: `checkStructuredResult` is the
 * one check, asked by the API when the value is written and again by the
 * workflow when the node completes, so a value written before a field was
 * declared, or by a person, cannot slip past the second look.
 */

/** One value of a structured result. `null` is "not given". */
export const structuredResultValueSchema = z.union([
  z.string().max(2_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export type StructuredResultValue = z.infer<typeof structuredResultValueSchema>;

export const structuredResultSchema = z
  .record(workflowFieldNameSchema, structuredResultValueSchema)
  .refine((value) => Object.keys(value).length <= WORKFLOW_LIMITS.maxOutputFields, {
    message: `At most ${String(WORKFLOW_LIMITS.maxOutputFields)} fields`,
  });
export type StructuredResult = z.infer<typeof structuredResultSchema>;

/** The fields a piece of work promises; the agent node's `outputFields`, carried on. */
export const resultFieldsSchema = z
  .array(workflowOutputFieldSchema)
  .max(WORKFLOW_LIMITS.maxOutputFields)
  .refine((fields) => new Set(fields.map((field) => field.name)).size === fields.length, {
    message: 'Field names must be unique',
  });

export const STRUCTURED_RESULT_PROBLEM_CODES = [
  /** A field the work did not declare. */
  'unknown_field',
  /** A required field is missing or null. */
  'missing',
  /** A value of the wrong type. */
  'wrong_type',
  /** An `enum` value that is not one of the declared ones. */
  'not_allowed',
] as const;
export type StructuredResultProblemCode = (typeof STRUCTURED_RESULT_PROBLEM_CODES)[number];

export interface StructuredResultProblem {
  field: string;
  code: StructuredResultProblemCode;
}

/**
 * Checks a structured result against the declared fields.
 *
 * `complete` asks for every required field as well; without it only what is
 * there is checked, so a run may fill the fields in over several calls. A
 * field nobody declared is always a problem: a value no condition can name is
 * either a typo or a model inventing a contract of its own.
 */
export function checkStructuredResult(
  fields: readonly WorkflowOutputField[],
  value: Readonly<Record<string, unknown>> | null,
  options: { complete: boolean },
): StructuredResultProblem[] {
  const problems: StructuredResultProblem[] = [];
  const given = value ?? {};
  const declared = new Map(fields.map((field) => [field.name, field]));
  for (const name of Object.keys(given)) {
    if (!declared.has(name)) problems.push({ field: name, code: 'unknown_field' });
  }
  for (const field of fields) {
    const entry = given[field.name];
    if (entry === undefined || entry === null) {
      if (options.complete && field.required) problems.push({ field: field.name, code: 'missing' });
      continue;
    }
    const problem = valueProblem(field, entry);
    if (problem !== null) problems.push({ field: field.name, code: problem });
  }
  return problems;
}

function valueProblem(
  field: WorkflowOutputField,
  value: unknown,
): StructuredResultProblemCode | null {
  switch (field.type) {
    case 'string':
      return typeof value === 'string' ? null : 'wrong_type';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'wrong_type';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'wrong_type';
    case 'enum':
      if (typeof value !== 'string') return 'wrong_type';
      return field.values.includes(value) ? null : 'not_allowed';
  }
}

/** The problems as one line for a log, an error message or a model. */
export function describeStructuredResultProblems(
  problems: readonly StructuredResultProblem[],
): string {
  return problems.map((problem) => `${problem.field}: ${problem.code}`).join(', ');
}

/**
 * What a succeeded agent node leaves for the nodes after it. Conditions read
 * `fields`; everything else is provenance and a short summary for a person.
 */
export const workflowAgentResultSchema = z.object({
  outcome: z.enum(['review', 'done']),
  fields: structuredResultSchema,
  workItemId: idSchema,
  aiRunId: idSchema.nullable(),
  /** Pages the work recorded as its result. */
  resultDocumentIds: z.array(idSchema),
  /** Pages it was given. */
  contextDocumentIds: z.array(idSchema),
  /** The start of the work item's result text; the whole is on the item. */
  summary: z.string().nullable(),
  /** What this node's work and everything delegated below it cost. */
  spentMicroUsd: z.number().int().min(0),
});
export type WorkflowAgentResult = z.infer<typeof workflowAgentResultSchema>;

/**
 * A placeholder in an agent node's goal: `{{nodeId.field}}` for a field of an
 * upstream agent node's structured result, `{{input.key}}` for a value the
 * run was started with. The validation and the worker share this pattern, so
 * what publishing accepts is exactly what a run fills in.
 */
export const WORKFLOW_GOAL_PLACEHOLDER =
  /\{\{\s*([A-Za-z][A-Za-z0-9_-]{0,63})\.([A-Za-z][A-Za-z0-9_]{0,39})\s*\}\}/gu;

/** The placeholders of a goal, in order. */
export function workflowGoalPlaceholders(goal: string): { source: string; key: string }[] {
  return [...goal.matchAll(WORKFLOW_GOAL_PLACEHOLDER)].map((match) => ({
    source: match[1] ?? '',
    key: match[2] ?? '',
  }));
}

/** How much of the result text a node's output carries. */
export const WORKFLOW_RESULT_SUMMARY_MAX_CHARS = 1_000;
