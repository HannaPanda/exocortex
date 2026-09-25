import { resolveSettings, type Settings } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

/**
 * Settings for the worker: DB rows override env, env stays the bootstrap
 * fallback (D4), and a workspace's own rows override both (ADR-023).
 *
 * The same `resolveSettings()` the API's `SettingsService` uses, cached for the
 * same 15 seconds so the tool loop does not re-query per turn. Its own module
 * (issue #97) because it is a self-contained piece of state with one entry
 * point, and nothing else in the runtime needs to see its caches.
 */
export function createSettingsReader(
  prisma: PrismaClient,
  logger: Logger,
): (workspaceId?: string) => Promise<Settings> {
  const SETTINGS_CACHE_TTL_MS = 15_000;
  let settingsCache: {
    rows: { key: string; value: unknown }[];
    settings: Settings;
    expiresAt: number;
  } | null = null;
  const workspaceSettingsCache = new Map<string, { settings: Settings; expiresAt: number }>();

  const readDeploymentRows = async (): Promise<{
    rows: { key: string; value: unknown }[];
    settings: Settings;
  }> => {
    const now = Date.now();
    if (settingsCache !== null && settingsCache.expiresAt > now) return settingsCache;
    const rows = await prisma.setting.findMany({ select: { key: true, value: true } });
    const { settings, invalidKeys } = resolveSettings({ rows, env: process.env });
    if (invalidKeys.length > 0) {
      logger.warn('Dropped invalid setting rows while resolving settings', { invalidKeys });
    }
    settingsCache = { rows, settings, expiresAt: now + SETTINGS_CACHE_TTL_MS };
    return settingsCache;
  };

  return async (workspaceId?: string): Promise<Settings> => {
    const base = await readDeploymentRows();
    if (workspaceId === undefined) return base.settings;

    const now = Date.now();
    const cached = workspaceSettingsCache.get(workspaceId);
    if (cached !== undefined && cached.expiresAt > now) return cached.settings;

    const workspaceRows = await prisma.workspaceSetting.findMany({
      where: { workspaceId },
      select: { key: true, value: true },
    });
    const { settings, invalidKeys } = resolveSettings({
      rows: base.rows,
      env: process.env,
      workspaceRows,
    });
    if (invalidKeys.length > 0) {
      logger.warn('Dropped invalid setting rows while resolving workspace settings', {
        workspaceId,
        invalidKeys,
      });
    }
    workspaceSettingsCache.set(workspaceId, { settings, expiresAt: now + SETTINGS_CACHE_TTL_MS });
    return settings;
  };
}
