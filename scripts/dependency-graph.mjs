/**
 * Single source of truth for allowed internal dependencies between workspace
 * packages. Used by `scripts/check-dependency-boundaries.ts` (package.json level)
 * and by the ESLint `no-restricted-imports` overrides (source level).
 *
 * Layering (low -> high):
 *   config, logger, contracts, editor, ui   (leaf packages)
 *   database, storage, queue, ai, mail      (infrastructure)
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
    // Two uses: the seed script builds real Yjs state from Markdown fixtures,
    // and the entity helpers (issue #47) share one alias matcher with the
    // worker, because a matcher that disagrees with itself between the two
    // would link a page here and not there.
    '@exocortex/editor',
  ],
  '@exocortex/storage': ['@exocortex/config', '@exocortex/logger'],
  '@exocortex/queue': ['@exocortex/config', '@exocortex/logger', '@exocortex/contracts'],
  '@exocortex/ai': ['@exocortex/config', '@exocortex/logger', '@exocortex/contracts'],
  // CalDAV and iCalendar only: HTTP against a remote server, XML and ICS in and
  // out, nothing about Exocortex's own domain. Deliberately *not* allowed to see
  // @exocortex/database or @exocortex/contracts, so the protocol layer cannot
  // start writing rows or reasoning about documents; mapping an external event
  // onto a database row is the worker's job.
  '@exocortex/calendar': ['@exocortex/logger'],
  // The feature registry is prose plus a handful of names, typed against the
  // wire contract so the catalogue and the DTO cannot drift. Nothing else:
  // an entry describes a capability, it does not reach one, and a registry
  // that could read the database would eventually be asked to.
  '@exocortex/features': ['@exocortex/contracts'],
  // SMTP and the wording of the mails, and nothing about the domain (issue
  // #102). It reads the template catalogue out of the contracts and knows how
  // to put words around it; who should receive one, and whether they still
  // may, is decided by the caller. Deliberately not allowed to see
  // @exocortex/database: a package that could look up an address would sooner
  // or later be asked to decide who gets mail.
  '@exocortex/mail': ['@exocortex/contracts', '@exocortex/logger', '@exocortex/i18n'],
  // The interface languages (issue #98, ADR-062): message catalogues, locale
  // negotiation, the translator the server side renders with. It reads the
  // locale list out of the contracts and nothing else, so the browser, the
  // API, the worker and the mail templates can all depend on it without any
  // of them pulling in the others.
  '@exocortex/i18n': ['@exocortex/contracts'],
  '@exocortex/auth': [
    '@exocortex/config',
    '@exocortex/logger',
    '@exocortex/contracts',
    '@exocortex/database',
  ],
  // MCP tool *definitions* are a leaf package that only depends on the shared
  // zod contracts; `execute` talks to the REST API through an injected
  // `ExocortexApiClient`, never by importing @exocortex/database or
  // @exocortex/auth directly (D2). This keeps business logic and
  // authorization in apps/api, so the same tool catalogue safely serves
  // external MCP clients and the built-in AI's tool loop.
  '@exocortex/mcp-tools': ['@exocortex/contracts'],
  '@exocortex/mcp': [
    '@exocortex/config',
    '@exocortex/logger',
    '@exocortex/contracts',
    '@exocortex/mcp-tools',
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
    '@exocortex/mcp-tools',
    '@exocortex/features',
    // The mails a request waits on: verification, password reset, invitation.
    '@exocortex/mail',
    '@exocortex/i18n',
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
    // Only to mint the short-lived service tokens the API accepts (D3).
    '@exocortex/auth',
    '@exocortex/mcp-tools',
    // Talks CalDAV to mailbox.org; the mapping onto database rows lives here,
    // in the worker, not in the protocol package.
    '@exocortex/calendar',
    // The other half of the mail split (issue #102): notification mail is
    // queued and sent here, so a relay that is down delays a mail instead of
    // failing whatever request caused it.
    '@exocortex/mail',
    // Push texts and run diagnostics in the language of whoever reads them.
    '@exocortex/i18n',
  ],
  // The web frontend must never reach infrastructure packages directly.
  // The web bundle must never reach server-side packages. Authentication is
  // consumed through the `better-auth/react` client, not through
  // `@exocortex/auth` (which pulls in Prisma).
  '@exocortex/web': [
    '@exocortex/ui',
    '@exocortex/editor',
    '@exocortex/contracts',
    '@exocortex/i18n',
  ],
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
