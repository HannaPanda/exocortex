import {
  type DatabaseFilterCondition,
  type DatabaseFilterGroup,
  type DatabaseSort,
} from './database-views';

/**
 * What a view keeps of its filters and sorts once a column is gone.
 *
 * The query engine refuses a rule naming a property the database no longer
 * has (`UnknownDatabasePropertyError`), and it has to: that refusal is what
 * keeps a rule from reaching into another database. So a deleted column must
 * leave no rule behind, or every view that sorted or filtered by it stops
 * rendering. A sort rule naming it is dropped and the others keep their
 * priority; a filter condition naming it is dropped, and a group that is left
 * empty is dropped with it, because an empty `or` group would match nothing
 * where the person had asked for something.
 */
export function sortsWithoutProperty(
  sorts: readonly DatabaseSort[],
  propertyId: string,
): DatabaseSort[] {
  return sorts.filter((sort) => sort.propertyId !== propertyId);
}

export function filtersWithoutProperty(
  group: DatabaseFilterGroup,
  propertyId: string,
): DatabaseFilterGroup {
  const conditions: (DatabaseFilterCondition | DatabaseFilterGroup)[] = [];
  for (const entry of group.conditions) {
    if ('combinator' in entry) {
      const nested = filtersWithoutProperty(entry, propertyId);
      if (nested.conditions.length > 0) conditions.push(nested);
      continue;
    }
    if (entry.propertyId !== propertyId) conditions.push(entry);
  }
  return { combinator: group.combinator, conditions };
}

/** Whether a filter tree names the property anywhere. */
export function filtersMentionProperty(group: DatabaseFilterGroup, propertyId: string): boolean {
  return group.conditions.some((entry) =>
    'combinator' in entry
      ? filtersMentionProperty(entry, propertyId)
      : entry.propertyId === propertyId,
  );
}
