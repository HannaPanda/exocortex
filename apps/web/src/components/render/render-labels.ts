import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type RenderJobStatus,
  type RenderSource,
  type RenderVariableOrigin,
} from '@exocortex/contracts';

/**
 * The words for the enums a render is made of (issue #44, ADR-026).
 *
 * Their own file for the reason `automation-labels.ts` has one: a dialog, a
 * template form and a list of past builds that disagreed about what `SUBTREE`
 * is called would read like three different features. The words live in the
 * `render` catalogue; this file holds the orders and the hooks that read them.
 */

export const RENDER_SOURCE_ORDER: readonly RenderSource[] = ['DOCUMENT', 'SUBTREE'];

export const VARIABLE_ORIGIN_ORDER: readonly RenderVariableOrigin[] = [
  'MANUAL',
  'TITLE',
  'PATH',
  'AUTHOR',
  'TODAY',
  'PROPERTY',
];

export function renderStatusVariant(
  status: RenderJobStatus,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'FAILED') return 'destructive';
  if (status === 'COMPLETED') return 'default';
  if (status === 'CANCELLED') return 'outline';
  return 'secondary';
}

/** The names of a render's status, scope and variable origins in the reader's language. */
export function useRenderWording() {
  const t = useTranslations('render');
  return React.useMemo(
    () => ({
      status: (status: RenderJobStatus): string => t(`statuses.${status}`),
      source: (source: RenderSource): string => t(`sources.${source}`),
      variableOrigin: (origin: RenderVariableOrigin): string => t(`variableOrigins.${origin}`),
    }),
    [t],
  );
}

const BYTE_UNIT_OPTIONS = { style: 'unit', unitDisplay: 'short' } as const;

/**
 * Timestamps and file sizes as a list of builds shows them, in the reader's
 * locale. Shared by the render dialog and the project build history.
 */
export function useBuildFormat() {
  const format = useFormatter();
  return React.useMemo(
    () => ({
      /** A timestamp in the local zone, without the year most rows share. */
      moment: (iso: string): string =>
        format.dateTime(new Date(iso), {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        }),
      /** A file size a person reads at a glance. */
      bytes: (byteSize: number | null): string => {
        if (byteSize === null) return '';
        if (byteSize < 1024) return format.number(byteSize, { ...BYTE_UNIT_OPTIONS, unit: 'byte' });
        if (byteSize < 1024 * 1024)
          return format.number(byteSize / 1024, {
            ...BYTE_UNIT_OPTIONS,
            unit: 'kilobyte',
            maximumFractionDigits: 0,
          });
        return format.number(byteSize / (1024 * 1024), {
          ...BYTE_UNIT_OPTIONS,
          unit: 'megabyte',
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        });
      },
    }),
    [format],
  );
}
