'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import { Avatar, AvatarFallback, Tooltip, TooltipContent, TooltipTrigger } from '@exocortex/ui';

import { initialsOf, type PresenceUser, useDocumentSession } from './document-session';

/** Live presence of everyone editing the current page. */
export function PresenceAvatars() {
  const { state } = useDocumentSession();
  return <PresenceStack presence={state.presence} />;
}

/**
 * The stack itself, apart from the session it is read from, so the styleguide
 * can draw it with people who are not there.
 */
export function PresenceStack({ presence }: { presence: readonly PresenceUser[] }) {
  const t = useTranslations('shell.presenceAvatars');
  if (presence.length === 0) return null;

  return (
    <div
      className="flex shrink-0 items-center -space-x-1.5"
      data-testid="presence-avatars"
      aria-label={t('label', { count: presence.length })}
    >
      {presence.slice(0, 5).map((user) => (
        <Tooltip key={user.clientId}>
          <TooltipTrigger
            render={
              <Avatar
                className="size-6 ring-2 ring-background"
                style={{ backgroundColor: user.color }}
                data-self={user.self ? 'true' : 'false'}
              >
                <AvatarFallback className="bg-transparent text-nano text-presence-foreground">
                  {initialsOf(user.name)}
                </AvatarFallback>
              </Avatar>
            }
          />
          <TooltipContent>{user.self ? t('self', { name: user.name }) : user.name}</TooltipContent>
        </Tooltip>
      ))}
      {presence.length > 5 ? (
        <span className="pl-3 text-xs text-muted-foreground">+{presence.length - 5}</span>
      ) : null}
    </div>
  );
}
