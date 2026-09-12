import { Inject, Injectable } from '@nestjs/common';

import {
  resolveSettings,
  SETTING_SCOPES,
  type SettingKey,
  type Settings,
  settingsSchema,
  type UpdateWorkspaceSettingsRequest,
  WORKSPACE_SETTING_KEYS,
  type WorkspaceSettingKey,
} from '@exocortex/contracts';
import { type Prisma, type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { OutboxService } from '../common/outbox.service';

import { PRISMA } from './platform-tokens';

export const SETTINGS = Symbol('EXOCORTEX_SETTINGS');

const CACHE_TTL_MS = 15_000;

/** One workspace's view of its own configuration, effective values included. */
export interface ResolvedWorkspaceSettings {
  settings: Settings;
  deploymentSettings: Settings;
  overriddenKeys: WorkspaceSettingKey[];
  invalidKeys: SettingKey[];
}

export interface UpdateWorkspaceSettingsInput {
  workspaceId: string;
  patch: UpdateWorkspaceSettingsRequest;
  actorId: string;
}

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
  private cache: {
    rows: { key: string; value: unknown }[];
    settings: Settings;
    invalidKeys: SettingKey[];
    expiresAt: number;
  } | null = null;

  /**
   * One entry per workspace that has been asked about, same 15 second TTL.
   *
   * A map rather than a single object because the fourth layer depends on who
   * is asking (ADR-023). Unbounded growth is not a risk worth code here: an
   * entry is one resolved settings object, there is one per workspace, and a
   * deployment has as many workspaces as a person can name.
   */
  private readonly workspaceCache = new Map<
    string,
    ResolvedWorkspaceSettings & { expiresAt: number }
  >();

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

  private async resolve(): Promise<{
    rows: { key: string; value: unknown }[];
    settings: Settings;
    invalidKeys: SettingKey[];
  }> {
    const now = Date.now();
    if (this.cache !== null && this.cache.expiresAt > now) {
      return this.cache;
    }

    const rows = await this.prisma.setting.findMany({ select: { key: true, value: true } });
    const { settings, invalidKeys } = resolveSettings({ rows, env: process.env });
    if (invalidKeys.length > 0) {
      this.logger.warn('Dropped invalid setting rows while resolving settings', { invalidKeys });
    }

    this.cache = { rows, settings, invalidKeys, expiresAt: now + CACHE_TTL_MS };
    return this.cache;
  }

  /**
   * The configuration in force inside one workspace (issue #52, ADR-023).
   *
   * Resolved from the cached deployment rows plus this workspace's own, so a
   * workspace read costs one small query rather than two. Every caller that
   * has a workspace in hand should use this: `get()` is the deployment-wide
   * answer and is right only for jobs that genuinely span the installation.
   */
  async forWorkspace(workspaceId: string): Promise<ResolvedWorkspaceSettings> {
    const now = Date.now();
    const cached = this.workspaceCache.get(workspaceId);
    if (cached !== undefined && cached.expiresAt > now) return cached;

    const base = await this.resolve();
    const workspaceRows = await this.prisma.workspaceSetting.findMany({
      where: { workspaceId },
      select: { key: true, value: true },
    });
    const { settings, invalidKeys, overriddenKeys } = resolveSettings({
      rows: base.rows,
      env: process.env,
      workspaceRows,
    });
    if (invalidKeys.length > base.invalidKeys.length) {
      this.logger.warn('Dropped invalid workspace setting rows while resolving', {
        workspaceId,
        invalidKeys,
      });
    }

    const resolved: ResolvedWorkspaceSettings = {
      settings,
      deploymentSettings: base.settings,
      overriddenKeys,
      invalidKeys,
    };
    this.workspaceCache.set(workspaceId, { ...resolved, expiresAt: now + CACHE_TTL_MS });
    return resolved;
  }

  /** Shorthand for the common case: only the effective values are needed. */
  async getForWorkspace(workspaceId: string): Promise<Settings> {
    return (await this.forWorkspace(workspaceId)).settings;
  }

  /**
   * Writes one workspace's overrides and deletes the ones it reset.
   *
   * Both halves in one transaction because they are one intent: a form save
   * that set two keys and cleared a third has to land whole, or the workspace
   * sees a configuration nobody chose. Keys outside the `workspace` scope are
   * refused rather than ignored -- the request schema already strips them, so
   * one arriving here means a caller built the object by hand.
   */
  async updateForWorkspace(
    input: UpdateWorkspaceSettingsInput,
  ): Promise<ResolvedWorkspaceSettings> {
    const { reset = [], ...values } = input.patch;
    const changedKeys = Object.keys(values) as WorkspaceSettingKey[];

    for (const key of changedKeys) {
      if (!Object.hasOwn(settingsSchema.shape, key)) {
        throw new AppError('setting_unknown', `Unknown setting key "${key}"`);
      }
      if (SETTING_SCOPES[key] !== 'workspace') {
        throw new AppError(
          'setting_not_overridable',
          `Setting "${key}" is deployment-wide and cannot be set per workspace`,
        );
      }
      const result = settingsSchema.shape[key].safeParse(values[key]);
      if (!result.success) {
        throw AppError.validation(`Invalid value for setting "${key}"`, result.error.issues);
      }
    }

    // The ceiling is enforced again while resolving, which is what actually
    // holds when an admin lowers it later. Refusing here as well is for the
    // person at the form: a value silently clamped to something else is worse
    // than one that was not accepted.
    const deployment = (await this.resolve()).settings;
    for (const key of changedKeys) {
      const ceiling = deployment[key];
      const value = values[key];
      if (typeof ceiling === 'number' && typeof value === 'number' && value > ceiling) {
        throw new AppError(
          'setting_above_deployment_ceiling',
          `Setting "${key}" may not exceed the deployment value (${ceiling})`,
        );
      }
    }

    await this.prisma.$transaction(async (tx) => {
      for (const key of changedKeys) {
        const value = values[key] as Prisma.InputJsonValue;
        await tx.workspaceSetting.upsert({
          where: { workspaceId_key: { workspaceId: input.workspaceId, key } },
          create: { workspaceId: input.workspaceId, key, value, updatedById: input.actorId },
          update: { value, updatedById: input.actorId },
        });
      }
      if (reset.length > 0) {
        await tx.workspaceSetting.deleteMany({
          where: { workspaceId: input.workspaceId, key: { in: reset } },
        });
      }

      await this.outbox.writeAudit(tx, {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        action: 'workspace.setting.updated',
        targetType: 'setting',
        targetId: 'workspace-settings',
        correlationId: 'workspace-setting-update',
        metadata: { keys: changedKeys.join(','), reset: reset.join(',') },
      });
    });

    this.invalidateWorkspace(input.workspaceId);
    return this.forWorkspace(input.workspaceId);
  }

  /** The keys a workspace may override at all. Sent to the form so it cannot drift. */
  editableKeys(): readonly WorkspaceSettingKey[] {
    return WORKSPACE_SETTING_KEYS;
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
          create: {
            key,
            value: input.patch[key] as Prisma.InputJsonValue,
            updatedById: input.actorId,
          },
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
    // Deployment values are the floor and the ceiling of every workspace
    // answer, so a change up here invalidates all of them, not only its own.
    this.workspaceCache.clear();
  }

  invalidateWorkspace(workspaceId: string): void {
    this.workspaceCache.delete(workspaceId);
  }
}
