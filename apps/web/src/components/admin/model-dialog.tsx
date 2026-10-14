'use client';

import { useLocale, useTranslations } from 'next-intl';
import * as React from 'react';

import {
  AI_MODEL_PROVIDERS,
  type AiModel,
  type AiModelProvider,
  type AiReasoningLevel,
  type CreateAiModelRequest,
  type ProviderRoutingOverride,
  type UpdateAiModelRequest,
} from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Toggle,
  ToggleGroup,
} from '@exocortex/ui';

import { ProviderRoutingEditor } from '@/components/ai/provider-routing-editor';
import {
  useAdminSettings,
  useAiModelEndpoints,
  useCreateAiModel,
  useUpdateAiModel,
} from '@/lib/api/admin-queries';
import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import { microUsdFromText, usdInputText } from '@/lib/money';

const REASONING_ORDER: readonly AiReasoningLevel[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/** Client-side validation failures, named by their catalogue key. */
type FieldErrorKey =
  | 'slugRequired'
  | 'displayNameRequired'
  | 'contextWindowPositive'
  | 'inputPriceNumber'
  | 'outputPriceNumber'
  | 'reasoningRequired'
  | 'providerRoutingInvalid';

/** Sentinel for "no vision companion"; distinct from every real slug. */
const NO_COMPANION = '__none__';

interface ModelFormState {
  slug: string;
  /** Who serves the model (issue #187): OpenRouter or a checked subscription preset. */
  provider: AiModelProvider;
  displayName: string;
  description: string;
  contextWindowTokens: string;
  maxOutputTokens: string;
  supportsVision: boolean;
  supportsTools: boolean;
  reasoningLevels: AiReasoningLevel[];
  /** Dollars per million tokens, as typed; stored as micro-dollars (issue #167). */
  inputUsdPerMTok: string;
  outputUsdPerMTok: string;
  visionCompanionSlug: string;
  enabled: boolean;
  sortOrder: string;
  /** The override of `ai.providerRouting`; `null` inherits the setting (ADR-063). */
  providerRouting: ProviderRoutingOverride | null;
  /** False while the routing form describes no override (issue #201). */
  providerRoutingValid: boolean;
}

function isModelProvider(value: string): value is AiModelProvider {
  return (AI_MODEL_PROVIDERS as readonly string[]).includes(value);
}

/** The offline mock is offered only to a row that already names it. */
function providerOptions(current: AiModelProvider): readonly AiModelProvider[] {
  return AI_MODEL_PROVIDERS.filter((entry) => entry !== 'mock' || entry === current);
}

function emptyForm(): ModelFormState {
  return {
    slug: '',
    provider: 'openrouter',
    displayName: '',
    description: '',
    contextWindowTokens: '',
    maxOutputTokens: '',
    supportsVision: false,
    supportsTools: false,
    reasoningLevels: ['none'],
    inputUsdPerMTok: '',
    outputUsdPerMTok: '',
    visionCompanionSlug: NO_COMPANION,
    enabled: true,
    sortOrder: '100',
    providerRouting: null,
    providerRoutingValid: true,
  };
}

function formFromModel(model: AiModel, locale: string): ModelFormState {
  return {
    slug: model.slug,
    provider: isModelProvider(model.provider) ? model.provider : 'openrouter',
    displayName: model.displayName,
    description: model.description ?? '',
    contextWindowTokens: String(model.contextWindowTokens),
    maxOutputTokens: model.maxOutputTokens !== null ? String(model.maxOutputTokens) : '',
    supportsVision: model.supportsVision,
    supportsTools: model.supportsTools,
    reasoningLevels: model.reasoningLevels.length > 0 ? [...model.reasoningLevels] : ['none'],
    inputUsdPerMTok: usdInputText(model.inputMicroUsdPerMTok, locale),
    outputUsdPerMTok: usdInputText(model.outputMicroUsdPerMTok, locale),
    visionCompanionSlug: model.visionCompanionSlug ?? NO_COMPANION,
    enabled: model.enabled,
    sortOrder: String(model.sortOrder),
    providerRouting: model.providerRouting,
    providerRoutingValid: true,
  };
}

export interface ModelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present in edit mode; absent when creating a new model. */
  model?: AiModel;
  /** Full registry, used to populate the vision companion picker. */
  models: AiModel[];
}

/**
 * Create/edit dialog for one row of the AI model registry.
 *
 * The draft form state lives in the inner `ModelDialogForm`, which is remounted
 * (via the `formKey` bump below) every time the dialog opens. That is what
 * resets the draft between an "Anlegen" and the next "Bearbeiten" without a
 * reset effect: bumping state directly during render, guarded so it only fires
 * once per open, is the pattern React recommends instead (react.dev:
 * "Adjusting state when a prop changes").
 */
export function ModelDialog({ open, onOpenChange, model, models }: ModelDialogProps) {
  const [formKey, setFormKey] = React.useState(0);
  const [wasOpen, setWasOpen] = React.useState(false);
  if (open && !wasOpen) {
    setWasOpen(true);
    setFormKey((key) => key + 1);
  } else if (!open && wasOpen) {
    setWasOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <ModelDialogForm key={formKey} model={model} models={models} onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}

/** Who serves the model (issue #187): OpenRouter or a checked subscription preset. */
function ProviderField({
  value,
  onChange,
}: {
  value: AiModelProvider;
  onChange: (provider: AiModelProvider) => void;
}) {
  const t = useTranslations('admin.modelDialog');
  const providerLabel = useTranslations('admin.modelProviders');
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="model-provider">{t('fields.provider')}</Label>
      <Select
        value={value}
        onValueChange={(next) => {
          if (next !== null && isModelProvider(next)) onChange(next);
        }}
      >
        <SelectTrigger
          id="model-provider"
          className="w-full"
          aria-describedby="model-provider-help"
        >
          <SelectValue>{() => providerLabel(value)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {providerOptions(value).map((entry) => (
            <SelectItem key={entry} value={entry}>
              {providerLabel(entry)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p id="model-provider-help" className="text-xs text-muted-foreground">
        {t('fields.providerHelp')}
      </p>
    </div>
  );
}

/**
 * The model's override of `ai.providerRouting` (ADR-063, issue #201). The
 * lists offer the providers of the model's endpoint snapshot, and the preview
 * lays the override over the deployment setting.
 */
function ProviderRoutingField({
  modelId,
  value,
  invalid,
  onChange,
}: {
  modelId: string | undefined;
  value: ProviderRoutingOverride | null;
  invalid: boolean;
  onChange: (value: ProviderRoutingOverride | null | undefined) => void;
}) {
  const t = useTranslations('admin.modelDialog');
  const endpoints = useAiModelEndpoints(modelId ?? '', modelId !== undefined);
  const settings = useAdminSettings();
  const suggestions = React.useMemo(
    () => [...new Set((endpoints.data?.endpoints ?? []).map((entry) => entry.providerKey))],
    [endpoints.data],
  );
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5 border-0 p-0">
      <legend className="mb-1.5 text-sm leading-none font-medium">
        {t('fields.providerRouting')}
      </legend>
      <p id="model-provider-routing-help" className="mb-2 text-xs text-muted-foreground">
        {t('fields.providerRoutingHelp')}
      </p>
      <ProviderRoutingEditor
        id="model-provider-routing"
        mode="override"
        value={value}
        suggestions={suggestions}
        inherited={settings.data?.settings['ai.providerRouting']}
        describedBy="model-provider-routing-help"
        invalid={invalid}
        onChange={(next) =>
          onChange(next === undefined ? undefined : Object.keys(next).length === 0 ? null : next)
        }
      />
    </fieldset>
  );
}

interface ModelDialogFormProps {
  model?: AiModel;
  models: AiModel[];
  onOpenChange: (open: boolean) => void;
}

function ModelDialogForm({ model, models, onOpenChange }: ModelDialogFormProps) {
  const isEdit = model !== undefined;
  const locale = useLocale();
  const [form, setForm] = React.useState<ModelFormState>(() =>
    model !== undefined ? formFromModel(model, locale) : emptyForm(),
  );
  const [fieldErrors, setFieldErrors] = React.useState<FieldErrorKey[]>([]);
  const t = useTranslations('admin.modelDialog');
  const reasoningLabel = useTranslations('admin.reasoningLevels');
  const createModel = useCreateAiModel();
  const updateModel = useUpdateAiModel();

  const mutation = isEdit ? updateModel : createModel;
  const mutationErrorCode = mutation.error instanceof ApiError ? mutation.error.code : undefined;
  const companionOptions = models.filter((entry) => entry.supportsVision && entry.id !== model?.id);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const errors: FieldErrorKey[] = [];
    if (form.slug.trim().length === 0) errors.push('slugRequired');
    if (form.displayName.trim().length === 0) errors.push('displayNameRequired');
    const contextWindow = Number(form.contextWindowTokens);
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
      errors.push('contextWindowPositive');
    }
    // An empty price is a free model, as it always was; anything else has to
    // be an exact dollar amount, never rounded on its way to micro-dollars.
    const priceOf = (text: string): number | null =>
      text.trim().length === 0 ? 0 : microUsdFromText(text);
    const inputPrice = priceOf(form.inputUsdPerMTok);
    const outputPrice = priceOf(form.outputUsdPerMTok);
    if (inputPrice === null) {
      errors.push('inputPriceNumber');
    }
    if (outputPrice === null) {
      errors.push('outputPriceNumber');
    }
    if (form.reasoningLevels.length === 0) {
      errors.push('reasoningRequired');
    }
    if (!form.providerRoutingValid) {
      errors.push('providerRoutingInvalid');
    }

    if (errors.length > 0 || inputPrice === null || outputPrice === null) {
      setFieldErrors(errors);
      return;
    }
    setFieldErrors([]);

    const maxOutput = form.maxOutputTokens.trim().length > 0 ? Number(form.maxOutputTokens) : null;
    const sortOrder = form.sortOrder.trim().length > 0 ? Number(form.sortOrder) : 100;

    const payload = {
      slug: form.slug.trim(),
      provider: form.provider,
      displayName: form.displayName.trim(),
      description: form.description.trim().length > 0 ? form.description.trim() : null,
      contextWindowTokens: contextWindow,
      maxOutputTokens: maxOutput,
      supportsVision: form.supportsVision,
      supportsTools: form.supportsTools,
      reasoningLevels: form.reasoningLevels,
      inputMicroUsdPerMTok: inputPrice,
      outputMicroUsdPerMTok: outputPrice,
      visionCompanionSlug:
        form.visionCompanionSlug === NO_COMPANION ? null : form.visionCompanionSlug,
      enabled: form.enabled,
      sortOrder,
      providerRouting: form.providerRouting,
    };

    if (isEdit && model !== undefined) {
      updateModel.mutate(
        { modelId: model.id, request: payload as UpdateAiModelRequest },
        { onSuccess: () => onOpenChange(false) },
      );
    } else {
      createModel.mutate(payload as CreateAiModelRequest, { onSuccess: () => onOpenChange(false) });
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{isEdit ? t('editTitle') : t('createTitle')}</DialogTitle>
        <DialogDescription>
          {isEdit ? t('editDescription') : t('createDescription')}
        </DialogDescription>
      </DialogHeader>

      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        {fieldErrors.length > 0 ? (
          <Alert variant="destructive" data-testid="model-dialog-errors">
            <AlertDescription>
              <ul className="list-disc pl-4">
                {fieldErrors.map((error) => (
                  <li key={error}>{t(`errors.${error}`)}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}
        {mutation.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{messageForCode(mutationErrorCode)}</AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="model-slug">{t('fields.slug')}</Label>
            <Input
              id="model-slug"
              value={form.slug}
              disabled={isEdit}
              placeholder="anthropic/claude-sonnet-5"
              onChange={(event) => setForm((prev) => ({ ...prev, slug: event.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="model-display-name">{t('fields.displayName')}</Label>
            <Input
              id="model-display-name"
              value={form.displayName}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, displayName: event.target.value }))
              }
            />
          </div>
        </div>

        <ProviderField
          value={form.provider}
          onChange={(provider) => setForm((prev) => ({ ...prev, provider }))}
        />

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="model-description">{t('fields.description')}</Label>
          <Input
            id="model-description"
            value={form.description}
            onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="model-context">{t('fields.contextWindow')}</Label>
            <Input
              id="model-context"
              type="number"
              value={form.contextWindowTokens}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, contextWindowTokens: event.target.value }))
              }
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="model-max-output">{t('fields.maxOutput')}</Label>
            <Input
              id="model-max-output"
              type="number"
              placeholder={t('fields.maxOutputPlaceholder')}
              value={form.maxOutputTokens}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, maxOutputTokens: event.target.value }))
              }
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-6">
          <Label htmlFor="model-vision" className="gap-2">
            <Switch
              id="model-vision"
              checked={form.supportsVision}
              onCheckedChange={(checked) =>
                setForm((prev) => ({ ...prev, supportsVision: checked }))
              }
            />
            {t('fields.vision')}
          </Label>
          <Label htmlFor="model-tools" className="gap-2">
            <Switch
              id="model-tools"
              checked={form.supportsTools}
              onCheckedChange={(checked) =>
                setForm((prev) => ({ ...prev, supportsTools: checked }))
              }
            />
            {t('fields.tools')}
          </Label>
          <Label htmlFor="model-enabled" className="gap-2">
            <Switch
              id="model-enabled"
              checked={form.enabled}
              onCheckedChange={(checked) => setForm((prev) => ({ ...prev, enabled: checked }))}
            />
            {t('fields.enabled')}
          </Label>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label id="model-reasoning-label">{t('fields.reasoning')}</Label>
          <ToggleGroup
            aria-labelledby="model-reasoning-label"
            value={form.reasoningLevels}
            multiple
            onValueChange={(next) =>
              setForm((prev) => ({ ...prev, reasoningLevels: next as AiReasoningLevel[] }))
            }
          >
            {REASONING_ORDER.map((level) => (
              <Toggle key={level} value={level} variant="outline" size="sm">
                {reasoningLabel(level)}
              </Toggle>
            ))}
          </ToggleGroup>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="model-input-price">{t('fields.inputPrice')}</Label>
            <Input
              id="model-input-price"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={form.inputUsdPerMTok}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, inputUsdPerMTok: event.target.value }))
              }
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="model-output-price">{t('fields.outputPrice')}</Label>
            <Input
              id="model-output-price"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={form.outputUsdPerMTok}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, outputUsdPerMTok: event.target.value }))
              }
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="model-companion">{t('fields.companion')}</Label>
            <Select
              value={form.visionCompanionSlug}
              onValueChange={(next) =>
                setForm((prev) => ({ ...prev, visionCompanionSlug: next ?? NO_COMPANION }))
              }
            >
              <SelectTrigger id="model-companion" className="w-full">
                {/* Base UI shows the raw value (the slug) without this. */}
                <SelectValue>
                  {() =>
                    companionOptions.find((entry) => entry.slug === form.visionCompanionSlug)
                      ?.displayName ?? t('fields.companionNone')
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_COMPANION}>{t('fields.companionNone')}</SelectItem>
                {companionOptions.map((entry) => (
                  <SelectItem key={entry.slug} value={entry.slug}>
                    {entry.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="model-sort-order">{t('fields.sortOrder')}</Label>
            <Input
              id="model-sort-order"
              type="number"
              value={form.sortOrder}
              onChange={(event) => setForm((prev) => ({ ...prev, sortOrder: event.target.value }))}
            />
          </div>
        </div>

        <ProviderRoutingField
          modelId={model?.id}
          value={form.providerRouting}
          invalid={fieldErrors.includes('providerRoutingInvalid')}
          onChange={(providerRouting) =>
            setForm((prev) =>
              providerRouting === undefined
                ? { ...prev, providerRoutingValid: false }
                : { ...prev, providerRouting, providerRoutingValid: true },
            )
          }
        />

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            {isEdit ? t('save') : t('create')}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
