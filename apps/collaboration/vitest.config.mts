import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The guard that refuses to let an integration test open a connection to
    // anything but the throwaway stack. Harmless for the unit tests in this
    // workspace: it looks at the file name and returns.
    setupFiles: ['../../vitest.setup.integration.ts'],
  },
});
