'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type DatabasePropertyType,
  FORMULA_ERROR_TYPE_ARGS,
  FORMULA_FUNCTIONS,
  type FormulaErrorDetail,
  type FormulaValueType,
  readFormulaErrorDetail,
} from '@exocortex/contracts';

import { usePropertyTypeLabel } from './property-types';

const VALUE_TYPES: ReadonlySet<string> = new Set<FormulaValueType>([
  'number',
  'text',
  'boolean',
  'date',
]);

/**
 * The functions whose one-line help lives in `database.config.formula.functions`.
 * The catalogue in `packages/contracts` keeps its German `hint` as the
 * reference; a function missing here (added to the catalogue but not yet to
 * the messages) keeps that hint.
 */
const TRANSLATED_FORMULA_FUNCTIONS = [
  'if',
  'not',
  'and',
  'or',
  'empty',
  'format',
  'concat',
  'length',
  'upper',
  'lower',
  'contains',
  'abs',
  'floor',
  'ceil',
  'round',
  'min',
  'max',
  'now',
  'dateAdd',
  'dateDiffDays',
  'year',
  'month',
  'day',
] as const;

type TranslatedFormulaFunction = (typeof TRANSLATED_FORMULA_FUNCTIONS)[number];

function isTranslatedFormulaFunction(name: string): name is TranslatedFormulaFunction {
  return (TRANSLATED_FORMULA_FUNCTIONS as readonly string[]).includes(name);
}

/** The one-line help of a formula function, in the reader's language where there is one. */
export function useFormulaFunctionHint(): (name: string) => string {
  const t = useTranslations('database.config.formula.functions');
  return React.useCallback(
    (name: string) =>
      isTranslatedFormulaFunction(name)
        ? t(name)
        : Object.hasOwn(FORMULA_FUNCTIONS, name)
          ? (FORMULA_FUNCTIONS[name]?.hint ?? name)
          : name,
    [t],
  );
}

/** The formula problem inside an API error's `details`, with the column it was found in. */
export interface ApiFormulaError extends FormulaErrorDetail {
  propertyName: string | null;
}

/**
 * Reads what `assertDerivedPropertiesCompile` puts into `details.formula`
 * (issue #98). `null` for every other error, which then reads as its code.
 */
export function apiFormulaError(error: unknown): ApiFormulaError | null {
  if (typeof error !== 'object' || error === null) return null;
  const details = (error as { details?: unknown }).details;
  if (typeof details !== 'object' || details === null) return null;
  const formula = (details as { formula?: unknown }).formula;
  const detail = readFormulaErrorDetail(formula);
  if (detail === null) return null;
  const name = (formula as { propertyName?: unknown }).propertyName;
  return { ...detail, propertyName: typeof name === 'string' ? name : null };
}

/**
 * Turns a formula error code into a sentence in the reader's language.
 *
 * The server sends a code and its arguments, never a sentence: the same
 * message renders on every client in its own language, and one still on
 * screen follows a change of language. Types and property types among the
 * arguments are words too, so they are translated before they are placed.
 */
export function useFormulaErrorMessage(): (
  detail: FormulaErrorDetail,
  propertyName?: string | null,
) => string {
  const t = useTranslations('database.formulaErrors');
  const functionHint = useFormulaFunctionHint();
  const propertyTypeLabel = usePropertyTypeLabel();

  return React.useCallback(
    (detail, propertyName = null) => {
      const args: Record<string, string | number> = {};
      for (const [key, value] of Object.entries(detail.args)) {
        if (
          FORMULA_ERROR_TYPE_ARGS.has(key) &&
          typeof value === 'string' &&
          VALUE_TYPES.has(value)
        ) {
          args[key] = t(`types.${value as FormulaValueType}`);
        } else if (key === 'propertyType' && typeof value === 'string') {
          args[key] = propertyTypeLabel(value as DatabasePropertyType);
        } else {
          args[key] = value;
        }
      }
      if (detail.code === 'arity') args.hint = functionHint(String(detail.args.name ?? ''));
      const message = t(`codes.${detail.code}`, args);
      return propertyName === null ? message : t('inColumn', { column: propertyName, message });
    },
    [t, functionHint, propertyTypeLabel],
  );
}
