import { type Logger } from '@exocortex/logger';

/**
 * Which environment key a calendar account's credentials may be read from.
 *
 * The indirection is the point of `credentialRef`: rotating a password never
 * touches the row. But a dynamic env lookup driven by a database value is also
 * a way to read *any* variable, and whatever it reads is sent to a remote
 * server in an Authorization header -- so a hand-edited row pointing at
 * `DATABASE_URL` would exfiltrate it. The pattern is the boundary that stops
 * that, and it is checked here rather than at write time because this is the
 * only place that dereferences the name.
 */
const CREDENTIAL_REF_PATTERN = /^[A-Z][A-Z0-9_]*_(PASSWORD|TOKEN|SECRET)$/;

export interface CalendarAccountCredentialsRef {
  provider: string;
  username: string;
  credentialRef: string;
  baseUrl: string | null;
}

export interface CalendarCredentials {
  baseUrl: string;
  username: string;
  password: string;
}

/**
 * Resolves an account's credentials from the environment, or null when the
 * reference is not an allowed key, the variable is empty, or no CalDAV
 * address is known (split out of `runtime.ts`, issue #97).
 */
export function createCalendarCredentialResolver(input: {
  environment: Readonly<Record<string, string | undefined>>;
  defaultBaseUrl: string | undefined;
  logger: Logger;
}): (account: CalendarAccountCredentialsRef) => CalendarCredentials | null {
  return (account) => {
    if (!CREDENTIAL_REF_PATTERN.test(account.credentialRef)) {
      input.logger.error('Calendar account credentialRef is not an allowed environment key', {
        credentialRef: account.credentialRef,
      });
      return null;
    }
    const password = input.environment[account.credentialRef];
    const baseUrl = account.baseUrl ?? input.defaultBaseUrl ?? null;
    if (password === undefined || password.trim().length === 0 || baseUrl === null) return null;
    return { baseUrl, username: account.username, password };
  };
}
