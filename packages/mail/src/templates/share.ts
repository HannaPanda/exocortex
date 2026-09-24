import { type SharePermission, type ShareScope } from '@exocortex/contracts';

import { type MailBlock, type MailContent } from '../layout/content';

/**
 * The three mails a changed grant sends (issue #103).
 *
 * A share is a lasting change to what somebody can reach, which is why it is
 * post and not a push: it is still true tomorrow, and the person it concerns
 * is usually not looking at eXocortex when it happens.
 *
 * They say what the grant now is rather than what it was. A before-and-after
 * reads like a diff and answers the wrong question -- the reader wants to know
 * what they may do now, and the withdrawal mail is the extreme case of the
 * same rule: it names the page and stops there, because a link it cannot open
 * and a permission it no longer has are not facts it is owed.
 */

const dateFormat = new Intl.DateTimeFormat('de-DE', { dateStyle: 'long' });

/** What the grant allows, in the words the share dialog uses. */
function permissionLine(permission: SharePermission): string {
  return permission === 'WRITE' ? 'Lesen und Bearbeiten' : 'Nur Lesen';
}

/** How far the grant reaches. */
function scopeLine(scope: ShareScope): string {
  return scope === 'SUBTREE' ? 'Die Seite und alles, was darunter hängt' : 'Nur diese eine Seite';
}

/** What a grant says, as label and value. The expiry only when there is one. */
function grantFacts(input: {
  permission: SharePermission;
  scope: ShareScope;
  expiresAt: string | null;
}): MailBlock {
  const rows = [
    { label: 'Erlaubt', value: permissionLine(input.permission) },
    { label: 'Umfang', value: scopeLine(input.scope) },
  ];
  if (input.expiresAt !== null) {
    rows.push({ label: 'Gilt bis', value: dateFormat.format(new Date(input.expiresAt)) });
  }
  return { kind: 'facts', rows };
}

export function shareGrantedMail(input: {
  sharedByName: string;
  documentTitle: string;
  permission: SharePermission;
  scope: ShareScope;
  url: string;
  expiresAt: string | null;
}): MailContent {
  return {
    subject: `eXocortex: ${input.sharedByName} hat „${input.documentTitle}“ mit dir geteilt`,
    preheader: `${permissionLine(input.permission)}. ${scopeLine(input.scope)}.`,
    heading: `„${input.documentTitle}“ ist mit dir geteilt`,
    greeting: 'Hallo,',
    blocks: [
      {
        kind: 'paragraph',
        text: `${input.sharedByName} hat die Seite „${input.documentTitle}“ in eXocortex mit dir geteilt.`,
      },
      grantFacts(input),
      { kind: 'action', label: 'Seite öffnen', url: input.url },
      {
        kind: 'paragraph',
        text: 'Du musst dafür in keinem Arbeitsbereich Mitglied sein. Die Seite steht ab jetzt in deiner Liste „Mit mir geteilt“.',
      },
    ],
  };
}

export function shareChangedMail(input: {
  changedByName: string;
  documentTitle: string;
  permission: SharePermission;
  scope: ShareScope;
  url: string;
  expiresAt: string | null;
}): MailContent {
  return {
    subject: `eXocortex: Deine Freigabe für „${input.documentTitle}“ hat sich geändert`,
    preheader: `Ab sofort: ${permissionLine(input.permission)}. ${scopeLine(input.scope)}.`,
    heading: 'Deine Freigabe hat sich geändert',
    greeting: 'Hallo,',
    blocks: [
      {
        kind: 'paragraph',
        text: `${input.changedByName} hat geändert, was du an der Seite „${input.documentTitle}“ darfst. Es gilt ab sofort:`,
      },
      grantFacts(input),
      { kind: 'action', label: 'Seite öffnen', url: input.url },
    ],
  };
}

export function shareRevokedMail(input: {
  revokedByName: string;
  documentTitle: string;
  url: string;
}): MailContent {
  return {
    subject: `eXocortex: Dein Zugang zu „${input.documentTitle}“ ist beendet`,
    preheader: `${input.revokedByName} hat die Freigabe zurückgezogen.`,
    heading: 'Dein Zugang ist beendet',
    greeting: 'Hallo,',
    blocks: [
      {
        kind: 'paragraph',
        text: `${input.revokedByName} hat deine Freigabe für die Seite „${input.documentTitle}“ in eXocortex zurückgezogen. Die Seite lässt sich damit nicht mehr öffnen.`,
      },
      // A plain link, not a button: nothing here is an action the reader is
      // being asked to take.
      { kind: 'link', label: 'Was weiterhin mit dir geteilt ist', url: input.url },
    ],
  };
}
