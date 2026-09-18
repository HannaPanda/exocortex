import { type Feature, type FeatureArea } from '@exocortex/contracts';

/**
 * What an entry accounts for in the inventories `check-feature-coverage.mjs`
 * reads out of the source.
 *
 * Kept apart from `access` because the two answer different questions. `access`
 * is read by a person looking for the door; this is read by the gate asking
 * whether any door was left undescribed. The tool names serve both, so they
 * live in `access` and the gate reads them from there.
 */
export interface FeatureClaims {
  /**
   * Browser screens, as route patterns with the dynamic segments written `:x`,
   * the same spelling the capability matrix uses: `/arbeitsbereich/:x/seite/:x`.
   *
   * A screen may be claimed by several entries. The page view hosts a dozen
   * capabilities and pretending one of them owns it would be a lie told to
   * satisfy a counter.
   */
  readonly screens: readonly string[];
  /** `AutomationTrigger` members this entry describes. */
  readonly automationTriggers: readonly string[];
  /** `AutomationAction` members this entry describes. */
  readonly automationActions: readonly string[];
}

/**
 * A registry entry before the API computes `isNew` for the reader in front of
 * it. Everything usually absent is optional, so an entry reads as the handful
 * of facts it has rather than as four empty arrays.
 */
export interface FeatureEntry {
  id: string;
  area: FeatureArea;
  title: string;
  summary: string;
  since: string;
  references?: readonly string[];
  /** Where in the browser. `path` only when a link can be written for it. */
  ui?: { where: string; path?: string };
  shortcuts?: readonly string[];
  settings?: readonly string[];
  tools?: readonly string[];
  claims?: Partial<FeatureClaims>;
}

/** A catalogue entry: the wire shape plus what it accounts for. */
export type RegisteredFeature = Omit<Feature, 'isNew'> & { readonly claims: FeatureClaims };

const frozen = (values: readonly string[] | undefined): readonly string[] =>
  Object.freeze([...(values ?? [])]);

/**
 * Fills the optional halves in and freezes the result.
 *
 * Frozen because the catalogue is one object shared across every request the
 * API serves: a handler that sorted the tool list in place would sort it for
 * everybody, and the day that happens is not the day anybody debugs it.
 */
export function defineFeature(entry: FeatureEntry): RegisteredFeature {
  const ui =
    entry.ui === undefined
      ? null
      : Object.freeze({ where: entry.ui.where, path: entry.ui.path ?? null });
  return Object.freeze({
    id: entry.id,
    area: entry.area,
    title: entry.title,
    summary: entry.summary,
    since: entry.since,
    references: frozen(entry.references),
    access: Object.freeze({
      ui,
      shortcuts: frozen(entry.shortcuts),
      settings: frozen(entry.settings),
      tools: frozen(entry.tools),
    }),
    claims: Object.freeze({
      screens: frozen(entry.claims?.screens),
      automationTriggers: frozen(entry.claims?.automationTriggers),
      automationActions: frozen(entry.claims?.automationActions),
    }),
  }) as RegisteredFeature;
}
