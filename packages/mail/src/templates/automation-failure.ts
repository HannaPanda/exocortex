import { type AutomationFailureReason } from '@exocortex/contracts';

import { type RenderedMail } from '../types';

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
}): RenderedMail {
  return {
    subject: `eXocortex: Automation „${input.ruleName}“ hat sich abgeschaltet`,
    text: [
      'Hallo,',
      '',
      `deine Automation „${input.ruleName}“ ist ${String(input.failures)}-mal hintereinander`,
      'fehlgeschlagen und hat sich deshalb selbst abgeschaltet. Bis du sie wieder',
      'einschaltest, tut sie nichts mehr.',
      '',
      `Zuletzt: ${formatMoment(input.occurredAt, input.timeZone)}`,
      `Grund: ${reasonLine(input.reason)}`,
      '',
      'Im Verlauf der Regel steht, was bei jedem Lauf passiert ist. Dort schaltest du',
      'sie auch wieder ein:',
      '',
      input.url,
      '',
      'eXocortex',
    ].join('\n'),
  };
}

export function automationRunFailedMail(input: {
  ruleName: string;
  reason: AutomationFailureReason;
  occurredAt: string;
  timeZone: string;
  failuresUntilDisabled: number;
  url: string;
}): RenderedMail {
  const remaining =
    input.failuresUntilDisabled === 1
      ? 'Scheitert der nächste Lauf auch, schaltet sich die Regel ab.'
      : `Nach ${String(input.failuresUntilDisabled)} weiteren Fehlschlägen in Folge schaltet sich die Regel ab.`;
  return {
    subject: `eXocortex: Geplanter Lauf von „${input.ruleName}“ ist fehlgeschlagen`,
    text: [
      'Hallo,',
      '',
      `der geplante Lauf deiner Automation „${input.ruleName}“ ist fehlgeschlagen.`,
      '',
      `Wann: ${formatMoment(input.occurredAt, input.timeZone)}`,
      `Grund: ${reasonLine(input.reason)}`,
      '',
      'Die Regel bleibt eingeschaltet und versucht es zum nächsten Termin wieder.',
      remaining,
      'Weitere Fehlschläge derselben Serie melden wir dir nicht einzeln.',
      '',
      'Den Verlauf der Regel findest du hier:',
      '',
      input.url,
      '',
      'eXocortex',
    ].join('\n'),
  };
}
