import { isTransactionOrigin } from '@hocuspocus/server';

/**
 * The account whose keystrokes the store about to happen carries (issue #235),
 * or `null` when the last change did not come from a person's connection.
 *
 * Only a `connection` origin names a typist. A `local` one is a write the API
 * or this server made itself (`internal-content.ts`, a migration on load), and
 * that write already left its own version with its own author; a `redis` one
 * was typed on another instance, which stores it there. `null` therefore means
 * "leave the recorded typist as it is", never "nobody".
 */
export function typistOf(origin: unknown): string | null {
  if (!isTransactionOrigin(origin) || origin.source !== 'connection') return null;
  const context: unknown = origin.connection.context;
  if (typeof context !== 'object' || context === null || !('userId' in context)) return null;
  const { userId } = context;
  return typeof userId === 'string' && userId !== '' ? userId : null;
}
