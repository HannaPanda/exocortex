import { describe, expect, it, vi } from 'vitest';

import { type MailDeliveryJob, type QUEUE_NAMES } from '@exocortex/contracts';
import { createLogger } from '@exocortex/logger';
import { type Mailer, PermanentMailError } from '@exocortex/mail';
import { type JobContext, UnrecoverableError } from '@exocortex/queue';

import { createMailDeliveryProcessor } from './mail-delivery';

const logger = createLogger({ name: 'mail-delivery-test', level: 'silent' });

const job: MailDeliveryJob = {
  correlationId: 'test',
  recipient: 'stefan@exocortex.test',
  mail: {
    template: 'INVITATION',
    invitedByName: 'Johanna',
    workspaceName: 'Second Brain',
    url: 'https://exocortex.app/einladung/abc',
    expiresAt: '2026-10-01T09:00:00.000Z',
  },
};

function contextFor(payload: MailDeliveryJob): JobContext<typeof QUEUE_NAMES.mail> {
  return {
    payload,
    logger,
    job: {} as JobContext<typeof QUEUE_NAMES.mail>['job'],
    reportProgress: async () => {},
  };
}

function mailerThat(send: Mailer['send']): Mailer {
  return { send, close: async () => {} };
}

/**
 * What is under test is the one decision this processor makes: retry, or do
 * not. Getting it wrong in either direction is expensive -- five attempts
 * against a mailbox that does not exist, or a mail lost because the relay was
 * busy for a minute.
 */
describe('createMailDeliveryProcessor', () => {
  it('sends the message the job names, to the address the job names', async () => {
    const send = vi.fn(async () => ({
      messageId: '<id@relay>',
      accepted: [job.recipient],
      rejected: [],
    }));

    await createMailDeliveryProcessor({ mailer: mailerThat(send) })(contextFor(job));

    expect(send).toHaveBeenCalledWith({ to: job.recipient, message: job.mail });
  });

  it('gives up for good when the relay refused the message', async () => {
    const send = vi.fn(async () => {
      throw new PermanentMailError('The relay refused the message (550)');
    });

    await expect(
      createMailDeliveryProcessor({ mailer: mailerThat(send) })(contextFor(job)),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('lets a temporary failure through so BullMQ retries it', async () => {
    const busy = new Error('421 Service not available');
    const send = vi.fn(async () => {
      throw busy;
    });

    const error = await createMailDeliveryProcessor({ mailer: mailerThat(send) })(contextFor(job))
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBe(busy);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
  });

  it('sends each template the catalogue offers', async () => {
    const send = vi.fn(async () => ({ messageId: null, accepted: ['a@b.de'], rejected: [] }));
    const processor = createMailDeliveryProcessor({ mailer: mailerThat(send) });

    await processor(
      contextFor({
        correlationId: 'test',
        recipient: 'a@b.de',
        mail: { template: 'PASSWORD_RESET', name: 'Johanna', url: 'https://exocortex.app/x' },
      }),
    );
    await processor(
      contextFor({
        correlationId: 'test',
        recipient: 'a@b.de',
        mail: { template: 'EMAIL_VERIFICATION', name: 'Johanna', url: 'https://exocortex.app/y' },
      }),
    );

    expect(
      send.mock.calls.map(
        ([input]) => (input as { message: { template: string } }).message.template,
      ),
    ).toEqual(['PASSWORD_RESET', 'EMAIL_VERIFICATION']);
  });
});
