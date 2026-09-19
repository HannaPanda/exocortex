import {
  ARRAY_VALUED_PROPERTY_TYPES,
  CONFIGURED_PROPERTY_TYPES,
  type DatabaseFilterOperator,
  type DatabaseOptionColor,
  type DatabaseProperty,
  type DatabasePropertyType,
  DERIVED_PROPERTY_TYPES,
  IMPLEMENTED_PROPERTY_TYPES,
} from '@exocortex/contracts';

/** German label for every implemented property type, shown in the "+ Eigenschaft" menu. */
export const PROPERTY_TYPE_LABELS: Record<DatabasePropertyType, string> = {
  TEXT: 'Text',
  NUMBER: 'Zahl',
  SELECT: 'Auswahl',
  MULTI_SELECT: 'Mehrfachauswahl',
  DATE: 'Datum',
  CHECKBOX: 'Kontrollkästchen',
  URL: 'URL',
  EMAIL: 'E-Mail',
  PHONE: 'Telefon',
  PERSON: 'Person',
  FILES: 'Dateien',
  CREATED_TIME: 'Erstellt am',
  UPDATED_TIME: 'Zuletzt bearbeitet am',
  CREATED_BY: 'Erstellt von',
  UPDATED_BY: 'Zuletzt bearbeitet von',
  RELATION: 'Verknüpfung',
  ROLLUP: 'Rollup',
  FORMULA: 'Formel',
};

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

export const FILTER_OPERATOR_LABELS: Record<DatabaseFilterOperator, string> = {
  equals: 'ist',
  not_equals: 'ist nicht',
  contains: 'enthält',
  not_contains: 'enthält nicht',
  is_empty: 'ist leer',
  is_not_empty: 'ist nicht leer',
  greater_than: 'größer als',
  less_than: 'kleiner als',
  on_or_after: 'ab',
  on_or_before: 'bis',
  overlaps: 'liegt im Zeitraum',
};

/**
 * The values a filter for this property can take, when they are a closed set.
 * A select stores the option's *id*, never its label, so the picker offers the
 * label and hands the id to the filter. An empty list means "free text".
 */
export function filterValueChoices(property: DatabaseProperty): { value: string; label: string }[] {
  if (property.type === 'CHECKBOX') {
    return [
      { value: 'true', label: 'Angehakt' },
      { value: 'false', label: 'Nicht angehakt' },
    ];
  }
  if (property.type === 'SELECT' || property.type === 'MULTI_SELECT') {
    return property.options.map((option) => ({ value: option.id, label: option.label }));
  }
  return [];
}

/** The chip's reading of a stored filter value: an option id becomes its label. */
export function filterValueLabel(property: DatabaseProperty | undefined, value: unknown): string {
  if (property !== undefined) {
    if (property.type === 'CHECKBOX')
      return value === true || value === 'true' ? 'angehakt' : 'nicht angehakt';
    if (property.type === 'SELECT' || property.type === 'MULTI_SELECT') {
      const option = property.options.find((entry) => entry.id === value);
      if (option !== undefined) return option.label;
    }
  }
  return String(value);
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

export const OPTION_COLOR_LABELS: Record<DatabaseOptionColor, string> = {
  gray: 'Grau',
  brown: 'Braun',
  orange: 'Orange',
  yellow: 'Gelb',
  green: 'Grün',
  blue: 'Blau',
  purple: 'Violett',
  pink: 'Pink',
  red: 'Rot',
};

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
