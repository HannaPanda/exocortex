import {
  DOCUMENT_ICON_COLORS,
  type DocumentIconColor,
  type DocumentLinkMatch,
  type DocumentSummary,
} from '@exocortex/contracts';

/**
 * How a `document` row becomes the object a caller sees.
 *
 * Shared by every service in this folder: the column list, the enum mappings
 * and the two converters have to agree, and they only agree if there is one of
 * each.
 */

export interface DocumentRow {
  id: string;
  workspaceId: string;
  parentId: string | null;
  type: 'PAGE' | 'COLLECTION';
  title: string;
  icon: string | null;
  /** Validated by the contract, so the column is a plain string here. */
  iconColor: string | null;
  layout: 'NARROW' | 'WIDE' | 'FULL';
  coverAttachmentId: string | null;
  coverPosition: number;
  orderKey: string;
  createdById: string;
  updatedById: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

/** Row shape of the raw `resolveLink` query; a strict subset of `DocumentRow`. */
export interface ResolveLinkRow {
  id: string;
  workspaceId: string;
  type: 'PAGE' | 'COLLECTION';
  title: string;
  icon: string | null;
  iconColor: string | null;
  archivedAt: Date | null;
}

/** Exported so every service that hands a row to `toSummary` selects the same columns. */
export const DOCUMENT_SELECT = {
  id: true,
  workspaceId: true,
  parentId: true,
  type: true,
  title: true,
  icon: true,
  iconColor: true,
  layout: true,
  coverAttachmentId: true,
  coverPosition: true,
  orderKey: true,
  createdById: true,
  updatedById: true,
  createdAt: true,
  updatedAt: true,
  archivedAt: true,
} as const;

export const AI_RULE_MODE_TO_CONTRACT = {
  OFF: 'off',
  ALWAYS: 'always',
  ON_DEMAND: 'on_demand',
} as const;

export const AI_RULE_MODE_TO_DB = {
  off: 'OFF',
  always: 'ALWAYS',
  on_demand: 'ON_DEMAND',
} as const;

export const LAYOUT_TO_CONTRACT = {
  NARROW: 'narrow',
  WIDE: 'wide',
  FULL: 'full',
} as const;

export const LAYOUT_TO_DB = {
  narrow: 'NARROW',
  wide: 'WIDE',
  full: 'FULL',
} as const;

/**
 * Narrows the free-text colour column to the palette.
 *
 * The column is deliberately not an enum (adding a colour should not cost a
 * migration), so a value from an older palette can survive in a row. Reading it
 * back as "no colour" renders the icon exactly the way every icon rendered
 * before the field existed, which is the harmless outcome.
 */
export function toIconColor(value: string | null): DocumentIconColor | null {
  if (value === null) return null;
  return (DOCUMENT_ICON_COLORS as readonly string[]).includes(value)
    ? (value as DocumentIconColor)
    : null;
}

export function toSummary(row: DocumentRow): DocumentSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    parentId: row.parentId,
    type: row.type,
    title: row.title,
    icon: row.icon,
    iconColor: toIconColor(row.iconColor),
    layout: LAYOUT_TO_CONTRACT[row.layout],
    coverAttachmentId: row.coverAttachmentId,
    coverPosition: row.coverPosition,
    orderKey: row.orderKey,
    createdById: row.createdById,
    updatedById: row.updatedById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
  };
}

export function toLinkMatch(
  row: ResolveLinkRow,
  path: { id: string; title: string }[],
): DocumentLinkMatch {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    type: row.type,
    title: row.title,
    icon: row.icon,
    iconColor: toIconColor(row.iconColor),
    archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
    path,
  };
}
/** Collects all descendants of a document from a flat list. */
export function collectSubtree(
  rows: readonly { id: string; parentId: string | null }[],
  documentId: string,
): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const row of rows) {
    if (row.parentId === null) continue;
    const list = childrenByParent.get(row.parentId);
    if (list === undefined) childrenByParent.set(row.parentId, [row.id]);
    else list.push(row.id);
  }
  const result: string[] = [];
  const stack = [...(childrenByParent.get(documentId) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    result.push(current);
    stack.push(...(childrenByParent.get(current) ?? []));
  }
  return result;
}
