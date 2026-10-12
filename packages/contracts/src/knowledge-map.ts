import { z } from 'zod';

import {
  DOCUMENT_ICON_COLORS,
  documentTypeSchema,
  idSchema,
  isoDateTimeSchema,
} from './primitives';

/**
 * The knowledge map: every page of a workspace as a point, and every kind of
 * connection between two pages as a line (issue #189).
 *
 * It is a read model and stores nothing. The references come from the index
 * the materialization job keeps, the similarities from the vectors the search
 * already holds, the entities from the entity layer and the hierarchy from the
 * tree; the map only puts them side by side. A node carries enough to draw and
 * to label a point, never the page's text.
 */

/**
 * What a point stands for. Every point is a document; an `entity` is a row of
 * the entity database (a person, a place, a project the pages mention), which
 * the map draws differently because it is a subject rather than a note.
 */
export const knowledgeMapNodeKindSchema = z.enum(['page', 'entity']);
export type KnowledgeMapNodeKind = z.infer<typeof knowledgeMapNodeKindSchema>;

/**
 * What a line says.
 *
 * - `link`: one page references the other (`[[…]]`, a mention, a page link).
 * - `similar`: the two pages are close in meaning without either naming the
 *   other. Derived from the search vectors, so absent where search has none.
 * - `entity`: a page is linked to an entity of the entity layer.
 * - `tree`: a page hangs under the other one.
 *
 * A transclusion is not a kind of its own: it lives only in the page content
 * and no index holds it, so drawing it would mean parsing every page per read.
 */
export const knowledgeMapEdgeKindSchema = z.enum(['link', 'similar', 'entity', 'tree']);
export type KnowledgeMapEdgeKind = z.infer<typeof knowledgeMapEdgeKindSchema>;

export const knowledgeMapNodeSchema = z.object({
  id: idSchema,
  kind: knowledgeMapNodeKindSchema,
  title: z.string(),
  type: documentTypeSchema,
  icon: z.string().nullable(),
  iconColor: z.enum(DOCUMENT_ICON_COLORS).nullable(),
  /** The page this one hangs under; `null` at top level. */
  parentId: idSchema.nullable(),
  /**
   * The top-level page of the branch the point belongs to. It is what colours
   * a region of the map, so a branch reads as one cloud. Its own id at top level.
   */
  rootId: idSchema,
  /** Number of lines of every kind ending here; the map sizes a point by it. */
  degree: z.number().int().nonnegative(),
  createdAt: isoDateTimeSchema,
  /** The later of the row's own change and the last write to the body. */
  editedAt: isoDateTimeSchema,
});
export type KnowledgeMapNode = z.infer<typeof knowledgeMapNodeSchema>;

export const knowledgeMapEdgeSchema = z.object({
  source: idSchema,
  target: idSchema,
  kind: knowledgeMapEdgeKindSchema,
  /**
   * How strong the connection is, between 0 and 1. A similarity carries its
   * cosine, a reference counts how often it is made (capped), the rest are 1.
   */
  weight: z.number().min(0).max(1),
});
export type KnowledgeMapEdge = z.infer<typeof knowledgeMapEdgeSchema>;

/**
 * Whether the similarity lines are in the answer: `ok` they are, `disabled`
 * this deployment has no semantic search, `partial` some pages have no vector
 * yet and appear without similarity lines.
 */
export const knowledgeMapSemanticStateSchema = z.enum(['ok', 'partial', 'disabled']);
export type KnowledgeMapSemanticState = z.infer<typeof knowledgeMapSemanticStateSchema>;

export const knowledgeMapQuerySchema = z.object({
  /** Leave lines of these kinds out. Comma separated, e.g. `tree,similar`. */
  exclude: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined || value.trim() === '' ? [] : value.split(',').map((part) => part.trim()),
    )
    .pipe(z.array(knowledgeMapEdgeKindSchema)),
});
export type KnowledgeMapQuery = z.infer<typeof knowledgeMapQuerySchema>;

export const knowledgeMapResponseSchema = z.object({
  workspaceId: idSchema,
  generatedAt: isoDateTimeSchema,
  semantic: knowledgeMapSemanticStateSchema,
  nodes: z.array(knowledgeMapNodeSchema),
  edges: z.array(knowledgeMapEdgeSchema),
});
export type KnowledgeMapResponse = z.infer<typeof knowledgeMapResponseSchema>;

/**
 * How the map looks to one person (issue #189): every point is a star, a
 * bright core with a soft halo that faces the camera, and the glow, the
 * colours and the halo are tunable from the map itself.
 *
 * Taste, not configuration: it is kept on the account and follows the person
 * to every workspace and device. The colours stay the design tokens; what is
 * stored is only how they are turned into light, so a token that changes
 * still changes the map.
 */

/** The branch colours, named after the content token each one comes from, plus the entity points. */
export const KNOWLEDGE_MAP_POINT_COLOURS = [
  'blue',
  'green',
  'purple',
  'orange',
  'pink',
  'yellow',
  'red',
  'brown',
  'gray',
  'entity',
] as const;
export type KnowledgeMapPointColour = (typeof KNOWLEDGE_MAP_POINT_COLOURS)[number];

/** The colours of what happens: a run reads, writes, a page appears or goes. */
export const KNOWLEDGE_MAP_PULSE_COLOURS = ['read', 'write', 'created', 'removed'] as const;
export type KnowledgeMapPulseColour = (typeof KNOWLEDGE_MAP_PULSE_COLOURS)[number];

const glowSchema = z.number().min(0).max(3);

/**
 * A point colour: `glow` multiplies the colour past white, which is what feeds
 * the bloom; `lightness` is the lightness the token's hue is set to (sRGB HSL).
 */
export const knowledgeMapPointColourSchema = z.object({
  glow: glowSchema,
  lightness: z.number().min(0.25).max(0.85),
});

/** A pulse colour is the status token as it is; only its glow is tunable. */
export const knowledgeMapPulseColourSchema = z.object({ glow: glowSchema });

export const knowledgeMapAppearanceSchema = z.object({
  bloom: z.object({
    strength: z.number().min(0).max(2.5),
    radius: z.number().min(0).max(1.5),
    /** Brightness above which a pixel glows. */
    threshold: z.number().min(0).max(1),
  }),
  /** How much more saturated a point is than the pastel token it comes from. */
  saturation: z.number().min(0.5).max(3),
  /**
   * Convert the finished picture to sRGB. Off draws the linear values as they
   * are, which is darker and makes blue and purple glow less than green.
   */
  colourCorrection: z.boolean(),
  star: z.object({
    /** The core's size relative to the point. */
    core: z.number().min(0.2).max(1),
    /** The halo's size relative to the point. */
    halo: z.number().min(1).max(6),
    /** How quickly the halo fades; higher is a tighter glow. */
    softness: z.number().min(0.8).max(5),
  }),
  points: z.object(
    Object.fromEntries(
      KNOWLEDGE_MAP_POINT_COLOURS.map((key) => [key, knowledgeMapPointColourSchema]),
    ) as Record<KnowledgeMapPointColour, typeof knowledgeMapPointColourSchema>,
  ),
  pulses: z.object(
    Object.fromEntries(
      KNOWLEDGE_MAP_PULSE_COLOURS.map((key) => [key, knowledgeMapPulseColourSchema]),
    ) as Record<KnowledgeMapPulseColour, typeof knowledgeMapPulseColourSchema>,
  ),
});
export type KnowledgeMapAppearance = z.infer<typeof knowledgeMapAppearanceSchema>;

const point = (glow: number, lightness = 0.55) => ({ glow, lightness });

/**
 * The look nobody has tuned. Green carries more luminance than blue and purple
 * at the same lightness, so it starts a little quieter and they a little
 * louder; the halo does the glowing, so the bloom stays moderate.
 */
export const DEFAULT_KNOWLEDGE_MAP_APPEARANCE: KnowledgeMapAppearance = {
  bloom: { strength: 0.7, radius: 0.4, threshold: 0.32 },
  saturation: 2.2,
  colourCorrection: false,
  star: { core: 0.55, halo: 3.2, softness: 2.2 },
  points: {
    blue: point(1.2),
    green: point(0.85),
    purple: point(1.25),
    orange: point(1),
    pink: point(1.05),
    yellow: point(0.9),
    red: point(1.1),
    brown: point(1),
    gray: point(1),
    entity: point(1),
  },
  pulses: {
    read: { glow: 1.2 },
    write: { glow: 1 },
    created: { glow: 0.9 },
    removed: { glow: 1.2 },
  },
};

/**
 * A change to the look: any subset, down to a single colour's glow. What is
 * not named stays as it is.
 */
export const knowledgeMapAppearancePatchSchema = z.object({
  bloom: knowledgeMapAppearanceSchema.shape.bloom.partial().optional(),
  saturation: knowledgeMapAppearanceSchema.shape.saturation.optional(),
  colourCorrection: z.boolean().optional(),
  star: knowledgeMapAppearanceSchema.shape.star.partial().optional(),
  points: z
    .object(
      Object.fromEntries(
        KNOWLEDGE_MAP_POINT_COLOURS.map((key) => [
          key,
          knowledgeMapPointColourSchema.partial().optional(),
        ]),
      ) as Record<
        KnowledgeMapPointColour,
        z.ZodOptional<ReturnType<typeof knowledgeMapPointColourSchema.partial>>
      >,
    )
    .optional(),
  pulses: z
    .object(
      Object.fromEntries(
        KNOWLEDGE_MAP_PULSE_COLOURS.map((key) => [
          key,
          knowledgeMapPulseColourSchema.partial().optional(),
        ]),
      ) as Record<
        KnowledgeMapPulseColour,
        z.ZodOptional<ReturnType<typeof knowledgeMapPulseColourSchema.partial>>
      >,
    )
    .optional(),
});
export type KnowledgeMapAppearancePatch = z.infer<typeof knowledgeMapAppearancePatchSchema>;

export const knowledgeMapAppearanceResponseSchema = z.object({
  appearance: knowledgeMapAppearanceSchema,
  /** True while nothing is stored and the defaults apply. */
  isDefault: z.boolean(),
});
export type KnowledgeMapAppearanceResponse = z.infer<typeof knowledgeMapAppearanceResponseSchema>;

function mergeRecord<T extends object>(
  base: Record<string, T>,
  patch: Record<string, Partial<T> | undefined> | undefined,
): Record<string, T> {
  const merged: Record<string, T> = {};
  for (const [key, value] of Object.entries(base)) merged[key] = { ...value, ...patch?.[key] };
  return merged;
}

/**
 * The look after a change, or a stored value read back: the patch over the
 * base, key by key. Used for both, so a stored value from before a key existed
 * reads as that key's default.
 */
export function mergeKnowledgeMapAppearance(
  base: KnowledgeMapAppearance,
  patch: KnowledgeMapAppearancePatch,
): KnowledgeMapAppearance {
  return {
    bloom: { ...base.bloom, ...patch.bloom },
    saturation: patch.saturation ?? base.saturation,
    colourCorrection: patch.colourCorrection ?? base.colourCorrection,
    star: { ...base.star, ...patch.star },
    points: mergeRecord(base.points, patch.points) as KnowledgeMapAppearance['points'],
    pulses: mergeRecord(base.pulses, patch.pulses) as KnowledgeMapAppearance['pulses'],
  };
}

/**
 * A stored value as the look it means: whatever still validates, over the
 * defaults. A value that no longer fits the schema at all falls back to the
 * defaults rather than breaking the map.
 */
export function readKnowledgeMapAppearance(stored: unknown): KnowledgeMapAppearance {
  const parsed = knowledgeMapAppearancePatchSchema.safeParse(stored);
  return parsed.success
    ? mergeKnowledgeMapAppearance(DEFAULT_KNOWLEDGE_MAP_APPEARANCE, parsed.data)
    : DEFAULT_KNOWLEDGE_MAP_APPEARANCE;
}
