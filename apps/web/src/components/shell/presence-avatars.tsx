'use client';

import * as React from 'react';

import {
  Avatar,
  AvatarFallback,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@exocortex/ui';

import { initialsOf, useDocumentSession } from './document-session';

/** Live presence of everyone editing the current page. */
export function PresenceAvatars() {
  const { state } = useDocumentSession();
  if (state.presence.length === 0) return null;

  return (
    <div
      className="flex items-center -space-x-1.5"
      data-testid="presence-avatars"
      aria-label={`${state.presence.length} Personen bearbeiten diese Seite`}
    >
      {state.presence.slice(0, 5).map((user) => (
        <Tooltip key={user.clientId}>
          <TooltipTrigger
            render={
              <Avatar
                className="size-6 ring-2 ring-background"
                style={{ backgroundColor: user.color }}
                data-self={user.self ? 'true' : 'false'}
              >
                <AvatarFallback className="bg-transparent text-[0.625rem] text-presence-foreground">
                  {initialsOf(user.name)}
                </AvatarFallback>
              </Avatar>
            }
          />
          <TooltipContent>{user.self ? `${user.name} (du)` : user.name}</TooltipContent>
        </Tooltip>
      ))}
      {state.presence.length > 5 ? (
        <span className="pl-3 text-xs text-muted-foreground">+{state.presence.length - 5}</span>
      ) : null}
    </div>
  );
}
