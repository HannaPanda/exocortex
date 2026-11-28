import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  ARRAY_VALUED_PROPERTY_TYPES,
  CONFIGURED_PROPERTY_TYPES,
  type DatabaseFilterOperator,
  type DatabaseOptionColor,
  type DatabaseProperty,
  type DatabasePropertyType,
  DERIVED_PROPERTY_TYPES,
  IMPLEMENTED_PROPERTY_TYPES,
  type WorkspacePerson,
} from '@exocortex/contracts';

/**
 * The name of a property type in the reader's language, as the "+ Eigenschaft"
 * menu, the column menu and the row sheet show it.
 */
export function usePropertyTypeLabel(): (type: DatabasePropertyType) => string {
  const t = useTranslations('database.propertyTypes');
  return React.useCallback((type: DatabasePropertyType) => t(type), [t]);
}

/**
 * `base`, or the first of "base 2", "base 3", … that no column of this
 * database carries yet (issue #259). Names are compared trimmed and without
 * regard to case, because "datum" beside "Datum" reads as the same column and
 * a formula's `prop("…")` would no longer say which one it means. `numbered`
 * spells the suffix in the reader's language.
 */
export function uniquePropertyName(
  base: string,
  taken: readonly string[],
  numbered: (name: string, number: number) => string,
): string {
  const used = new Set(taken.map((name) => name.trim().toLocaleLowerCase()));
  if (!used.has(base.trim().toLocaleLowerCase())) return base;
  for (let number = 2; ; number += 1) {
    const candidate = numbered(base, number);
    if (!used.has(candidate.trim().toLocaleLowerCase())) return candidate;
  }
}

/**
 * The name a new column of this type is offered before anybody types one, in
 * the reader's language and unique among `taken` (issue #259). The words live
 * under `database.addProperty.defaultNames`, one per type, so a type added to
 * `DatabasePropertyType` without its default name fails the typecheck here.
 */
export function useDefaultPropertyName(): (
  type: DatabasePropertyType,
  taken: readonly string[],
) => string {
  const t = useTranslations('database.addProperty');
  return React.useCallback(
    (type: DatabasePropertyType, taken: readonly string[]) =>
      uniquePropertyName(t(`defaultNames.${type}`), taken, (name, number) =>
        t('numberedName', { name, number }),
      ),
    [t],
  );
}

/** Property types a user can add today. */
export const CREATABLE_PROPERTY_TYPES = IMPLEMENTED_PROPERTY_TYPES;

export const COMPUTED_PROPERTY_TYPES = new Set<DatabasePropertyType>([
  'CREATED_TIME',
  'UPDATED_TIME',
  'CREATED_BY',
  'UPDATED_BY',
]);

/** Computed by the query engine from other rows: shown, never edited in a cell. */
export const DERIVED_PROPERTY_TYPE_SET = new Set<DatabasePropertyType>(DERIVED_PROPERTY_TYPES);

/** Types whose meaning lives entirely in `config`, so adding one needs a form first. */
export const CONFIGURED_PROPERTY_TYPE_SET = new Set<DatabasePropertyType>(
  CONFIGURED_PROPERTY_TYPES,
);

/**
 * Types whose value is a list of ids. SELECT-style options only exist for the
 * first two; a relation picks rows and a person picks members, so the option
 * manager stays off them.
 */
export const ARRAY_PROPERTY_TYPES = new Set<DatabasePropertyType>(ARRAY_VALUED_PROPERTY_TYPES);

/** The subset of the above that carries `DatabasePropertyOption` rows. */
export const OPTION_PROPERTY_TYPES = new Set<DatabasePropertyType>(['SELECT', 'MULTI_SELECT']);

/** How the two sides of a checkbox read, handed in so these helpers stay pure. */
export interface CheckboxWords {
  checked: string;
  unchecked: string;
}

/**
 * The values a filter for this property can take, when they are a closed set.
 * A select stores the option's *id*, never its label, so the picker offers the
 * label and hands the id to the filter. An empty list means "free text".
 */
export function filterValueChoices(
  property: DatabaseProperty,
  words: CheckboxWords,
  people: readonly WorkspacePerson[] = [],
): { value: string; label: string }[] {
  // A person is stored by account id; the filter offers the member's name
  // (issue #314). Without a member list it stays free text.
  if (property.type === 'PERSON') {
    return people.map((person) => ({ value: person.userId, label: person.name }));
  }
  if (property.type === 'CHECKBOX') {
    return [
      { value: 'true', label: words.checked },
      { value: 'false', label: words.unchecked },
    ];
  }
  if (property.type === 'SELECT' || property.type === 'MULTI_SELECT') {
    return property.options.map((option) => ({ value: option.id, label: option.label }));
  }
  return [];
}

/** The chip's reading of a stored filter value: an option id becomes its label. */
export function filterValueLabel(
  property: DatabaseProperty | undefined,
  value: unknown,
  words: CheckboxWords,
  people: readonly WorkspacePerson[] = [],
): string {
  if (property !== undefined) {
    if (property.type === 'PERSON') {
      const person = people.find((entry) => entry.userId === value);
      if (person !== undefined) return person.name;
    }
    if (property.type === 'CHECKBOX')
      return value === true || value === 'true' ? words.checked : words.unchecked;
    if (property.type === 'SELECT' || property.type === 'MULTI_SELECT') {
      const option = property.options.find((entry) => entry.id === value);
      if (option !== undefined) return option.label;
    }
  }
  return String(value);
}

/**
 * Everything a filter chip and a filter form say, in the reader's language:
 * the operator, the closed value set to pick from, and a stored value read
 * back. Shared by the database's filter bar and the saved-query builder, so
 * the same condition reads the same in both. `people` names a Person value
 * (issue #314); without it one reads as the account id it is stored as.
 */
export function useFilterWording(people: readonly WorkspacePerson[] | null = null) {
  const t = useTranslations('database.filters');
  return React.useMemo(() => {
    const known = people ?? [];
    const choiceWords = { checked: t('checkedChoice'), unchecked: t('uncheckedChoice') };
    const valueWords = { checked: t('checkedValue'), unchecked: t('uncheckedValue') };
    return {
      operator: (operator: DatabaseFilterOperator): string => t(`operators.${operator}`),
      choices: (property: DatabaseProperty) => filterValueChoices(property, choiceWords, known),
      valueLabel: (property: DatabaseProperty | undefined, value: unknown): string =>
        filterValueLabel(property, value, valueWords, known),
    };
  }, [t, people]);
}

/** Which filter operators make sense for a given property type, in menu order. */
export function operatorsForType(type: DatabasePropertyType): DatabaseFilterOperator[] {
  if (type === 'NUMBER' || type === 'ROLLUP')
    return ['equals', 'not_equals', 'greater_than', 'less_than', 'is_empty', 'is_not_empty'];
  // A formula answers a number, a text, a date or a yes/no depending on what
  // it says, and only the server knows which. The full list is offered rather
  // than a guessed subset; an operator that does not fit the result type is
  // refused by the API with a message naming the mismatch.
  if (type === 'FORMULA')
    return [
      'equals',
      'not_equals',
      'contains',
      'not_contains',
      'greater_than',
      'less_than',
      'is_empty',
      'is_not_empty',
    ];
  if (type === 'DATE' || type === 'CREATED_TIME' || type === 'UPDATED_TIME') {
    return ['on_or_after', 'on_or_before', 'is_empty', 'is_not_empty'];
  }
  if (type === 'CHECKBOX') return ['equals'];
  if (ARRAY_PROPERTY_TYPES.has(type))
    return ['contains', 'not_contains', 'is_empty', 'is_not_empty'];
  return ['equals', 'not_equals', 'contains', 'not_contains', 'is_empty', 'is_not_empty'];
}

/** The nine `--content-*` token colours from packages/ui/src/tokens.css, never a hex value. */
export const OPTION_COLORS: DatabaseOptionColor[] = [
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
];

/** The name of an option colour in the reader's language. */
export function useOptionColorLabel(): (color: DatabaseOptionColor) => string {
  const t = useTranslations('database.optionColors');
  return React.useCallback((color: DatabaseOptionColor) => t(color), [t]);
}

/**
 * Tailwind classes per option colour, written out rather than interpolated:
 * Tailwind only emits classes it can see literally in the source (same
 * approach as `apps/web/src/components/editor/color-menu.tsx`).
 */
export const OPTION_COLOR_TEXT_CLASS: Record<DatabaseOptionColor, string> = {
  gray: 'text-content-gray',
  brown: 'text-content-brown',
  orange: 'text-content-orange',
  yellow: 'text-content-yellow',
  green: 'text-content-green',
  blue: 'text-content-blue',
  purple: 'text-content-purple',
  pink: 'text-content-pink',
  red: 'text-content-red',
};

export const OPTION_COLOR_BG_CLASS: Record<DatabaseOptionColor, string> = {
  gray: 'bg-content-bg-gray',
  brown: 'bg-content-bg-brown',
  orange: 'bg-content-bg-orange',
  yellow: 'bg-content-bg-yellow',
  green: 'bg-content-bg-green',
  blue: 'bg-content-bg-blue',
  purple: 'bg-content-bg-purple',
  pink: 'bg-content-bg-pink',
  red: 'bg-content-bg-red',
};
