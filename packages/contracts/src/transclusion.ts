import { z } from 'zod';

import { DOCUMENT_ICON_COLORS, idSchema, isoDateTimeSchema } from './primitives';

/**
 * What a transclusion shows (issue #78, ADR-045).
 *
 * A `transclusion` block in a page's canonical state carries a reference and no
 * content at all, so the content has to be fetched when somebody reads. That is
 * this one route, `GET /api/documents/:documentId/fragment`: it answers with the
 * part of the source the reference addresses, as the caller, which is what makes
 * the source's permissions apply at the place of the embedding.
 *
 * It is deliberately not a variant of the Markdown export. An export is a whole
 * page for a human to keep; this is a piece of one, cut at a block boundary, and
 * it answers "that block is gone" rather than failing.
 */

/** Block identifiers are the 8-32 lowercase characters `createBlockId` makes. */
export const blockIdSchema = z
  .string()
  .regex(/^[a-z0-9]{8,32}$/, 'Not a block identifier')
  .describe('Kennung eines adressierbaren Blocks, wie exo_page_read sie ausgibt');

/**
 * How much text one answer may carry, and how many entries a map may list
 * (issue #118).
 *
 * Shared by the fragment route and the Markdown export, because both answer an
 * agent that has a context window and neither may hand back a page whose size
 * nobody bounded. Omitting `maxChars` keeps the old behaviour, which is what
 * the browser does: rendering a placed transclusion wants the content, not a
 * map of it.
 */
export const responseBudgetSchema = z.object({
  maxChars: z.coerce.number().int().min(200).max(1_000_000).optional(),
  maxEntries: z.coerce.number().int().min(4).max(200).optional(),
  /**
   * `auto` lets the budget decide, which is what a reader wants: small enough,
   * and you get the thing itself. `map` asks for the structure whatever the
   * size, which is what a caller navigating on purpose wants.
   */
  want: z.enum(['auto', 'map']).optional(),
});

/** One addressable part of a page, as a map lists it. Mirrors `DocumentMapEntry`. */
export const documentMapEntrySchema = z.object({
  kind: z.enum(['section', 'range']),
  fromBlockId: blockIdSchema.nullable(),
  toBlockId: blockIdSchema.nullable(),
  level: z.number().int().min(1).max(6).nullable(),
  title: z.string(),
  chars: z.number().int().nonnegative(),
  blocks: z.number().int().nonnegative(),
});
export type DocumentMapEntryDto = z.infer<typeof documentMapEntrySchema>;

/**
 * The structure of a page, or of one part of it, instead of its text.
 *
 * What a read answers with when the text would not fit the budget. A map is
 * bounded by construction: it costs the same whether the page holds twenty
 * thousand characters or three million, which is what makes reading a page
 * cost what the answer needs rather than what the page weighs.
 */
export const documentMapSchema = z.object({
  mode: z.enum(['sections', 'ranges']),
  totalChars: z.number().int().nonnegative(),
  totalBlocks: z.number().int().nonnegative(),
  entries: z.array(documentMapEntrySchema),
  coarsened: z.boolean(),
});
export type DocumentMapDto = z.infer<typeof documentMapSchema>;

export const documentFragmentRequestSchema = responseBudgetSchema.extend({
  /**
   * The block to show. Omitted means the whole page.
   *
   * A heading addresses its section, not just its own line: the heading plus
   * everything under it up to the next heading of the same or a higher level.
   */
  blockId: blockIdSchema.optional(),
  /**
   * The last block of a range, inclusive. Only with `blockId`, and only for
   * siblings of it. This is how a map's range entry is read back, and it is
   * the same description the write side takes (`blockRangeEditSchema`).
   */
  toBlockId: blockIdSchema.optional(),
  /**
   * Also list the page's addressable blocks, which is what the block picker
   * needs. Off by default, because rendering a placed transclusion does not
   * need the outline and a long page's outline is not small.
   */
  outline: z.coerce.boolean().optional().default(false),
});
export type DocumentFragmentRequest = z.infer<typeof documentFragmentRequestSchema>;

export const documentOutlineBlockSchema = z.object({
  blockId: blockIdSchema,
  /** ProseMirror node type name, so a picker can show what kind of block it is. */
  type: z.string(),
  /** Heading level for a heading, `null` otherwise. */
  level: z.number().int().min(1).max(6).nullable(),
  preview: z.string(),
});
export type DocumentOutlineBlock = z.infer<typeof documentOutlineBlockSchema>;

export const documentFragmentResponseSchema = z.object({
  documentId: idSchema,
  /** The source's title *now*, which is what a renamed page is called here. */
  title: z.string(),
  icon: z.string().nullable(),
  iconColor: z.enum(DOCUMENT_ICON_COLORS).nullable(),
  archivedAt: isoDateTimeSchema.nullable(),
  /**
   * The revision this fragment was read at (issue #120).
   *
   * The page's `yjsUpdatedAt`, not the fragment's: a block carries no revision
   * of its own, and the write this value is handed to compares against the
   * page. Same field, same meaning and same source as on the Markdown export,
   * so a caller that read either can write without guessing.
   */
  yjsUpdatedAt: isoDateTimeSchema,
  /** The block that was asked for, `null` for the whole page. */
  blockId: blockIdSchema.nullable(),
  /** The end of the range that was asked for, `null` when none was. */
  toBlockId: blockIdSchema.nullable(),
  /**
   * `false` when a block was asked for and no block on the page carries that
   * identifier any more. The reference is dead: the source still exists, the
   * part it pointed at does not. Said out loud rather than answered with the
   * nearest surviving block, because a transclusion that silently starts
   * showing a different paragraph is worse than one that says it is broken.
   */
  resolved: z.boolean(),
  /**
   * What this answer carries (issue #118).
   *
   * `content` is the fragment itself and is what a caller without a budget
   * always gets. `map` means the fragment is larger than the budget the caller
   * named: `markdown` and `proseMirrorJson` are then empty and `map` holds the
   * parts to read instead. Never a prefix of the text, because a prefix is
   * what makes a reader believe it has the beginning of something.
   */
  view: z.enum(['content', 'map']),
  /** Characters of Markdown the addressed fragment holds, shown or not. */
  chars: z.number().int().nonnegative(),
  /** The parts of the fragment, on `view: 'map'`. `null` otherwise. */
  map: documentMapSchema.nullable(),
  /** The fragment as Markdown, for agents and for the materialized export. */
  markdown: z.string(),
  /** The same fragment as ProseMirror JSON, which is what the browser renders. */
  proseMirrorJson: z.custom<{ type: 'doc' }>(
    (value) =>
      typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'doc',
    { message: 'Expected a ProseMirror doc node' },
  ),
  /** Empty unless `outline` was asked for. */
  blocks: z.array(documentOutlineBlockSchema),
  /**
   * Transclusions inside the fragment, which are shown as references and not
   * resolved any further. One level is what makes a cycle impossible rather
   * than detectable (ADR-045); the count exists so a reader is told that there
   * is more behind what they see.
   */
  nested: z.number().int().nonnegative(),
});
export type DocumentFragmentResponse = z.infer<typeof documentFragmentResponseSchema>;

/**
 * How an export treats the transclusions on a page.
 *
 * `reference` keeps `:::transclusion Titel^block`, which is the honest shape
 * for a file that comes back here. `text` puts the source's text in its place,
 * which is what a file has to carry when it leaves for somewhere that cannot
 * resolve a reference at all.
 */
export const transclusionExportModeSchema = z.enum(['reference', 'text']);
export type TransclusionExportMode = z.infer<typeof transclusionExportModeSchema>;

export const markdownExportRequestSchema = responseBudgetSchema.extend({
  transclusions: transclusionExportModeSchema.optional().default('reference'),
  /**
   * Writes each block's identifier after it as an Obsidian-style `^id`
   * (issue #111).
   *
   * Off by default, because an exported file is meant to be read and the
   * identifiers are noise in it. On, it is what makes a narrow write possible
   * from a single read: the caller sees the page and the address of every line
   * of it at once, instead of reading the page and then asking a second tool
   * which blocks it contains.
   */
  blockIds: z.coerce.boolean().optional().default(false),
});
export type MarkdownExportRequest = z.infer<typeof markdownExportRequestSchema>;
