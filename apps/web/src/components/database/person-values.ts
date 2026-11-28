import { type DatabaseRowPerson, type WorkspacePerson } from '@exocortex/contracts';

/**
 * Who a Person value names, worked out in the browser (issue #314). Pure, so
 * the cell, the card and the filter read a name the same way.
 */

/**
 * - `member`: somebody in the workspace now.
 * - `former`: the account exists and has left the workspace; the name stays.
 * - `deleted`: the row was answered and its `people` do not know the id.
 * - `unknown`: nothing to ask yet -- no row (several rows edited at once) and
 *   no member list (still loading, or a reader who may not list members).
 */
export type PersonState = 'member' | 'former' | 'deleted' | 'unknown';

export interface ResolvedPerson {
  id: string;
  /** Null for a deleted or an unknown account: the cell says so in words. */
  name: string | null;
  state: PersonState;
}

/** A PERSON value is a list, a CREATED_BY or UPDATED_BY value one id. */
export function personIdsOfValue(value: unknown): string[] {
  if (typeof value === 'string') return value.length === 0 ? [] : [value];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * The row's own answer wins, because it knows who left. The member list
 * comes second: a person just picked is not in the row until it is saved.
 */
export function resolvePerson(
  id: string,
  rowPeople: readonly DatabaseRowPerson[] | undefined,
  members: readonly WorkspacePerson[] | null,
): ResolvedPerson {
  const fromRow = rowPeople?.find((person) => person.id === id);
  if (fromRow !== undefined) {
    return { id, name: fromRow.name, state: fromRow.member ? 'member' : 'former' };
  }
  const member = members?.find((person) => person.userId === id);
  if (member !== undefined) return { id, name: member.name, state: 'member' };
  return { id, name: null, state: rowPeople === undefined ? 'unknown' : 'deleted' };
}

/**
 * What a picker offers: every member, then anybody the cell named when it
 * opened who is not a member any more, so taking somebody out by mistake can
 * be undone before the picker closes.
 */
export function pickerChoices(
  members: readonly WorkspacePerson[] | null,
  openedWith: readonly string[],
): string[] {
  const ids = (members ?? []).map((member) => member.userId);
  const known = new Set(ids);
  return [...ids, ...openedWith.filter((id) => !known.has(id))];
}

/** Whether two lists name the same people in the same order. */
export function samePeople(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}
