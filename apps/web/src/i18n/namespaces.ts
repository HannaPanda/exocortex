import { type Namespace, NAMESPACES } from '@exocortex/i18n/catalog';

/**
 * Namespaces that are rendered on the server for somebody else -- a mail, a
 * push notification, a run diagnosis -- and never shown by the browser. They
 * stay out of the client payload, which is serialised into every page.
 */
const SERVER_ONLY: readonly string[] = ['mail', 'push', 'diagnostics'];

export const WEB_NAMESPACES: readonly Namespace[] = NAMESPACES.filter(
  (namespace) => !SERVER_ONLY.includes(namespace),
);
