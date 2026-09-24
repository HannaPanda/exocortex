import { type AutomationAction, type AutomationFailureReason } from '@exocortex/contracts';
import { ExocortexApiError } from '@exocortex/mcp-tools';

/**
 * Which step of a run failed, named while the error is still an error
 * (issue #107).
 *
 * The run log keeps the message as it was. The owner's mail must not: it can
 * carry a status line from somebody else's server or a sentence a model wrote.
 * So the error is reduced to a name from a closed list here, where its type is
 * still known, and the mail template chooses the words.
 *
 * The action decides by default, because the action is what the run was
 * doing. Two causes cut across every action and are named first: the page the
 * rule works on answering 403 or 404 to its owner, and the owner's account
 * being the thing that cannot act.
 */
export function classifyAutomationFailure(
  action: AutomationAction,
  error: unknown,
): AutomationFailureReason {
  if (error instanceof ExocortexApiError && (error.status === 403 || error.status === 404)) {
    return 'PAGE_UNAVAILABLE';
  }
  const message = error instanceof Error ? error.message : '';
  // The owner refusals are written in `automation/mail.ts` and `automation.ts`,
  // and all of them name the owner. Matching on the word keeps this list from
  // having to be kept in step with each sentence.
  if (/\bowner\b/i.test(message)) return 'OWNER_UNAVAILABLE';
  switch (action) {
    case 'WEBHOOK':
      return 'WEBHOOK_FAILED';
    case 'AI_RUN':
      return 'AI_FAILED';
    case 'EMAIL_SELF':
      return 'MAIL_FAILED';
  }
}
