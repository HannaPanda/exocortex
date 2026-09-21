import { resolveSettings, type Settings } from '@exocortex/contracts';

import { type SettingsService } from './settings.service';

/**
 * A `SettingsService` that answers with the deployment defaults.
 *
 * Every service that reads a setting needs one in a test, and the tempting
 * shortcut -- an object literal returning whatever the test happens to care
 * about -- has already cost this repository real data: a flat stub that
 * answered every key with `undefined` resolved the memory workspace to the
 * wrong one and archived genuine notes. So the defaults come from
 * `resolveSettings`, the same function the real service resolves through, and a
 * test that wants a different value overrides that one key by name.
 */
export function settingsStub(overrides: Partial<Settings> = {}): SettingsService {
  const resolved = { ...resolveSettings({ rows: [], env: {} }).settings, ...overrides };
  return {
    get: async (): Promise<Settings> => resolved,
    getForWorkspace: async (): Promise<Settings> => resolved,
  } as unknown as SettingsService;
}
