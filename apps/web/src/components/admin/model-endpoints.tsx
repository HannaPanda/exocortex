'use client';

import { useFormatter, useTranslations } from 'next-intl';

import { type AiModelEndpoint } from '@exocortex/contracts';
import { Badge, ErrorState, LoadingState } from '@exocortex/ui';

import { useAiModelEndpoints } from '@/lib/api/admin-queries';

type Formatter = ReturnType<typeof useFormatter>;

/** Micro-USD per million tokens as a dollar amount with two decimals. */
function formatPrice(format: Formatter, microUsd: number): string {
  return format.number(microUsd / 1_000_000, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** The input an endpoint can really take: its window, or its own tighter prompt cap. */
function usableInputTokens(endpoint: AiModelEndpoint): number {
  return endpoint.maxPromptTokens === null
    ? endpoint.contextWindowTokens
    : Math.min(endpoint.contextWindowTokens, endpoint.maxPromptTokens);
}

export interface ModelEndpointsProps {
  modelId: string;
  modelSlug: string;
}

/**
 * Which providers serve one model, with what capacity (ADR-032).
 *
 * This is the answer to "why did that long conversation not reach the big
 * provider": a request is only ever routed to the providers listed here whose
 * window fits it. The prices are the provider's, not the model row's.
 */
export function ModelEndpoints({ modelId, modelSlug }: ModelEndpointsProps) {
  const endpointsQuery = useAiModelEndpoints(modelId, true);
  const t = useTranslations('admin.endpoints');
  const format = useFormatter();

  if (endpointsQuery.isPending) {
    return <LoadingState label={t('loading')} variant="skeleton" rows={2} />;
  }
  if (endpointsQuery.isError) {
    return <ErrorState title={t('loadFailed')} onRetry={() => void endpointsQuery.refetch()} />;
  }

  const { endpoints, targetSlug, syncedAt } = endpointsQuery.data;
  const synced =
    syncedAt === null
      ? t('syncedNever')
      : t('syncedAt', {
          date: format.dateTime(new Date(syncedAt), { dateStyle: 'short', timeStyle: 'short' }),
        });

  return (
    <div className="flex flex-col gap-2 py-2">
      <p className="text-xs text-muted-foreground">
        {targetSlug !== null && targetSlug !== modelSlug ? (
          <>
            {modelSlug} → <span className="font-medium">{targetSlug}</span> ·{' '}
          </>
        ) : null}
        {endpoints.length === 0 ? t('none') : t('summary', { count: endpoints.length, synced })}
      </p>

      {endpoints.length === 0 ? null : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="text-left">
                <th scope="col" className="py-1 pr-4 font-medium">
                  {t('columns.provider')}
                </th>
                <th scope="col" className="py-1 pr-4 font-medium">
                  {t('columns.input')}
                </th>
                <th scope="col" className="py-1 pr-4 font-medium">
                  {t('columns.output')}
                </th>
                <th scope="col" className="py-1 pr-4 font-medium">
                  {t('columns.price')}
                </th>
                <th scope="col" className="py-1 font-medium">
                  {t('columns.capabilities')}
                </th>
              </tr>
            </thead>
            <tbody>
              {endpoints.map((endpoint) => (
                <tr key={endpoint.providerKey} className="border-t border-border/60">
                  <td className="py-1 pr-4">
                    <span className="font-medium">{endpoint.providerName}</span>{' '}
                    <span className="text-muted-foreground">{endpoint.providerKey}</span>
                  </td>
                  <td className="py-1 pr-4">
                    {t('tokens', { count: usableInputTokens(endpoint) })}
                  </td>
                  <td className="py-1 pr-4">
                    {endpoint.maxOutputTokens === null
                      ? t('outputUnknown')
                      : t('tokens', { count: endpoint.maxOutputTokens })}
                  </td>
                  <td className="py-1 pr-4">
                    {formatPrice(format, endpoint.inputMicroUsdPerMTok)} /{' '}
                    {formatPrice(format, endpoint.outputMicroUsdPerMTok)}
                  </td>
                  <td className="flex flex-wrap gap-1 py-1">
                    {endpoint.supportsTools ? (
                      <Badge variant="secondary">{t('tools')}</Badge>
                    ) : null}
                    {endpoint.supportsReasoningEffort ? (
                      <Badge variant="secondary">{t('reasoning')}</Badge>
                    ) : null}
                    {endpoint.quantization !== null ? (
                      <Badge variant="muted">{endpoint.quantization}</Badge>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
