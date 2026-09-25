import { type MailDeliveryJob, type QUEUE_NAMES } from '@exocortex/contracts';
import { type Mailer, PermanentMailError } from '@exocortex/mail';
import { type JobContext, UnrecoverableError } from '@exocortex/queue';

/**
 * Sends one notification mail (issue #102).
 *
 * This is the asynchronous half of the split. The mails a request waits on --
 * verification, password reset, an invitation whose response says whether it
 * went out -- are sent by the API, synchronously, because the caller needs the
 * answer. Everything else arrives here, where a relay having a bad five
 * minutes delays a mail instead of failing whatever caused it.
 *
 * Two outcomes, and keeping them apart is the whole job:
 *
 *   - the relay refuses the message (5xx, or it takes no recipient). The same
 *     message to the same relay will be refused again, so it fails
 *     unrecoverably and stays in the failed set where somebody can look at it.
 *   - anything else -- a 4xx, a dropped socket, a name that would not resolve
 *     -- is thrown on, and BullMQ's five attempts over about eight minutes get
 *     another go.
 *
 * What is never done here is deciding who should receive the mail. The
 * producer resolved that, and re-resolving it would put the question in two
 * places (see `mailDeliveryJobSchema`).
 */

export interface MailDeliveryDependencies {
  /**
   * The worker's transport. Never null: `createMailerFromEnv` answers a
   * deployment with no relay with a mailer that logs instead of sending, so a
   * missing SMTP host is not a reason for a job to fail.
   */
  mailer: Mailer;
}

export function createMailDeliveryProcessor(dependencies: MailDeliveryDependencies) {
  const { mailer } = dependencies;

  return async ({ payload, logger }: JobContext<typeof QUEUE_NAMES.mail>): Promise<void> => {
    const job: MailDeliveryJob = payload;
    try {
      const acceptance = await mailer.send({
        to: job.recipient,
        message: job.mail,
        locale: job.locale,
      });
      // "accepted", not "delivered": the relay owes us the next hop and
      // nothing here can know whether an inbox ever shows it.
      logger.debug('Mail handed to the relay', {
        template: job.mail.template,
        messageId: acceptance.messageId,
      });
    } catch (error) {
      if (error instanceof PermanentMailError) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  };
}
