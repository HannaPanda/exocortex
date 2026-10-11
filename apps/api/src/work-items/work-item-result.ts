import {
  checkStructuredResult,
  describeStructuredResultProblems,
  type UpdateWorkItemRequest,
  type WorkflowOutputField,
} from '@exocortex/contracts';
import { type Prisma } from '@exocortex/database';

import { AppError } from '../common/app-error';

/**
 * The structured result of a work item (issue #162).
 *
 * Checked whenever it is written, so a run that names a field nobody
 * declared, or answers a number with a word, hears it in the same call and
 * can correct itself while it still has the context. Handing the work in
 * (`review`) or closing it as `done` also asks for every required field: that
 * is the moment a workflow waiting on the item may read it. `failed` and
 * `cancelled` ask for nothing, because a piece of work must always be able to
 * say it did not work out.
 */
export function assertStructuredResult(
  fields: readonly WorkflowOutputField[],
  existing: { structuredResult: Prisma.JsonValue },
  request: UpdateWorkItemRequest,
): void {
  const handingIn = request.status === 'review' || request.status === 'done';
  if (request.structuredResult === undefined && !(handingIn && fields.length > 0)) return;
  const value =
    request.structuredResult !== undefined
      ? request.structuredResult
      : asRecord(existing.structuredResult);
  const problems = checkStructuredResult(fields, value, { complete: handingIn });
  if (problems.length === 0) return;
  throw new AppError(
    'work_item_result_invalid',
    `The structured result does not match the declared fields (${describeStructuredResultProblems(problems)})`,
    { problems },
  );
}

function asRecord(value: Prisma.JsonValue): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
