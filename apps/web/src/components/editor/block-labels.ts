'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type BlockCatalogEntry, type BlockGroup, buildBlockCatalog } from '@exocortex/editor';

/**
 * Every catalog entry whose name and one-liner live in `editor.blocks`.
 *
 * The catalog in `packages/editor` keeps its German `label` and `description`,
 * because that package is used on the server and knows no locale. The browser
 * shows the catalogue's words instead, looked up by the entry's stable `id`. An
 * id missing here (a block added to the catalog but not yet to the messages)
 * keeps the catalog's own German rather than showing a key.
 */
const TRANSLATED_BLOCK_IDS = [
  'paragraph',
  'heading-1',
  'heading-2',
  'heading-3',
  'blockquote',
  'code-block',
  'horizontal-rule',
  'bullet-list',
  'ordered-list',
  'task-list',
  'image',
  'table',
  'callout-info',
  'callout-note',
  'callout-success',
  'callout-warning',
  'callout-danger',
  'file',
  'video',
  'audio',
  'pdf',
  'page-link',
  'breadcrumb',
  'toggle',
  'columns',
  'database-embed',
  'block-math',
  'saved-query',
  'embed',
  'bookmark',
  'transclusion',
  'table-of-contents',
] as const;

type TranslatedBlockId = (typeof TRANSLATED_BLOCK_IDS)[number];

function isTranslatedBlockId(id: string): id is TranslatedBlockId {
  return (TRANSLATED_BLOCK_IDS as readonly string[]).includes(id);
}

/**
 * The block catalog with the label and the one-liner in the reader's language.
 *
 * The slash menu searches the label it is given, so a reader types the word
 * their own language uses; the catalog's keywords stay as a second way in.
 */
export function useLocalizedBlockCatalog(): readonly BlockCatalogEntry[] {
  const t = useTranslations('editor.blocks');
  return React.useMemo(
    () =>
      buildBlockCatalog().map((entry) =>
        isTranslatedBlockId(entry.id)
          ? { ...entry, label: t(`${entry.id}.label`), description: t(`${entry.id}.description`) }
          : entry,
      ),
    [t],
  );
}

/** The heading of one menu section, in the reader's language. */
export function useBlockGroupLabel(): (group: BlockGroup) => string {
  const t = useTranslations('editor.blockGroups');
  return React.useCallback((group: BlockGroup) => t(group), [t]);
}
