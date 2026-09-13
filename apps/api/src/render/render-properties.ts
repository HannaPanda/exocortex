import { type PrismaClient } from '@exocortex/database';

/**
 * A database row's properties as plain strings, keyed by property name.
 *
 * A template variable is a string that ends up in a LaTeX document, so every
 * property type has to arrive as one. The conversions are deliberately plain --
 * a date is `YYYY-MM-DD`, a checkbox is Ja/Nein, a selection is its label --
 * because anything cleverer would be formatting, and formatting belongs in the
 * template where the author can see it.
 *
 * A page that is not a database row simply has none of this, and every
 * `PROPERTY` variable falls back to its default.
 */
export async function loadRenderProperties(
  prisma: PrismaClient,
  documentId: string,
): Promise<Record<string, string>> {
  const values = await prisma.documentPropertyValue.findMany({
    where: { documentId },
    select: {
      textValue: true,
      numberValue: true,
      boolValue: true,
      dateValue: true,
      jsonValue: true,
      property: { select: { id: true, name: true, type: true } },
    },
  });
  if (values.length === 0) return {};

  const optionIds = new Set<string>();
  for (const value of values) {
    if (value.property.type === 'SELECT' && value.textValue !== null) {
      optionIds.add(value.textValue);
    }
    if (value.property.type === 'MULTI_SELECT' && Array.isArray(value.jsonValue)) {
      for (const entry of value.jsonValue) {
        if (typeof entry === 'string') optionIds.add(entry);
      }
    }
  }

  const options =
    optionIds.size === 0
      ? []
      : await prisma.databasePropertyOption.findMany({
          where: { id: { in: [...optionIds] } },
          select: { id: true, label: true },
        });
  const labels = new Map(options.map((option) => [option.id, option.label]));

  const result: Record<string, string> = {};
  for (const value of values) {
    result[value.property.name] = stringify(value, labels);
  }
  return result;
}

function stringify(
  value: {
    textValue: string | null;
    numberValue: unknown;
    boolValue: boolean | null;
    dateValue: Date | null;
    jsonValue: unknown;
    property: { type: string };
  },
  labels: ReadonlyMap<string, string>,
): string {
  switch (value.property.type) {
    case 'NUMBER':
      return value.numberValue === null ? '' : String(value.numberValue);
    case 'CHECKBOX':
      return value.boolValue === true ? 'Ja' : 'Nein';
    case 'DATE':
      return value.dateValue === null ? '' : (value.dateValue.toISOString().slice(0, 10) ?? '');
    case 'SELECT':
      return value.textValue === null ? '' : (labels.get(value.textValue) ?? '');
    case 'MULTI_SELECT':
      return Array.isArray(value.jsonValue)
        ? value.jsonValue
            .map((entry) => (typeof entry === 'string' ? (labels.get(entry) ?? '') : ''))
            .filter((entry) => entry.length > 0)
            .join(', ')
        : '';
    default:
      return value.textValue ?? '';
  }
}
