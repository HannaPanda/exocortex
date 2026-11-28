'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import { CHAT_SCROLL_MODES, type ChatScrollMode } from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  ErrorState,
  Label,
  LoadingState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import { useChatScrollPreference, useUserPreferences } from '@/lib/api/preferences-queries';

function isChatScrollMode(value: unknown): value is ChatScrollMode {
  return typeof value === 'string' && (CHAT_SCROLL_MODES as readonly string[]).includes(value);
}

/**
 * How the AI chat behaves for this account (issue #282): for now, whether the
 * transcript follows an answer while it arrives or stays at its start.
 *
 * A select like the language page beside it, with the chosen mode explained
 * underneath, because the two names only say what happens once one has seen
 * both. The same choice sits in the chat panel's menu and in the palette.
 */
export function ChatSettings() {
  const t = useTranslations('settings.chat');
  const query = useUserPreferences();
  const preference = useChatScrollPreference();
  const [failed, setFailed] = React.useState(false);

  const change = (value: string | null) => {
    if (!isChatScrollMode(value)) return;
    setFailed(false);
    preference.change(value, { onError: () => setFailed(true) });
  };

  const labelOf = (mode: ChatScrollMode) => (mode === 'follow' ? t('follow') : t('answerStart'));

  return (
    <div className="flex flex-col gap-6">
      {failed ? (
        <Alert variant="destructive">
          <AlertDescription>{t('saveFailed')}</AlertDescription>
        </Alert>
      ) : null}

      {query.isPending ? (
        <LoadingState label={t('loading')} variant="skeleton" rows={1} />
      ) : query.isError ? (
        <ErrorState title={t('loadError')} onRetry={() => void query.refetch()} />
      ) : (
        <div className="flex flex-col gap-2">
          <Label htmlFor="chat-scroll">{t('scrollLegend')}</Label>
          <Select value={preference.mode} onValueChange={change}>
            <SelectTrigger id="chat-scroll" className="w-full sm:w-72" data-testid="chat-scroll">
              <SelectValue>{() => labelOf(preference.mode)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {CHAT_SCROLL_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {labelOf(mode)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="max-w-measure text-xs text-muted-foreground">
            {preference.mode === 'follow' ? t('followHint') : t('answerStartHint')}
          </p>
        </div>
      )}
    </div>
  );
}
