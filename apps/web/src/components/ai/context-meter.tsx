'use client';

import { useTranslations } from 'next-intl';

import { contextUsagePercentOf } from '@exocortex/contracts';
import { cn, Progress, Tooltip, TooltipContent, TooltipTrigger } from '@exocortex/ui';

export interface ContextMeterProps {
  /** The conversation's `contextTokens`: measured by the provider, or estimated. */
  contextTokens: number;
  contextTokensMeasured: boolean;
  /** The selected model's context window; null when it is not known. */
  contextWindowTokens: number | null;
}

/**
 * Compact context-usage indicator for the conversation control row.
 *
 * The share is computed here with the same function the API uses, against
 * the model selected right now, so switching models moves the meter at once.
 * The tooltip says which number it is: the prompt the provider counted for
 * the newest turn, or an estimate of the messages alone before any turn was
 * measured (issue #193). An unknown window reads "?", never 0 %.
 */
export function ContextMeter({
  contextTokens,
  contextTokensMeasured,
  contextWindowTokens,
}: ContextMeterProps) {
  const t = useTranslations('ai.meter');
  const percent = contextUsagePercentOf(contextTokens, contextWindowTokens);
  const warm = percent !== null && percent >= 70;
  const values = { used: contextTokens, total: contextWindowTokens ?? 0 };
  const tokenLine = contextTokensMeasured
    ? contextWindowTokens === null
      ? t('measured', values)
      : t('measuredOf', values)
    : contextWindowTokens === null
      ? t('estimated', values)
      : t('estimatedOf', values);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div className="flex min-w-0 items-center gap-1.5" data-testid="ai-context-meter">
            <Progress
              value={percent ?? 0}
              label={t('label')}
              className={cn('h-1.5 w-16', warm && '[&>div]:bg-warning')}
            />
            <span className={cn('text-xs', warm ? 'text-foreground' : 'text-muted-foreground')}>
              {percent === null ? t('unknown') : t('percent', { percent })}
            </span>
          </div>
        }
      />
      <TooltipContent>
        {tokenLine}
        {contextWindowTokens === null ? (
          <>
            <br />
            {t('windowUnknown')}
          </>
        ) : null}
        <br />
        {t('compactionHint')}
      </TooltipContent>
    </Tooltip>
  );
}
