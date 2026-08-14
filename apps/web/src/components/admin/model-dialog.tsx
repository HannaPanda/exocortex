'use client';

import * as React from 'react';

import {
  type AiModel,
  type AiReasoningLevel,
  type CreateAiModelRequest,
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

import { useCreateAiModel, useUpdateAiModel } from '@/lib/api/admin-queries';
import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';

const REASONING_LABELS: Record<AiReasoningLevel, string> = {
  none: 'keine',
  minimal: 'minimal',
  low: 'niedrig',
  medium: 'mittel',
  high: 'hoch',
};

const REASONING_ORDER: readonly AiReasoningLevel[] = ['none', 'minimal', 'low', 'medium', 'high'];

/** Sentinel for "no vision companion"; distinct from every real slug. */
const NO_COMPANION = '__none__';

interface ModelFormState {
  slug: string;
  displayName: string;
  description: string;
  contextWindowTokens: string;
  maxOutputTokens: string;
  supportsVision: boolean;
  supportsTools: boolean;
  reasoningLevels: AiReasoningLevel[];
  inputMicroUsdPerMTok: string;
  outputMicroUsdPerMTok: string;
  visionCompanionSlug: string;
  enabled: boolean;
  sortOrder: string;
}

function emptyForm(): ModelFormState {
  return {
    slug: '',
    displayName: '',
    description: '',
    contextWindowTokens: '',
    maxOutputTokens: '',
    supportsVision: false,
    supportsTools: false,
    reasoningLevels: ['none'],
    inputMicroUsdPerMTok: '',
    outputMicroUsdPerMTok: '',
    visionCompanionSlug: NO_COMPANION,
    enabled: true,
    sortOrder: '100',
  };
}

function formFromModel(model: AiModel): ModelFormState {
  return {
    slug: model.slug,
    displayName: model.displayName,
    description: model.description ?? '',
    contextWindowTokens: String(model.contextWindowTokens),
    maxOutputTokens: model.maxOutputTokens !== null ? String(model.maxOutputTokens) : '',
    supportsVision: model.supportsVision,
    supportsTools: model.supportsTools,
    reasoningLevels: model.reasoningLevels.length > 0 ? [...model.reasoningLevels] : ['none'],
    inputMicroUsdPerMTok: String(model.inputMicroUsdPerMTok),
    outputMicroUsdPerMTok: String(model.outputMicroUsdPerMTok),
    visionCompanionSlug: model.visionCompanionSlug ?? NO_COMPANION,
    enabled: model.enabled,
    sortOrder: String(model.sortOrder),
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <ModelDialogForm key={formKey} model={model} models={models} onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}

interface ModelDialogFormProps {
  model?: AiModel;
  models: AiModel[];
  onOpenChange: (open: boolean) => void;
}

function ModelDialogForm({ model, models, onOpenChange }: ModelDialogFormProps) {
  const isEdit = model !== undefined;
  const [form, setForm] = React.useState<ModelFormState>(() =>
    model !== undefined ? formFromModel(model) : emptyForm(),
  );
  const [fieldErrors, setFieldErrors] = React.useState<string[]>([]);
  const createModel = useCreateAiModel();
  const updateModel = useUpdateAiModel();

  const mutation = isEdit ? updateModel : createModel;
  const mutationErrorCode = mutation.error instanceof ApiError ? mutation.error.code : undefined;
  const companionOptions = models.filter((entry) => entry.supportsVision && entry.id !== model?.id);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const errors: string[] = [];
    if (form.slug.trim().length === 0) errors.push('Der Slug darf nicht leer sein.');
    if (form.displayName.trim().length === 0) errors.push('Der Anzeigename darf nicht leer sein.');
    const contextWindow = Number(form.contextWindowTokens);
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
      errors.push('Das Kontextfenster muss eine positive Zahl sein.');
    }
    const inputPrice = Number(form.inputMicroUsdPerMTok);
    const outputPrice = Number(form.outputMicroUsdPerMTok);
    if (!Number.isFinite(inputPrice) || inputPrice < 0) {
      errors.push('Der Eingabepreis muss eine Zahl sein.');
    }
    if (!Number.isFinite(outputPrice) || outputPrice < 0) {
      errors.push('Der Ausgabepreis muss eine Zahl sein.');
    }
    if (form.reasoningLevels.length === 0) {
      errors.push('Mindestens eine Denkstufe muss ausgewählt sein.');
    }

    if (errors.length > 0) {
      setFieldErrors(errors);
      return;
    }
    setFieldErrors([]);

    const maxOutput = form.maxOutputTokens.trim().length > 0 ? Number(form.maxOutputTokens) : null;
    const sortOrder = form.sortOrder.trim().length > 0 ? Number(form.sortOrder) : 100;

    const payload = {
      slug: form.slug.trim(),
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
        <DialogTitle>{isEdit ? 'Modell bearbeiten' : 'Neues Modell'}</DialogTitle>
        <DialogDescription>
          {isEdit
            ? 'Ändert einen bestehenden Eintrag im Modellregister.'
            : 'Fügt ein neues Modell zum Modellregister hinzu.'}
        </DialogDescription>
      </DialogHeader>

      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        {fieldErrors.length > 0 ? (
          <Alert variant="destructive" data-testid="model-dialog-errors">
            <AlertDescription>
              <ul className="list-disc pl-4">
                {fieldErrors.map((error) => (
                  <li key={error}>{error}</li>
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
            <Label htmlFor="model-slug">Slug</Label>
            <Input
              id="model-slug"
              value={form.slug}
              disabled={isEdit}
              placeholder="anthropic/claude-sonnet-5"
              onChange={(event) => setForm((prev) => ({ ...prev, slug: event.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="model-display-name">Anzeigename</Label>
            <Input
              id="model-display-name"
              value={form.displayName}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, displayName: event.target.value }))
              }
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="model-description">Beschreibung</Label>
          <Input
            id="model-description"
            value={form.description}
            onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="model-context">Kontextfenster (Tokens)</Label>
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
            <Label htmlFor="model-max-output">Maximale Ausgabe (Tokens)</Label>
            <Input
              id="model-max-output"
              type="number"
              placeholder="unbegrenzt"
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
            Bildverständnis
          </Label>
          <Label htmlFor="model-tools" className="gap-2">
            <Switch
              id="model-tools"
              checked={form.supportsTools}
              onCheckedChange={(checked) =>
                setForm((prev) => ({ ...prev, supportsTools: checked }))
              }
            />
            Werkzeuge
          </Label>
          <Label htmlFor="model-enabled" className="gap-2">
            <Switch
              id="model-enabled"
              checked={form.enabled}
              onCheckedChange={(checked) => setForm((prev) => ({ ...prev, enabled: checked }))}
            />
            Aktiv
          </Label>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label id="model-reasoning-label">Denkstufen</Label>
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
                {REASONING_LABELS[level]}
              </Toggle>
            ))}
          </ToggleGroup>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="model-input-price">Eingabepreis (µUSD / Mio. Tokens)</Label>
            <Input
              id="model-input-price"
              type="number"
              value={form.inputMicroUsdPerMTok}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, inputMicroUsdPerMTok: event.target.value }))
              }
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="model-output-price">Ausgabepreis (µUSD / Mio. Tokens)</Label>
            <Input
              id="model-output-price"
              type="number"
              value={form.outputMicroUsdPerMTok}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, outputMicroUsdPerMTok: event.target.value }))
              }
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="model-companion">Vision-Begleitmodell</Label>
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
                      ?.displayName ?? 'Keines'
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_COMPANION}>Keines</SelectItem>
                {companionOptions.map((entry) => (
                  <SelectItem key={entry.slug} value={entry.slug}>
                    {entry.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="model-sort-order">Sortierung</Label>
            <Input
              id="model-sort-order"
              type="number"
              value={form.sortOrder}
              onChange={(event) => setForm((prev) => ({ ...prev, sortOrder: event.target.value }))}
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            {isEdit ? 'Speichern' : 'Anlegen'}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
