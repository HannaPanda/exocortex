'use client';

import { HandIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@exocortex/ui';

import { useOpenAttentionCount } from '@/lib/api/attention-queries';

/**
 * The way into "Wartet auf dich" from every screen (issue #139).
 *
 * Only there while something waits. An always-present button with a zero on
 * it would be one more call to attention in a bar PRODUCT.md keeps quiet on
 * purpose, and the one thing this button is for is to be noticed when there
 * is a reason. The account menu and the palette reach the page otherwise.
 */
export function AttentionButton() {
  const t = useTranslations('attention.topbar');
  const count = useOpenAttentionCount();
  if (count === 0) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 px-2"
            aria-label={t('label', { count })}
            data-testid="open-attention"
            render={<Link href="/wartet" />}
          >
            <HandIcon />
            <span className="exocortex-numeric rounded-full bg-primary px-1.5 text-xs text-primary-foreground">
              {count > 99 ? '99+' : count}
            </span>
          </Button>
        }
      />
      <TooltipContent>{t('tooltip')}</TooltipContent>
    </Tooltip>
  );
}
