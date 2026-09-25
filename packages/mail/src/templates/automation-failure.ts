import { type AutomationFailureReason } from '@exocortex/contracts';

import { type MailContent } from '../layout/content';
import { type MailLanguage } from '../translator';

/**
 * The two mails that say an automation stopped working (issue #107).
 *
 * They exist because of one property of a rule: when it breaks, nobody is
 * looking. A scheduled run fails at three in the morning, a webhook rule fails
 * five times while its owner is on holiday and switches itself off, and from
 * then on it does nothing without saying so. The run log knows, and the run log
 * is read by somebody who already suspects something.
 *
 * What they say is bounded on purpose. The reason is a name from a closed list,
 * turned into a sentence by the catalogue; the error text itself stays in the
 * run log, because it can carry whatever a remote server or a model said, and
 * a mail is a copy that cannot be taken back.
 */

/** What went wrong, in words the reader can act on. */
function reasonLine(reason: AutomationFailureReason, { t }: MailLanguage): string {
  return t(`automationFailure.reason.${reason}`);
}

/**
 * A moment, in the zone the deployment states and the reader's locale. A zone
 * it cannot read falls back to UTC, and says so.
 */
function formatMoment(iso: string, timeZone: string, language: MailLanguage): string {
  const moment = new Date(iso);
  const options: Intl.DateTimeFormatOptions = { dateStyle: 'long', timeStyle: 'short' };
  try {
    return new Intl.DateTimeFormat(language.locale, { ...options, timeZone }).format(moment);
  } catch {
    return language.t('automationFailure.momentUtc', {
      moment: new Intl.DateTimeFormat(language.locale, { ...options, timeZone: 'UTC' }).format(
        moment,
      ),
    });
  }
}

export function automationDisabledMail(
  input: {
    ruleName: string;
    reason: AutomationFailureReason;
    failures: number;
    occurredAt: string;
    timeZone: string;
    url: string;
  },
  language: MailLanguage,
): MailContent {
  const { t } = language;
  return {
    subject: t('common.subject', {
      subject: t('automationFailure.disabled.subject', { rule: input.ruleName }),
    }),
    preheader: t('automationFailure.disabled.preheader', { count: input.failures }),
    heading: t('automationFailure.disabled.heading'),
    greeting: t('common.greeting'),
    blocks: [
      {
        kind: 'paragraph',
        text: t('automationFailure.disabled.body', {
          count: input.failures,
          rule: input.ruleName,
        }),
      },
      { kind: 'notice', text: t('automationFailure.disabled.notice') },
      {
        kind: 'facts',
        rows: [
          {
            label: t('automationFailure.facts.last'),
            value: formatMoment(input.occurredAt, input.timeZone, language),
          },
          { label: t('automationFailure.facts.reason'), value: reasonLine(input.reason, language) },
        ],
      },
      { kind: 'paragraph', text: t('automationFailure.disabled.whereToLook') },
      { kind: 'action', label: t('automationFailure.history'), url: input.url },
    ],
  };
}

export function automationRunFailedMail(
  input: {
    ruleName: string;
    reason: AutomationFailureReason;
    occurredAt: string;
    timeZone: string;
    failuresUntilDisabled: number;
    url: string;
  },
  language: MailLanguage,
): MailContent {
  const { t } = language;
  return {
    subject: t('common.subject', {
      subject: t('automationFailure.runFailed.subject', { rule: input.ruleName }),
    }),
    preheader: t('automationFailure.runFailed.stays'),
    heading: t('automationFailure.runFailed.heading'),
    greeting: t('common.greeting'),
    blocks: [
      {
        kind: 'paragraph',
        text: t('automationFailure.runFailed.body', { rule: input.ruleName }),
      },
      {
        kind: 'facts',
        rows: [
          {
            label: t('automationFailure.facts.when'),
            value: formatMoment(input.occurredAt, input.timeZone, language),
          },
          { label: t('automationFailure.facts.reason'), value: reasonLine(input.reason, language) },
        ],
      },
      { kind: 'paragraph', text: t('automationFailure.runFailed.stays') },
      {
        kind: 'notice',
        text: t('automationFailure.runFailed.remaining', { count: input.failuresUntilDisabled }),
      },
      { kind: 'action', label: t('automationFailure.history'), url: input.url },
    ],
    footer: [t('automationFailure.runFailed.footer')],
  };
}
