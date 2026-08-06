import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `scripts/**` is included alongside `src/**` so the standalone operator
  // scripts under `apps/api/scripts/` (e.g. `import-obsidian.ts`) get their
  // pure helpers unit tested by the same `pnpm test` run as the application.
  test: { environment: 'node', include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'] },
});
