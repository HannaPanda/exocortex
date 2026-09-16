import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * The frontend's unit suite (issue #59).
 *
 * `apps/web` is otherwise covered by Playwright, which is the right tool for a
 * user flow and the wrong one for a pure function: a drop that lands in the
 * wrong place is one browser run per case, and the failure says "the row is not
 * where it should be" rather than which branch decided that.
 *
 * So this suite is deliberately narrow. It holds state and transformation logic
 * that fails identically with and without a browser -- the tree's bookkeeping,
 * the optimistic move, the column layout, the icon ranking, the diagnostic ring
 * buffer -- and nothing that needs a DOM to be interesting. Editor integration,
 * drag and drop, collaboration and whole page flows stay in `e2e/`.
 *
 * `environment: 'node'` follows from that: a test that would need `jsdom` is a
 * test that belongs in the Playwright suite. The one module that talks to
 * `window` (`connection-log`) is handed a stub, which is also the only way to
 * observe what it writes.
 */
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
  // Next compiles JSX itself, so `tsconfig.json` leaves `jsx` on `preserve`,
  // which esbuild cannot parse. A test only ever reaches a `.tsx` file through
  // an import (the icon search reads the curated labels out of one), so the
  // transform is stated here rather than in the app's own configuration.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
