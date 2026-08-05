/**
 * Single source of truth for allowed internal dependencies between workspace
 * packages. Used by `scripts/check-dependency-boundaries.ts` (package.json level)
 * and by the ESLint `no-restricted-imports` overrides (source level).
 *
 * Layering (low -> high):
 *   config, logger, contracts, editor, ui   (leaf packages)
 *   database, storage, queue, ai            (infrastructure)
 *   auth                                    (depends on database)
 *   apps                                    (composition roots)
 */
export const INTERNAL_SCOPE = '@exocortex/';

/** @type {Record<string, readonly string[]>} */
export const ALLOWED_INTERNAL_DEPENDENCIES = {
  '@exocortex/config': [],
  '@exocortex/logger': [],
  '@exocortex/contracts': [],
  '@exocortex/editor': [],
  '@exocortex/ui': [],
  '@exocortex/database': [
    '@exocortex/config',
    '@exocortex/logger',
    '@exocortex/contracts',
    // Dev-only: the seed script builds real Yjs state from Markdown fixtures.
    '@exocortex/editor',
  ],
  '@exocortex/storage': ['@exocortex/config', '@exocortex/logger'],
  '@exocortex/queue': ['@exocortex/config', '@exocortex/logger', '@exocortex/contracts'],
  '@exocortex/ai': ['@exocortex/config', '@exocortex/logger', '@exocortex/contracts'],
  '@exocortex/auth': [
    '@exocortex/config',
    '@exocortex/logger',
    '@exocortex/contracts',
    '@exocortex/database',
  ],

  '@exocortex/api': [
    '@exocortex/config',
    '@exocortex/logger',
    '@exocortex/contracts',
    '@exocortex/database',
    '@exocortex/auth',
    '@exocortex/queue',
    '@exocortex/storage',
    '@exocortex/ai',
    '@exocortex/editor',
  ],
  '@exocortex/collaboration': [
    '@exocortex/config',
    '@exocortex/logger',
    '@exocortex/contracts',
    '@exocortex/database',
    '@exocortex/auth',
    '@exocortex/queue',
    '@exocortex/editor',
  ],
  '@exocortex/worker': [
    '@exocortex/config',
    '@exocortex/logger',
    '@exocortex/contracts',
    '@exocortex/database',
    '@exocortex/queue',
    '@exocortex/storage',
    '@exocortex/ai',
    '@exocortex/editor',
  ],
  // The web frontend must never reach infrastructure packages directly.
  // The web bundle must never reach server-side packages. Authentication is
  // consumed through the `better-auth/react` client, not through
  // `@exocortex/auth` (which pulls in Prisma).
  '@exocortex/web': ['@exocortex/ui', '@exocortex/editor', '@exocortex/contracts'],
  '@exocortex/e2e': [],
};

/** Packages the browser bundle must never import. */
export const FORBIDDEN_IN_BROWSER = [
  '@exocortex/database',
  '@exocortex/queue',
  '@exocortex/storage',
  '@exocortex/ai',
  '@exocortex/logger',
];
