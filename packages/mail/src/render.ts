import { type Locale, type MailMessage } from '@exocortex/contracts';

import { composeMail } from './layout/compose';
import { type MailContent } from './layout/content';
import { passwordResetMail, verificationMail } from './templates/auth';
import { automationPageMail } from './templates/automation';
import { automationDisabledMail, automationRunFailedMail } from './templates/automation-failure';
import { commentDigestMail } from './templates/comment-digest';
import { invitationMail } from './templates/invitation';
import { shareChangedMail, shareGrantedMail, shareRevokedMail } from './templates/share';
import { mailLanguage } from './translator';
import { type RenderedMail } from './types';

/**
 * Turns a named message into the mail a reader sees: the template chooses the
 * words, `composeMail` draws them, once in HTML and once as plain text.
 *
 * `locale` is the reader's (ADR-062): the recipient's `User.locale`, or for an
 * invitation the language its sender chose. Never the requester's by accident.
 */
export function renderMail(message: MailMessage, locale: Locale): RenderedMail {
  return composeMail(mailContent(message, locale), locale);
}

/**
 * Turns a named message into the words a reader sees.
 *
 * Exhaustive by construction: the union is closed, so adding a template
 * without adding a branch here is a type error rather than a mail that leaves
 * as an empty page. That is the only reason the dispatch is a switch and not a
 * lookup table -- a record keyed by name would be satisfied by a wrong
 * function just as happily.
 */
export function mailContent(message: MailMessage, locale: Locale): MailContent {
  const language = mailLanguage(locale);
  switch (message.template) {
    case 'EMAIL_VERIFICATION':
      return verificationMail({ name: message.name, url: message.url }, language);
    case 'PASSWORD_RESET':
      return passwordResetMail({ name: message.name, url: message.url }, language);
    case 'INVITATION':
      return invitationMail(
        {
          invitedByName: message.invitedByName,
          workspaceName: message.workspaceName,
          url: message.url,
          expiresAt: new Date(message.expiresAt),
        },
        language,
      );
    case 'SHARE_GRANTED':
      return shareGrantedMail(
        {
          sharedByName: message.sharedByName,
          documentTitle: message.documentTitle,
          permission: message.permission,
          scope: message.scope,
          url: message.url,
          expiresAt: message.expiresAt,
        },
        language,
      );
    case 'SHARE_CHANGED':
      return shareChangedMail(
        {
          changedByName: message.changedByName,
          documentTitle: message.documentTitle,
          permission: message.permission,
          scope: message.scope,
          url: message.url,
          expiresAt: message.expiresAt,
        },
        language,
      );
    case 'SHARE_REVOKED':
      return shareRevokedMail(
        {
          revokedByName: message.revokedByName,
          documentTitle: message.documentTitle,
          url: message.url,
        },
        language,
      );
    case 'COMMENT_DIGEST':
      return commentDigestMail(
        {
          commentCount: message.commentCount,
          pages: message.pages,
          morePages: message.morePages,
        },
        language,
      );
    case 'AUTOMATION_PAGE':
      return automationPageMail(
        {
          ruleName: message.ruleName,
          subject: message.subject,
          documentTitle: message.documentTitle,
          url: message.url,
          body: message.body,
          truncated: message.truncated,
        },
        language,
      );
    case 'AUTOMATION_DISABLED':
      return automationDisabledMail(
        {
          ruleName: message.ruleName,
          reason: message.reason,
          failures: message.failures,
          occurredAt: message.occurredAt,
          timeZone: message.timeZone,
          url: message.url,
        },
        language,
      );
    case 'AUTOMATION_RUN_FAILED':
      return automationRunFailedMail(
        {
          ruleName: message.ruleName,
          reason: message.reason,
          occurredAt: message.occurredAt,
          timeZone: message.timeZone,
          failuresUntilDisabled: message.failuresUntilDisabled,
          url: message.url,
        },
        language,
      );
  }
}
