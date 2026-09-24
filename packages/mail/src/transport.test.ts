import { createTransport } from 'nodemailer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '@exocortex/logger';

import { createMailTransport, createNoopMailTransport } from './transport';
import { PermanentMailError } from './types';

const sendMail = vi.fn(async () => ({ messageId: '<queued@relay>', accepted: ['a@b.de'] }));

vi.mock('nodemailer', () => ({
  createTransport: vi.fn(() => ({ sendMail, close: vi.fn() })),
}));

const logger = createLogger({ name: 'mail-test', level: 'silent' });
const createTransportMock = vi.mocked(createTransport);

function transportOptions(): Record<string, unknown> {
  return createTransportMock.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
}

const message = { subject: 'eXocortex: Test', text: 'Hallo', html: '<p>Hallo</p>' };

beforeEach(() => {
  createTransportMock.mockClear();
  sendMail.mockClear();
  sendMail.mockResolvedValue({ messageId: '<queued@relay>', accepted: ['a@b.de'] });
});

/**
 * The transport options decide whether a password is sent over an encrypted
 * connection. That is not something to discover from a production log, so it is
 * asserted here rather than left to the relay to enforce.
 */
describe('createMailTransport', () => {
  it('demands STARTTLS as soon as credentials are supplied', () => {
    createMailTransport({
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
    createMailTransport({
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
    createMailTransport({
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
    createMailTransport({
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
    createMailTransport({
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

/**
 * Whether a failure is retried is decided here and nowhere else, so both
 * answers are asserted: a queue that retries a refusal wastes five attempts on
 * an outcome that cannot change, and one that gives up on a busy relay loses
 * the mail.
 */
describe('createMailTransport failure classification', () => {
  const transport = () =>
    createMailTransport({ host: 'relay.example.com', port: 587, from: 'x@y.de', logger });

  it('reports acceptance as the relay described it, not as delivery', async () => {
    sendMail.mockResolvedValue({
      messageId: '<id@relay>',
      accepted: ['a@b.de'],
      rejected: [],
    } as never);

    await expect(transport().send({ to: 'a@b.de', message })).resolves.toEqual({
      messageId: '<id@relay>',
      accepted: ['a@b.de'],
      rejected: [],
    });
  });

  it('hands the relay both bodies, so no client is left with nothing to show', async () => {
    await transport().send({ to: 'a@b.de', message });

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hallo', html: '<p>Hallo</p>' }),
    );
  });

  it('treats a 5xx reply as permanent', async () => {
    sendMail.mockRejectedValue(
      Object.assign(new Error('Mailbox unavailable'), {
        responseCode: 550,
      }) as never,
    );

    await expect(transport().send({ to: 'a@b.de', message })).rejects.toBeInstanceOf(
      PermanentMailError,
    );
  });

  it('leaves a 4xx reply retryable', async () => {
    const busy = Object.assign(new Error('Too many messages'), { responseCode: 451 });
    sendMail.mockRejectedValue(busy as never);

    const error = await transport()
      .send({ to: 'a@b.de', message })
      .catch((caught: unknown) => caught);
    expect(error).toBe(busy);
    expect(error).not.toBeInstanceOf(PermanentMailError);
  });

  it('leaves a broken connection retryable', async () => {
    const dropped = new Error('socket hang up');
    sendMail.mockRejectedValue(dropped as never);

    await expect(transport().send({ to: 'a@b.de', message })).rejects.toBe(dropped);
  });

  it('refuses permanently when the relay took no recipient at all', async () => {
    sendMail.mockResolvedValue({
      messageId: '<id@relay>',
      accepted: [],
      rejected: ['a@b.de'],
    } as never);

    await expect(transport().send({ to: 'a@b.de', message })).rejects.toBeInstanceOf(
      PermanentMailError,
    );
  });
});

describe('createNoopMailTransport', () => {
  it('reports acceptance without opening a connection', async () => {
    const acceptance = await createNoopMailTransport(logger).send({ to: 'a@b.de', message });

    expect(createTransportMock).not.toHaveBeenCalled();
    expect(acceptance).toEqual({ messageId: null, accepted: ['a@b.de'], rejected: [] });
  });
});
