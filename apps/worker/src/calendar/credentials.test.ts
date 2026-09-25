import { describe, expect, it } from 'vitest';

import { createLogger } from '@exocortex/logger';

import { createCalendarCredentialResolver } from './credentials';

const logger = createLogger({ name: 'worker-test', level: 'silent' });

const account = {
  provider: 'caldav',
  username: 'johanna',
  credentialRef: 'MAILBOX_CALDAV_PASSWORD',
  baseUrl: null,
};

describe('createCalendarCredentialResolver', () => {
  const resolve = createCalendarCredentialResolver({
    environment: {
      MAILBOX_CALDAV_PASSWORD: 'geheim',
      DATABASE_URL: 'postgres://user:pw@host/db',
      EMPTY_PASSWORD: '   ',
    },
    defaultBaseUrl: 'https://dav.example.org',
    logger,
  });

  it('reads the password from the named variable and falls back to the default address', () => {
    expect(resolve(account)).toEqual({
      baseUrl: 'https://dav.example.org',
      username: 'johanna',
      password: 'geheim',
    });
  });

  it('prefers the address stored on the account', () => {
    expect(resolve({ ...account, baseUrl: 'https://other.example.org' })?.baseUrl).toBe(
      'https://other.example.org',
    );
  });

  it('refuses a reference that is not a password, token or secret', () => {
    // The row decides which variable is read and the value goes out in an
    // Authorization header, so this is what keeps DATABASE_URL at home.
    expect(resolve({ ...account, credentialRef: 'DATABASE_URL' })).toBeNull();
    expect(resolve({ ...account, credentialRef: 'mailbox_caldav_password' })).toBeNull();
  });

  it('answers null for an empty variable or when no address is known', () => {
    expect(resolve({ ...account, credentialRef: 'EMPTY_PASSWORD' })).toBeNull();
    const withoutDefault = createCalendarCredentialResolver({
      environment: { MAILBOX_CALDAV_PASSWORD: 'geheim' },
      defaultBaseUrl: undefined,
      logger,
    });
    expect(withoutDefault(account)).toBeNull();
  });
});
