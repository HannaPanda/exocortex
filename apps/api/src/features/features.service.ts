import { Inject, Injectable } from '@nestjs/common';

import {
  type Feature,
  FEATURE_AREAS,
  type FeatureAreaInfo,
  type FeatureListResponse,
  type Locale,
  type MarkFeaturesSeenResponse,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { FEATURES, latestFeatureDate, type RegisteredFeature } from '@exocortex/features';
import { serverTranslator } from '@exocortex/i18n/catalog';

import { readerLocale, type ReaderLocaleHeaders } from '../common/reader-locale';
import { PRISMA } from '../platform/platform.module';

type FeatureTranslator = ReturnType<typeof serverTranslator<'features'>>;
type FeatureKey = Parameters<FeatureTranslator>[0];

/**
 * An entry's words in one locale: `<id>.title`, `<id>.summary`,
 * `<id>.details.p1` onwards and `<id>.where` in the `features` namespace.
 *
 * The keys are built from the id, which the catalogue's type cannot follow, so
 * they are cast once here. The coverage gate is what guarantees each one
 * exists in German, and the translator falls back to German for a locale that
 * is behind.
 */
function renderFeature(
  t: FeatureTranslator,
  feature: RegisteredFeature,
): Pick<Feature, 'title' | 'summary' | 'details'> & { where: string | null } {
  const text = (suffix: string) => t(`${feature.id}.${suffix}` as FeatureKey);
  const details: string[] = [];
  for (let index = 1; t.has(`${feature.id}.details.p${index}` as FeatureKey); index += 1) {
    details.push(text(`details.p${index}`));
  }
  return {
    title: text('title'),
    summary: text('summary'),
    details,
    where: feature.access.ui === null ? null : text('where'),
  };
}

/** Every area's heading, from the same messages the help page renders. */
function renderAreas(locale: Locale): FeatureAreaInfo[] {
  const t = serverTranslator(locale, 'help');
  return FEATURE_AREAS.map((id) => ({
    id,
    label: t(`areas.${id}.label`),
    description: t(`areas.${id}.description`),
  }));
}

/** `YYYY-MM-DD`, the way the registry writes a date. */
function asDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * The feature registry, seen through one person's marker (issue #80, ADR-040).
 *
 * The catalogue itself is static data in `@exocortex/features` and never
 * touches the database. The only stored thing is how far down the list each
 * person has read, which is what turns a manual into a changelog.
 *
 * The words are rendered per request in the reader's language (issue #98,
 * ADR-062), which for an agent calling `exo_features` is its account's choice.
 */
@Injectable()
export class FeaturesService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async list(userId: string, headers: ReaderLocaleHeaders): Promise<FeatureListResponse> {
    const [locale, marker] = await Promise.all([
      readerLocale(this.prisma, userId, headers),
      this.prisma.userFeatureSeen.findUnique({ where: { userId } }),
    ]);
    const seenUpTo = marker === null ? null : asDay(marker.seenUpTo);
    const t = serverTranslator(locale, 'features');
    const areaIndex = new Map(FEATURE_AREAS.map((area, index) => [area, index]));
    const collator = new Intl.Collator(locale);
    const features: Feature[] = FEATURES.map((feature) => {
      const { where, ...words } = renderFeature(t, feature);
      return {
        id: feature.id,
        area: feature.area,
        ...words,
        since: feature.since,
        references: [...feature.references],
        access: {
          ui:
            feature.access.ui === null || where === null
              ? null
              : { where, path: feature.access.ui.path },
          shortcuts: [...feature.access.shortcuts],
          settings: [...feature.access.settings],
          tools: [...feature.access.tools],
        },
        // No marker means a new account, and a new account has missed nothing.
        // The row is written the first time they mark the list as read.
        isNew: seenUpTo !== null && feature.since > seenUpTo,
      };
    });
    // The catalogue's order, with ties on one day broken by the title as the
    // reader sees it: an alphabet is a property of the language.
    features.sort((a, b) => {
      const byArea = (areaIndex.get(a.area) ?? 0) - (areaIndex.get(b.area) ?? 0);
      if (byArea !== 0) return byArea;
      if (a.since !== b.since) return a.since < b.since ? 1 : -1;
      return collator.compare(a.title, b.title);
    });
    return {
      features,
      areas: renderAreas(locale),
      seenUpTo,
      newCount: features.filter((feature) => feature.isNew).length,
    };
  }

  /**
   * Moves the marker to the newest entry in the catalogue.
   *
   * The newest `since` rather than today, so a feature that ships tomorrow with
   * a `since` of yesterday (a backfilled entry for something that was already
   * live) still shows up as new. Nothing here dates into the future, and the
   * catalogue's own test keeps it that way.
   */
  async markSeen(userId: string): Promise<MarkFeaturesSeenResponse> {
    const seenUpTo = latestFeatureDate();
    const value = new Date(`${seenUpTo}T00:00:00.000Z`);
    const row = await this.prisma.userFeatureSeen.upsert({
      where: { userId },
      create: { userId, seenUpTo: value },
      update: { seenUpTo: value },
    });
    return { seenUpTo: asDay(row.seenUpTo), markedAt: row.updatedAt.toISOString() };
  }
}
