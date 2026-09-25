import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type EntityType, entityTypeSchema } from '@exocortex/contracts';

/** Every entity type, in the order the pickers offer them. */
export const ENTITY_TYPES: readonly EntityType[] = entityTypeSchema.options;

/**
 * The name of an entity type in the reader's language. The German names in
 * `ENTITY_TYPE_LABELS` stay what the server writes into the entity database;
 * this is only how the browser shows a type.
 */
export function useEntityTypeLabel(): (type: EntityType) => string {
  const t = useTranslations('entities.types');
  return React.useCallback((type: EntityType) => t(type), [t]);
}
