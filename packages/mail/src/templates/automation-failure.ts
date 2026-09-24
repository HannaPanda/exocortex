import { type AutomationFailureReason } from '@exocortex/contracts';

import { type MailContent } from '../layout/content';

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
 * turned into a sentence here; the error text itself stays in the run log,
 * because it can carry whatever a remote server or a model said, and a mail is
 * a copy that cannot be taken back.
 */

/** What went wrong, in words the reader can act on. */
function reasonLine(reason: AutomationFailureReason): string {
  switch (reason) {
    case 'WEBHOOK_FAILED':
      return 'Der Server, an den die Regel meldet, hat abgelehnt oder war nicht erreichbar.';
    case 'AI_FAILED':
      return 'Der KI-Auftrag der Regel ist gescheitert, zum Beispiel weil das Modell nicht geantwortet hat oder die KI ausgeschaltet ist.';
    case 'PAGE_UNAVAILABLE':
      return 'Die Seite, auf der die Regel arbeitet, ließ sich mit deinem Konto nicht lesen oder beschreiben.';
    case 'OWNER_UNAVAILABLE':
      return 'Dein Konto kann die Regel gerade nicht ausführen, zum Beispiel ohne bestätigte E-Mail-Adresse.';
    case 'MAIL_FAILED':
      return 'Die Regel konnte die Seite nicht als Mail verschicken.';
  }
}

/** A moment, in the zone the deployment states. A zone it cannot read falls back to UTC. */
function formatMoment(iso: string, timeZone: string): string {
  const moment = new Date(iso);
  const options: Intl.DateTimeFormatOptions = { dateStyle: 'long', timeStyle: 'short' };
  try {
    return new Intl.DateTimeFormat('de-DE', { ...options, timeZone }).format(moment);
  } catch {
    return `${new Intl.DateTimeFormat('de-DE', { ...options, timeZone: 'UTC' }).format(moment)} (UTC)`;
  }
}

export function automationDisabledMail(input: {
  ruleName: string;
  reason: AutomationFailureReason;
  failures: number;
  occurredAt: string;
  timeZone: string;
  url: string;
}): MailContent {
  return {
    subject: `eXocortex: Automation „${input.ruleName}“ hat sich abgeschaltet`,
    preheader: `Nach ${String(input.failures)} Fehlschlägen in Folge tut sie nichts mehr.`,
    heading: 'Eine Automation hat sich abgeschaltet',
    greeting: 'Hallo,',
    blocks: [
      {
        kind: 'paragraph',
        text: `deine Automation „${input.ruleName}“ ist ${String(input.failures)}-mal hintereinander fehlgeschlagen und hat sich deshalb selbst abgeschaltet.`,
      },
      { kind: 'notice', text: 'Bis du sie wieder einschaltest, tut sie nichts mehr.' },
      {
        kind: 'facts',
        rows: [
          { label: 'Zuletzt', value: formatMoment(input.occurredAt, input.timeZone) },
          { label: 'Grund', value: reasonLine(input.reason) },
        ],
      },
      {
        kind: 'paragraph',
        text: 'Im Verlauf der Regel steht, was bei jedem Lauf passiert ist. Dort schaltest du sie auch wieder ein.',
      },
      { kind: 'action', label: 'Verlauf ansehen', url: input.url },
    ],
  };
}

export function automationRunFailedMail(input: {
  ruleName: string;
  reason: AutomationFailureReason;
  occurredAt: string;
  timeZone: string;
  failuresUntilDisabled: number;
  url: string;
}): MailContent {
  const remaining =
    input.failuresUntilDisabled === 1
      ? 'Scheitert der nächste Lauf auch, schaltet sich die Regel ab.'
      : `Nach ${String(input.failuresUntilDisabled)} weiteren Fehlschlägen in Folge schaltet sich die Regel ab.`;
  return {
    subject: `eXocortex: Geplanter Lauf von „${input.ruleName}“ ist fehlgeschlagen`,
    preheader: 'Die Regel bleibt eingeschaltet und versucht es zum nächsten Termin wieder.',
    heading: 'Ein geplanter Lauf ist fehlgeschlagen',
    greeting: 'Hallo,',
    blocks: [
      {
        kind: 'paragraph',
        text: `der geplante Lauf deiner Automation „${input.ruleName}“ ist fehlgeschlagen.`,
      },
      {
        kind: 'facts',
        rows: [
          { label: 'Wann', value: formatMoment(input.occurredAt, input.timeZone) },
          { label: 'Grund', value: reasonLine(input.reason) },
        ],
      },
      {
        kind: 'paragraph',
        text: 'Die Regel bleibt eingeschaltet und versucht es zum nächsten Termin wieder.',
      },
      { kind: 'notice', text: remaining },
      { kind: 'action', label: 'Verlauf ansehen', url: input.url },
    ],
    footer: ['Weitere Fehlschläge derselben Serie melden wir dir nicht einzeln.'],
  };
}
