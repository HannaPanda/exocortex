/**
 * DI token symbols for `PlatformModule`'s infrastructure providers.
 *
 * Kept in their own file, separate from `platform.module.ts`, so a provider
 * that needs one of these tokens (e.g. `SettingsService`) can import it
 * without creating a circular module dependency with the module file that
 * registers that same provider.
 */
export const PRISMA = Symbol('EXOCORTEX_PRISMA');
export const QUEUES = Symbol('EXOCORTEX_QUEUES');
export const OBJECT_STORAGE = Symbol('EXOCORTEX_OBJECT_STORAGE');
export const AI_PROVIDER = Symbol('EXOCORTEX_AI_PROVIDER');
export const AI_DEFAULT_MODEL = Symbol('EXOCORTEX_AI_DEFAULT_MODEL');
