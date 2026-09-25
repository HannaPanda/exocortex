import { type FeatureArea } from '@exocortex/contracts';

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
 *
 * The words are not here. The title, the summary, the paragraphs of the long
 * form and the sentence saying where in the browser live in the message
 * catalogue, namespace `features`, under the entry's id
 * (`packages/i18n/src/messages/de/features.json`), so the API can answer in the
 * reader's language (issue #98, ADR-062). This file keeps the facts a
 * translation cannot change: the id, the area, the date, the doors.
 */
export interface FeatureEntry {
  id: string;
  area: FeatureArea;
  since: string;
  references?: readonly string[];
  /**
   * A door in the browser. The sentence saying where is `<id>.where` in the
   * catalogue; `path` only when a link can be written for it, so an entry
   * without one says `ui: {}`.
   */
  ui?: { path?: string };
  shortcuts?: readonly string[];
  settings?: readonly string[];
  tools?: readonly string[];
  claims?: Partial<FeatureClaims>;
}

/**
 * A catalogue entry: the wire shape without the words and without what the API
 * computes per reader, plus what it accounts for.
 */
export interface RegisteredFeature {
  readonly id: string;
  readonly area: FeatureArea;
  readonly since: string;
  readonly references: readonly string[];
  readonly access: {
    readonly ui: { readonly path: string | null } | null;
    readonly shortcuts: readonly string[];
    readonly settings: readonly string[];
    readonly tools: readonly string[];
  };
  readonly claims: FeatureClaims;
}

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
  const ui = entry.ui === undefined ? null : Object.freeze({ path: entry.ui.path ?? null });
  return Object.freeze({
    id: entry.id,
    area: entry.area,
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
  });
}
