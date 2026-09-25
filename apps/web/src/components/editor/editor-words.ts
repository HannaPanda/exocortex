'use client';

import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';

import { isAttachmentTextErrorCode } from '@exocortex/contracts';
import { type EditorWords } from '@exocortex/editor';

/**
 * The words of the editor's hand-built node views, in the reader's language
 * (issue #98).
 *
 * `packages/editor` draws the file and PDF blocks, the breadcrumb, the table
 * of contents and the toggle button itself, and knows no locale; it takes
 * these through `buildEditorExtensions({ words })`. Stable for as long as the
 * language is, because the editor is rebuilt whenever they change.
 */
export function useEditorWords(): EditorWords {
  const t = useTranslations('editor.nodeViews');
  const format = useFormatter();

  return React.useMemo(() => {
    // A day is read in UTC, like the file's own date it comes from.
    const day = (iso: string): string | null => {
      const parsed = new Date(iso);
      return Number.isNaN(parsed.getTime())
        ? null
        : format.dateTime(parsed, { dateStyle: 'medium', timeZone: 'UTC' });
    };
    return {
      media: {
        open: t('media.open'),
        download: t('media.download'),
        pages: (count) => t('media.pages', { count }),
        tables: (count) => t('media.tables', { count }),
        pictures: (count) => t('media.pictures', { count }),
        ocrUsed: t('media.ocrUsed'),
        day,
        status: {
          not_applicable: t('media.status.notApplicable'),
          pending: t('media.status.pending'),
          ready: t('media.status.ready'),
          failed: t('media.status.failed'),
        },
        corrected: t('media.corrected'),
        truncated: t('media.truncated'),
        retry: t('media.retry'),
        extract: t('media.extract'),
        reextract: t('media.reextract'),
        view: t('media.view'),
        textError: (code) =>
          isAttachmentTextErrorCode(code)
            ? t(`media.textErrors.${code}`)
            : t('media.textErrors.unknown'),
        dialog: {
          discard: t('media.dialog.discard'),
          save: t('media.dialog.save'),
          close: t('media.dialog.close'),
          corrected: (when) =>
            when === null
              ? t('media.dialog.corrected')
              : t('media.dialog.correctedOn', { day: when }),
          truncated: t('media.dialog.truncated'),
          lastError: (reason) => t('media.dialog.lastError', { reason }),
          failed: t('media.dialog.failed'),
        },
      },
      breadcrumb: { label: t('breadcrumb.label'), empty: t('breadcrumb.empty') },
      tableOfContents: { label: t('tableOfContents.label'), empty: t('tableOfContents.empty') },
      toggle: { collapse: t('toggle.collapse'), expand: t('toggle.expand') },
      embed: { frameTitle: t('embed.frameTitle') },
    };
  }, [t, format]);
}
