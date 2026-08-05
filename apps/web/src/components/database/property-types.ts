import {
  type DatabaseFilterOperator,
  type DatabaseOptionColor,
  type DatabasePropertyType,
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

/** Property types a user can add today. RELATION/ROLLUP/FORMULA are reserved server-side. */
export const CREATABLE_PROPERTY_TYPES = IMPLEMENTED_PROPERTY_TYPES;

export const COMPUTED_PROPERTY_TYPES = new Set<DatabasePropertyType>([
  'CREATED_TIME',
  'UPDATED_TIME',
  'CREATED_BY',
  'UPDATED_BY',
]);

export const ARRAY_PROPERTY_TYPES = new Set<DatabasePropertyType>(['MULTI_SELECT', 'PERSON', 'FILES']);

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
};

/** Which filter operators make sense for a given property type, in menu order. */
export function operatorsForType(type: DatabasePropertyType): DatabaseFilterOperator[] {
  if (type === 'NUMBER') return ['equals', 'not_equals', 'greater_than', 'less_than', 'is_empty', 'is_not_empty'];
  if (type === 'DATE' || type === 'CREATED_TIME' || type === 'UPDATED_TIME') {
    return ['on_or_after', 'on_or_before', 'is_empty', 'is_not_empty'];
  }
  if (type === 'CHECKBOX') return ['equals'];
  if (ARRAY_PROPERTY_TYPES.has(type)) return ['contains', 'not_contains', 'is_empty', 'is_not_empty'];
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
