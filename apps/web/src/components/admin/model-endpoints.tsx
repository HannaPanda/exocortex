'use client';

import { type AiModelEndpoint } from '@exocortex/contracts';
import { Badge, ErrorState, LoadingState } from '@exocortex/ui';

import { useAiModelEndpoints } from '@/lib/api/admin-queries';

const numberFormat = new Intl.NumberFormat('de-DE');

function formatPrice(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toLocaleString('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatSyncedAt(value: string | null): string {
  if (value === null) return 'noch nie abgeglichen';
  return `abgeglichen am ${new Date(value).toLocaleString('de-DE', {
    dateStyle: 'short',
    timeStyle: 'short',
  })}`;
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

  if (endpointsQuery.isPending) {
    return <LoadingState label="Anbieter werden geladen …" variant="skeleton" rows={2} />;
  }
  if (endpointsQuery.isError) {
    return (
      <ErrorState
        title="Die Anbieter konnten nicht geladen werden"
        onRetry={() => void endpointsQuery.refetch()}
      />
    );
  }

  const { endpoints, targetSlug, syncedAt } = endpointsQuery.data;

  return (
    <div className="flex flex-col gap-2 py-2">
      <p className="text-xs text-muted-foreground">
        {targetSlug !== null && targetSlug !== modelSlug ? (
          <>
            {modelSlug} → <span className="font-medium">{targetSlug}</span> ·{' '}
          </>
        ) : null}
        {endpoints.length === 0
          ? 'Kein Anbieter-Abbild vorhanden: Anfragen werden ohne Einschränkung geroutet.'
          : `${endpoints.length} Anbieter · ${formatSyncedAt(syncedAt)}`}
      </p>

      {endpoints.length === 0 ? null : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="text-left">
                <th className="py-1 pr-4 font-medium">Anbieter</th>
                <th className="py-1 pr-4 font-medium">Eingabe</th>
                <th className="py-1 pr-4 font-medium">Ausgabe</th>
                <th className="py-1 pr-4 font-medium">Preis</th>
                <th className="py-1 font-medium">Kann</th>
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
                    {numberFormat.format(usableInputTokens(endpoint))} Tokens
                  </td>
                  <td className="py-1 pr-4">
                    {endpoint.maxOutputTokens === null
                      ? 'ohne Angabe'
                      : `${numberFormat.format(endpoint.maxOutputTokens)} Tokens`}
                  </td>
                  <td className="py-1 pr-4">
                    {formatPrice(endpoint.inputMicroUsdPerMTok)} /{' '}
                    {formatPrice(endpoint.outputMicroUsdPerMTok)}
                  </td>
                  <td className="flex flex-wrap gap-1 py-1">
                    {endpoint.supportsTools ? <Badge variant="secondary">Werkzeuge</Badge> : null}
                    {endpoint.supportsReasoningEffort ? (
                      <Badge variant="secondary">Denkstufen</Badge>
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
