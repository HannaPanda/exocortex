'use client';

import { useTranslations } from 'next-intl';

import { cn, Progress, Tooltip, TooltipContent, TooltipTrigger } from '@exocortex/ui';

export interface ContextMeterProps {
  estimatedTokens: number;
  contextUsagePercent: number;
  /** The selected model's context window, for the "N von M Tokens" tooltip line. */
  contextWindowTokens: number | null;
}

/**
 * Compact context-usage indicator for the conversation control row.
 *
 * The percentage is an estimate (exact token counting happens inside the
 * provider call, not client-side), so the word "Geschätzt" must appear in the
 * tooltip rather than presenting the number as exact.
 */
export function ContextMeter({
  estimatedTokens,
  contextUsagePercent,
  contextWindowTokens,
}: ContextMeterProps) {
  const t = useTranslations('ai.meter');
  const warm = contextUsagePercent >= 70;
  const tokenLine =
    contextWindowTokens === null
      ? t('estimated', { used: estimatedTokens })
      : t('estimatedOf', { used: estimatedTokens, total: contextWindowTokens });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div className="flex min-w-0 items-center gap-1.5" data-testid="ai-context-meter">
            <Progress
              value={contextUsagePercent}
              label={t('label')}
              className={cn('h-1.5 w-16', warm && '[&>div]:bg-warning')}
            />
            <span className={cn('text-xs', warm ? 'text-foreground' : 'text-muted-foreground')}>
              {t('percent', { percent: contextUsagePercent })}
            </span>
          </div>
        }
      />
      <TooltipContent>
        {tokenLine}
        <br />
        {t('compactionHint')}
      </TooltipContent>
    </Tooltip>
  );
}
