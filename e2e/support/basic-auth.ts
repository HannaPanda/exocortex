/**
 * HTTP basic auth credentials of the deployment under test.
 *
 * One source for the config, the fixtures and the specs. They used to carry
 * four copies of `?? 'test123'`, and that fallback quietly became the real
 * password guarding the deployment: a credential in a public repository,
 * protecting everything behind it. A missing value now fails the run loudly
 * instead of silently being the answer.
 */
export const BASIC_AUTH_USER = process.env.E2E_BASIC_USER ?? 'johanna';

export const BASIC_AUTH_PASSWORD = ((): string => {
  const password = process.env.E2E_BASIC_PASSWORD;
  if (password === undefined || password.length === 0) {
    throw new Error(
      'E2E_BASIC_PASSWORD is not set. Export the HTTP basic auth password of the ' +
        'deployment under test; there is deliberately no default.',
    );
  }
  return password;
})();

/** Ready-made `httpCredentials` for Playwright's `use` block and `request.newContext`. */
export const BASIC_AUTH_CREDENTIALS = {
  username: BASIC_AUTH_USER,
  password: BASIC_AUTH_PASSWORD,
} as const;
