import { type MailMessage } from '@exocortex/contracts';

import { passwordResetMail, verificationMail } from './templates/auth';
import { invitationMail } from './templates/invitation';
import { shareChangedMail, shareGrantedMail, shareRevokedMail } from './templates/share';
import { type RenderedMail } from './types';

/**
 * Turns a named message into the words a reader sees.
 *
 * Exhaustive by construction: the union is closed, so adding a template
 * without adding a branch here is a type error rather than a mail that leaves
 * as an empty page. That is the only reason the dispatch is a switch and not a
 * lookup table -- a record keyed by name would be satisfied by a wrong
 * function just as happily.
 */
export function renderMail(message: MailMessage): RenderedMail {
  switch (message.template) {
    case 'EMAIL_VERIFICATION':
      return verificationMail({ name: message.name, url: message.url });
    case 'PASSWORD_RESET':
      return passwordResetMail({ name: message.name, url: message.url });
    case 'INVITATION':
      return invitationMail({
        invitedByName: message.invitedByName,
        workspaceName: message.workspaceName,
        url: message.url,
        expiresAt: new Date(message.expiresAt),
      });
    case 'SHARE_GRANTED':
      return shareGrantedMail({
        sharedByName: message.sharedByName,
        documentTitle: message.documentTitle,
        permission: message.permission,
        scope: message.scope,
        url: message.url,
        expiresAt: message.expiresAt,
      });
    case 'SHARE_CHANGED':
      return shareChangedMail({
        changedByName: message.changedByName,
        documentTitle: message.documentTitle,
        permission: message.permission,
        scope: message.scope,
        url: message.url,
        expiresAt: message.expiresAt,
      });
    case 'SHARE_REVOKED':
      return shareRevokedMail({
        revokedByName: message.revokedByName,
        documentTitle: message.documentTitle,
        url: message.url,
      });
  }
}
