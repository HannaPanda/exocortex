import { Inject, Injectable } from '@nestjs/common';

import {
  type Feature,
  type FeatureListResponse,
  type MarkFeaturesSeenResponse,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { FEATURES, latestFeatureDate } from '@exocortex/features';

import { PRISMA } from '../platform/platform.module';

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
 */
@Injectable()
export class FeaturesService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async list(userId: string): Promise<FeatureListResponse> {
    const marker = await this.prisma.userFeatureSeen.findUnique({ where: { userId } });
    const seenUpTo = marker === null ? null : asDay(marker.seenUpTo);
    const features: Feature[] = FEATURES.map((feature) => ({
      ...feature,
      details: [...feature.details],
      references: [...feature.references],
      access: {
        ui: feature.access.ui === null ? null : { ...feature.access.ui },
        shortcuts: [...feature.access.shortcuts],
        settings: [...feature.access.settings],
        tools: [...feature.access.tools],
      },
      // No marker means a new account, and a new account has missed nothing.
      // The row is written the first time they mark the list as read.
      isNew: seenUpTo !== null && feature.since > seenUpTo,
    }));
    return {
      features,
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
