/**
 * Optional HTTP basic auth credentials for the deployment under test.
 *
 * exocortex.app served an nginx basic auth realm in front of everything until
 * 2026-08-09; it no longer does, so a run needs no credentials at all. They stay
 * configurable because a staging deployment may well put one back.
 *
 * What must never come back is a default value. `E2E_BASIC_PASSWORD` used to
 * fall back to `test123` in four places, and that fallback was the real password
 * guarding the deployment: a credential in a public repository, protecting
 * everything behind it. Absent means absent here -- never a guess.
 */
import { loadRepositoryEnv } from './env';

loadRepositoryEnv();

const user = process.env.E2E_BASIC_USER;
const password = process.env.E2E_BASIC_PASSWORD;

/**
 * `httpCredentials` for Playwright's `use` block and `request.newContext`, or
 * `undefined` when the deployment asks for none. Playwright only sends them when
 * a server actually issues a challenge, so passing them at an open deployment is
 * harmless -- but passing a made-up pair to a closed one would silently fail.
 */
export const BASIC_AUTH_CREDENTIALS =
  password !== undefined && password.length > 0
    ? { username: user ?? 'johanna', password }
    : undefined;
