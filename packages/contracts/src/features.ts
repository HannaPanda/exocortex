import { z } from 'zod';

import { isoDateTimeSchema } from './primitives';

/**
 * The feature registry: what a person can do with this deployment, in the
 * words a person would use (issue #80, ADR-040).
 *
 * The neighbouring inventories answer a developer's question. The capability
 * matrix says which client reaches `POST /api/workspaces/:x/clip`; the tool
 * catalogue says `exo_clip` exists and what its arguments are. Neither says
 * "you can send an article from your phone's share sheet into the inbox, and
 * it will fetch the full text if you ask it to". That sentence is what somebody
 * needs in order to discover a feature they paid for and forgot, and no
 * generator can write it.
 *
 * So the registry is written by hand and held honest by a gate: every tool in
 * the catalogue, every screen in the browser and every automation trigger has
 * to be claimed by exactly one entry here, or `scripts/check-feature-coverage.mjs`
 * goes red. The prose is a human's job; not forgetting to write it is the
 * build's.
 *
 * The data lives in `@exocortex/features`. Only the wire shape is here, so the
 * browser can read it without importing the catalogue.
 */

/** The groups the help page shows, in the order it shows them. */
export const FEATURE_AREAS = [
  'hilfe',
  'seiten',
  'struktur',
  'suche',
  'datenbanken',
  'erfassen',
  'zusammenarbeit',
  'dateien',
  'ki',
  'automationen',
  'gedaechtnis',
  'veroeffentlichen',
  'agenten',
  'verwaltung',
] as const;

export const featureAreaSchema = z.enum(FEATURE_AREAS);
export type FeatureArea = z.infer<typeof featureAreaSchema>;

/** Area headings, German, because they are read by a person. */
export const FEATURE_AREA_LABELS: Record<FeatureArea, string> = {
  hilfe: 'Überblick',
  seiten: 'Seiten und Editor',
  struktur: 'Struktur, Ablage und Vorlagen',
  suche: 'Suche und Verknüpfungen',
  datenbanken: 'Datenbanken',
  erfassen: 'Schnell erfassen',
  zusammenarbeit: 'Zusammenarbeit und Verlauf',
  dateien: 'Dateien und Texterkennung',
  ki: 'Eingebaute KI',
  automationen: 'Automationen',
  gedaechtnis: 'Gedächtnis und Entitäten',
  veroeffentlichen: 'Veröffentlichen und Projekte',
  agenten: 'Zugang für Agenten',
  verwaltung: 'Verwaltung',
};

/**
 * Where a person finds the feature.
 *
 * Every field is optional because plenty of capabilities have only one door: a
 * few exist for agents and have no screen at all, and the share target has a
 * screen nobody navigates to. An entry with no door at all is refused by the
 * catalogue's own test, since a feature nobody can reach is not a feature.
 */
export const featureAccessSchema = z.object({
  /** Where in the browser, as a sentence. `path` is a link when there is one. */
  ui: z.object({ where: z.string().min(1), path: z.string().nullable() }).nullable(),
  /** Keyboard shortcuts, written the way the interface writes them. */
  shortcuts: z.array(z.string().min(1)),
  /** Setting keys that switch the feature on or shape it. */
  settings: z.array(z.string().min(1)),
  /** Tool names an agent calls. Also what the coverage gate counts. */
  tools: z.array(z.string().min(1)),
});
export type FeatureAccess = z.infer<typeof featureAccessSchema>;

export const featureSchema = z.object({
  /** Stable slug. It is the anchor on the help page, so renaming one breaks a link. */
  id: z.string().regex(/^[a-z0-9-]+$/),
  area: featureAreaSchema,
  /** What a person would call it. */
  title: z.string().min(1),
  /** One or two sentences: what it does, and why somebody would want it. */
  summary: z.string().min(1),
  access: featureAccessSchema,
  /**
   * The day the feature became usable in this deployment, `YYYY-MM-DD`.
   *
   * This is what "new for you" is measured against, so it is the day it went
   * live rather than the day the branch was cut.
   */
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Issues and ADRs, for the reader who wants to know why it works this way. */
  references: z.array(z.string().min(1)),
  /**
   * True when `since` is later than the marker the reader carries. Computed per
   * request by the API, so it is false for anyone who has no marker yet -- a
   * new account should meet a manual, not a changelog of things it never missed.
   */
  isNew: z.boolean(),
});
export type Feature = z.infer<typeof featureSchema>;

export const featureListResponseSchema = z.object({
  features: z.array(featureSchema),
  /** The day this reader last marked the list as read, or null if never. */
  seenUpTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  /** How many carry `isNew`. The badge in the navigation shows this. */
  newCount: z.number().int().nonnegative(),
});
export type FeatureListResponse = z.infer<typeof featureListResponseSchema>;

export const markFeaturesSeenResponseSchema = z.object({
  seenUpTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  markedAt: isoDateTimeSchema,
});
export type MarkFeaturesSeenResponse = z.infer<typeof markFeaturesSeenResponseSchema>;
