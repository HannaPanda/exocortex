import { WORKFLOW_GOAL_PLACEHOLDER } from '@exocortex/contracts';

/**
 * Placeholders in an agent node's goal (issue #162).
 *
 * `{{nodeId.field}}` is a field of an upstream agent node's structured
 * result, `{{input.key}}` a value the run was started with (a page id for a
 * page change, the moment for a schedule). Deliberately no expressions, no
 * loops, no defaults: a goal is a sentence for a model, and the values that
 * fill it were checked against declared fields before anything could read
 * them. A placeholder nothing fills stays as it is, visibly, rather than
 * becoming an empty string that changes the sentence's meaning.
 */

export function renderGoalTemplate(
  goal: string,
  values: {
    input: unknown;
    outputs: ReadonlyMap<string, Record<string, unknown> | null>;
  },
): string {
  return goal.replace(WORKFLOW_GOAL_PLACEHOLDER, (whole, source: string, key: string) => {
    const value =
      source === 'input'
        ? recordOf(values.input)?.[key]
        : fieldsOf(values.outputs.get(source))?.[key];
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : whole;
  });
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** An agent node's output keeps its values under `fields`. */
function fieldsOf(
  output: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  return recordOf(output?.fields);
}
