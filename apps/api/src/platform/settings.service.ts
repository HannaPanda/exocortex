import { Inject, Injectable } from '@nestjs/common';

import {
  resolveSettings,
  type SettingKey,
  type Settings,
  settingsSchema,
} from '@exocortex/contracts';
import { type Prisma, type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { OutboxService } from '../common/outbox.service';

import { PRISMA } from './platform-tokens';

export const SETTINGS = Symbol('EXOCORTEX_SETTINGS');

const CACHE_TTL_MS = 15_000;

export interface UpdateSettingsInput {
  patch: Partial<Settings>;
  actorId: string;
  /**
   * Present only when this update happens inside a workspace context. Settings
   * are deployment-global and `AuditLog.workspaceId` is non-nullable (and must
   * stay that way -- widening it would be a non-additive migration), so there
   * is no workspace to attach an audit row to when this is absent: the change
   * is logged through the structured logger instead.
   */
  workspaceId?: string;
}

/**
 * DB-backed runtime settings, resolved as defaults < environment < database
 * rows (D4). Cached briefly so a hot request path never pays for a
 * `setting.findMany()` round trip on every call.
 */
@Injectable()
export class SettingsService {
  private cache: { settings: Settings; invalidKeys: SettingKey[]; expiresAt: number } | null = null;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly outbox: OutboxService,
  ) {}

  async get(): Promise<Settings> {
    return (await this.resolve()).settings;
  }

  /**
   * Stored rows that failed validation and were replaced by their default.
   *
   * Served to the admin area so a bad row is visible where settings are edited
   * instead of only in the journal (issue #27). Reads the same cache as `get`,
   * so asking for both costs one round trip.
   */
  async invalidKeys(): Promise<SettingKey[]> {
    return (await this.resolve()).invalidKeys;
  }

  private async resolve(): Promise<{ settings: Settings; invalidKeys: SettingKey[] }> {
    const now = Date.now();
    if (this.cache !== null && this.cache.expiresAt > now) {
      return this.cache;
    }

    const rows = await this.prisma.setting.findMany({ select: { key: true, value: true } });
    const { settings, invalidKeys } = resolveSettings({ rows, env: process.env });
    if (invalidKeys.length > 0) {
      this.logger.warn('Dropped invalid setting rows while resolving settings', { invalidKeys });
    }

    this.cache = { settings, invalidKeys, expiresAt: now + CACHE_TTL_MS };
    return this.cache;
  }

  async getKey<K extends SettingKey>(key: K): Promise<Settings[K]> {
    const settings = await this.get();
    return settings[key];
  }

  async update(input: UpdateSettingsInput): Promise<Settings> {
    const changedKeys = Object.keys(input.patch) as SettingKey[];
    for (const key of changedKeys) {
      // `key` is statically a `SettingKey` already, but the underlying data may
      // originate from an untyped caller (e.g. a hand-built request object), so
      // the unknown-key guard still runs at runtime.
      if (!Object.hasOwn(settingsSchema.shape, key)) {
        throw new AppError('setting_unknown', `Unknown setting key "${key}"`);
      }
      const result = settingsSchema.shape[key].safeParse(input.patch[key]);
      if (!result.success) {
        throw AppError.validation(`Invalid value for setting "${key}"`, result.error.issues);
      }
    }

    await this.prisma.$transaction(async (tx) => {
      for (const key of changedKeys) {
        await tx.setting.upsert({
          where: { key },
          create: { key, value: input.patch[key] as Prisma.InputJsonValue, updatedById: input.actorId },
          update: { value: input.patch[key] as Prisma.InputJsonValue, updatedById: input.actorId },
        });
      }

      if (input.workspaceId !== undefined) {
        await this.outbox.writeAudit(tx, {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          action: 'setting.updated',
          targetType: 'setting',
          targetId: 'settings',
          correlationId: 'setting-update',
          metadata: { keys: changedKeys.join(',') },
        });
      }
    });

    if (input.workspaceId === undefined) {
      this.logger.info('Settings updated outside a workspace context', {
        actorId: input.actorId,
        keys: changedKeys,
      });
    }

    this.invalidate();
    return this.get();
  }

  invalidate(): void {
    this.cache = null;
  }
}
