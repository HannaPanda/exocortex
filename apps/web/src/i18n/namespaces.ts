import { type Namespace, NAMESPACES } from '@exocortex/i18n/catalog';

/**
 * Namespaces that are rendered on the server for somebody else -- a mail, a
 * push notification, a run diagnosis -- and never shown by the browser. They
 * stay out of the client payload, which is serialised into every page.
 *
 * `features` is rendered by the API too: the help page receives its entries
 * already in the reader's language from `GET /api/features`, and a hundred and
 * fifty kilobytes of prose has no business in every page's payload.
 */
const SERVER_ONLY: readonly string[] = ['mail', 'push', 'diagnostics', 'features'];

export const WEB_NAMESPACES: readonly Namespace[] = NAMESPACES.filter(
  (namespace) => !SERVER_ONLY.includes(namespace),
);
