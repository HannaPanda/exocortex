'use client';

import { ArrowDownToLineIcon, ArrowUpToLineIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { useChatScrollPreference } from '@/lib/api/preferences-queries';

import { useLatest } from './contributions';
import { keywordsOf, type PaletteCommand } from './palette-command';

const ICON = 'size-4 text-muted-foreground';

/**
 * Switching how the AI chat scrolls while an answer arrives (issue #282).
 *
 * One command named by what the press does, like showing and hiding the
 * navigation: "am Antwortanfang bleiben" while the chat follows, "mitlaufen"
 * while it stays. Offered everywhere, because the choice is the person's and
 * not the open page's, and the panel need not be open to change it.
 */
export function useChatScrollCommands(): PaletteCommand[] {
  const t = useTranslations('shell.paletteCommands.chatScroll');
  const preference = useChatScrollPreference();
  const latest = useLatest(preference);
  const mode = preference.mode;

  return React.useMemo(() => {
    const next = mode === 'follow' ? 'answerStart' : 'follow';
    return [
      {
        id: 'command-chat-scroll',
        group: 'settings',
        label: next === 'answerStart' ? t('stayAtAnswerStart') : t('follow'),
        hint: t('hint'),
        icon:
          next === 'answerStart' ? (
            <ArrowUpToLineIcon className={ICON} />
          ) : (
            <ArrowDownToLineIcon className={ICON} />
          ),
        keywords: keywordsOf(t('keywords')),
        run: () => latest.current.change(next),
      },
    ];
  }, [mode, t, latest]);
}
