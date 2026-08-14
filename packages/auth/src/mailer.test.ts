import { createTransport } from 'nodemailer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '@exocortex/logger';

import { createMailer } from './mailer';

vi.mock('nodemailer', () => ({
  createTransport: vi.fn(() => ({ sendMail: vi.fn(async () => undefined), close: vi.fn() })),
}));

const logger = createLogger({ name: 'mailer-test', level: 'silent' });
const createTransportMock = vi.mocked(createTransport);

function transportOptions(): Record<string, unknown> {
  return createTransportMock.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
}

beforeEach(() => {
  createTransportMock.mockClear();
});

/**
 * The transport options decide whether a password is sent over an encrypted
 * connection. That is not something to discover from a production log, so it is
 * asserted here rather than left to the relay to enforce.
 */
describe('createMailer transport', () => {
  it('demands STARTTLS as soon as credentials are supplied', () => {
    createMailer({
      host: 'smtp-relay.example.com',
      port: 587,
      from: 'eXocortex <exocortex@example.com>',
      user: 'relay-user',
      password: 'relay-password',
      logger,
    });

    const options = transportOptions();
    expect(options.requireTLS).toBe(true);
    expect(options.auth).toEqual({ user: 'relay-user', pass: 'relay-password' });
    // Would disable the very upgrade the password depends on.
    expect(options.ignoreTLS).toBeUndefined();
  });

  it('leaves TLS implicit only on the port that is TLS from the first byte', () => {
    createMailer({
      host: 'smtp-relay.example.com',
      port: 465,
      from: 'eXocortex <exocortex@example.com>',
      user: 'relay-user',
      password: 'relay-password',
      logger,
    });

    expect(transportOptions().secure).toBe(true);
  });

  it('keeps submission ports unencrypted-until-upgraded rather than implicit TLS', () => {
    createMailer({
      host: 'smtp-relay.example.com',
      port: 587,
      from: 'eXocortex <exocortex@example.com>',
      user: 'relay-user',
      password: 'relay-password',
      logger,
    });

    expect(transportOptions().secure).toBe(false);
  });

  it('asks for neither login nor TLS when there are no credentials (Mailpit)', () => {
    createMailer({
      host: '127.0.0.1',
      port: 1026,
      from: 'eXocortex <no-reply@example.com>',
      logger,
    });

    const options = transportOptions();
    expect(options.auth).toBeUndefined();
    expect(options.ignoreTLS).toBe(true);
    expect(options.secure).toBe(false);
  });

  it('treats a half-configured pair as no credentials instead of logging in blind', () => {
    createMailer({
      host: '127.0.0.1',
      port: 1026,
      from: 'eXocortex <no-reply@example.com>',
      user: 'relay-user',
      password: '',
      logger,
    });

    const options = transportOptions();
    expect(options.auth).toBeUndefined();
    expect(options.ignoreTLS).toBe(true);
  });
});
