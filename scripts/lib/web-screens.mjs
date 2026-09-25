/**
 * The browser's screens, read out of the app router.
 *
 * Shared by the two gates that hold every screen to something: the feature
 * registry (a screen is described) and the command palette (a screen can be
 * reached by name). Both have to agree on what a screen is, or one of them
 * will quietly count a directory the other does not.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { repoRoot } from './api-surface.mjs';

const WEB_APP_DIR = join(repoRoot, 'apps/web/src/app');

/** Every `page.tsx` under the app router, as the path a person's browser shows. */
export function collectScreens() {
  const screens = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      if (entry !== 'page.tsx') continue;
      const segments = relative(WEB_APP_DIR, abs)
        .replace(/\/?page\.tsx$/, '')
        .split('/')
        .filter((segment) => segment.length > 0)
        // `(app)` and `(auth)` group files without appearing in the address.
        .filter((segment) => !/^\(.*\)$/.test(segment))
        // `[workspaceId]` is `:x`, the spelling the capability matrix uses:
        // which parameter it is belongs to the route, not to the capability.
        .map((segment) => (/^\[.*\]$/.test(segment) ? ':x' : segment));
      screens.set(`/${segments.join('/')}`, relative(repoRoot, abs));
    }
  };
  walk(WEB_APP_DIR);
  return screens;
}
