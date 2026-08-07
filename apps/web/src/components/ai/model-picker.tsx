'use client';

import { type AiModel, type AiReasoningLevel } from '@exocortex/contracts';
import {
  Badge,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@exocortex/ui';

const REASONING_LABELS: Record<AiReasoningLevel, string> = {
  none: 'keine',
  minimal: 'minimal',
  low: 'niedrig',
  medium: 'mittel',
  high: 'hoch',
};

/** Sentinel for "no vision companion for this conversation" (request sends `'off'`). */
const OFF_COMPANION = 'off';
/** Sentinel for "use the admin-configured default companion" (request sends `null`). */
const AUTO_COMPANION = 'auto';

function formatPriceUsd(microUsdPerMillionTokens: number): string {
  return (microUsdPerMillionTokens / 1_000_000).toFixed(2).replace('.', ',');
}

function modelTooltip(model: AiModel): string {
  const vision = model.supportsVision
    ? 'ja'
    : `nein${model.visionCompanionSlug !== null ? ` (Begleitmodell: ${model.visionCompanionSlug})` : ''}`;
  return [
    model.slug,
    `Kontext: ${model.contextWindowTokens.toLocaleString('de-DE')} Tokens`,
    `Bildverständnis: ${vision}`,
    `Preis: $${formatPriceUsd(model.inputMicroUsdPerMTok)} / $${formatPriceUsd(model.outputMicroUsdPerMTok)} pro Mio. Tokens`,
  ].join('\n');
}

/** The trigger only ever shows "Automatisch"; the companion slug goes into the
 * tooltip and the dropdown list, where a whole model slug actually fits. */
function visionCompanionTooltip(companionSlug: string | null): string {
  return `Automatischer Begleiter für Bildverständnis: ${companionSlug ?? 'keiner konfiguriert'}`;
}

export interface ModelPickerProps {
  models: AiModel[];
  defaultModelSlug: string | null;
  modelSlug: string | null;
  reasoningLevel: AiReasoningLevel;
  /** `null` = admin default ("Automatisch"), `'off'` = disabled for this conversation. */
  visionCompanionSlug: string | null;
  /** The vision companion override needs an existing conversation (the create
   * request has no field for it); disabled with an explanatory tooltip until then. */
  visionCompanionEditable: boolean;
  onModelChange: (slug: string) => void;
  onReasoningLevelChange: (level: AiReasoningLevel) => void;
  onVisionCompanionChange: (value: string | null) => void;
}

/**
 * Model, thinking-level and (conditionally) vision-companion pickers, all
 * compact because the side panel is narrow.
 */
export function ModelPicker({
  models,
  defaultModelSlug,
  modelSlug,
  reasoningLevel,
  visionCompanionSlug,
  visionCompanionEditable,
  onModelChange,
  onReasoningLevelChange,
  onVisionCompanionChange,
}: ModelPickerProps) {
  const selectedModel = models.find((model) => model.slug === modelSlug) ?? models[0];
  const reasoningLevels = selectedModel?.reasoningLevels ?? [];
  const reasoningDisabled = reasoningLevels.length <= 1;
  const visionCompanions = models.filter((model) => model.supportsVision);
  const showVisionCompanion = selectedModel !== undefined && !selectedModel.supportsVision;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Select value={modelSlug ?? undefined} onValueChange={(next) => next !== null && onModelChange(next)}>
        <Tooltip>
          <TooltipTrigger
            render={
              <SelectTrigger size="sm" className="min-w-0 max-w-[11rem]" data-testid="ai-model-picker">
                <SelectValue>{() => selectedModel?.displayName ?? 'Modell wählen'}</SelectValue>
              </SelectTrigger>
            }
          />
          {selectedModel !== undefined ? (
            <TooltipContent className="whitespace-pre-line">{modelTooltip(selectedModel)}</TooltipContent>
          ) : null}
        </Tooltip>
        <SelectContent>
          {models.map((model) => (
            <SelectItem key={model.slug} value={model.slug}>
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">{model.displayName}</span>
                {model.slug === defaultModelSlug ? <Badge variant="muted">Standard</Badge> : null}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={reasoningLevel}
        disabled={reasoningDisabled}
        onValueChange={(next) => next !== null && onReasoningLevelChange(next as AiReasoningLevel)}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <SelectTrigger size="sm" className="min-w-0 max-w-[7rem]" data-testid="ai-reasoning-picker">
                <SelectValue>{() => REASONING_LABELS[reasoningLevel]}</SelectValue>
              </SelectTrigger>
            }
          />
          {reasoningDisabled ? (
            <TooltipContent>Dieses Modell bietet keine wählbare Denkstufe.</TooltipContent>
          ) : null}
        </Tooltip>
        <SelectContent>
          {reasoningLevels.map((level) => (
            <SelectItem key={level} value={level}>
              {REASONING_LABELS[level]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {showVisionCompanion ? (
        <Select
          value={visionCompanionSlug === null ? AUTO_COMPANION : visionCompanionSlug}
          disabled={!visionCompanionEditable}
          onValueChange={(next) => {
            if (next === null) return;
            onVisionCompanionChange(next === AUTO_COMPANION ? null : next);
          }}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <SelectTrigger
                  size="sm"
                  className="min-w-0 max-w-[9rem]"
                  data-testid="ai-vision-companion-picker"
                >
                  <SelectValue>
                    {(value: string) => (value === OFF_COMPANION ? 'Aus' : 'Automatisch')}
                  </SelectValue>
                </SelectTrigger>
              }
            />
            <TooltipContent>
              {visionCompanionEditable
                ? visionCompanionTooltip(selectedModel.visionCompanionSlug)
                : 'Wird verfügbar, sobald die Unterhaltung begonnen hat.'}
            </TooltipContent>
          </Tooltip>
          <SelectContent>
            <SelectItem value={AUTO_COMPANION}>
              Automatisch ({selectedModel.visionCompanionSlug ?? '—'})
            </SelectItem>
            <SelectItem value={OFF_COMPANION}>Aus</SelectItem>
            {visionCompanions.map((model) => (
              <SelectItem key={model.slug} value={model.slug}>
                {model.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    </div>
  );
}
