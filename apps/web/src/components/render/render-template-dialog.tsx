'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  RENDER_MAX_VARIABLES,
  type RenderTemplate,
  type RenderVariable,
  type RenderVariableOrigin,
} from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Button,
  Checkbox,
  Dialog,
  DialogBody,
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
  Textarea,
} from '@exocortex/ui';

import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import { useCreateRenderTemplate, useUpdateRenderTemplate } from '@/lib/api/render-queries';

import { useRenderWording, VARIABLE_ORIGIN_ORDER } from './render-labels';

/**
 * Writing a render template (issue #44, ADR-026).
 *
 * The body field is Pandoc's template language, not one of ours, and the dialog
 * says so rather than validating it: a LaTeX preamble that does not compile is a
 * build failure with a log next to it, and a form that tried to guess in advance
 * which packages the container has would be wrong the first time the image
 * changes.
 */
export function RenderTemplateDialog({
  open,
  onOpenChange,
  workspaceId,
  template,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  template: RenderTemplate | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        {/* Keyed, so opening the dialog for a different template starts from
            that template's values. A `useEffect` copying props into state would
            do the same thing one render too late, and twice. */}
        <TemplateForm
          key={`${template?.id ?? 'new'}:${String(open)}`}
          workspaceId={workspaceId}
          template={template}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function TemplateForm({
  workspaceId,
  template,
  onDone,
}: {
  workspaceId: string;
  template: RenderTemplate | null;
  onDone: () => void;
}) {
  const t = useTranslations('render.templateDialog');
  const wording = useRenderWording();
  const create = useCreateRenderTemplate(workspaceId);
  const update = useUpdateRenderTemplate(workspaceId);

  const [name, setName] = React.useState(template?.name ?? '');
  const [description, setDescription] = React.useState(template?.description ?? '');
  const [source, setSource] = React.useState(template?.source ?? '');
  const [useBuiltIn, setUseBuiltIn] = React.useState(template === null || template.source === null);
  const [variables, setVariables] = React.useState<RenderVariable[]>(
    template === null ? [] : [...template.variables],
  );
  const [error, setError] = React.useState<string | null>(null);

  const save = async (): Promise<void> => {
    setError(null);
    const body = {
      name: name.trim(),
      description: description.trim(),
      renderer: 'LATEX_PDF' as const,
      source: useBuiltIn ? null : source,
      variables,
    };
    try {
      if (template === null) {
        await create.mutateAsync(body);
      } else {
        await update.mutateAsync({ templateId: template.id, request: body });
      }
      onDone();
    } catch (cause) {
      setError(saveFailureMessage(cause, t('saveFailed')));
    }
  };

  const patchVariable = (index: number, patch: Partial<RenderVariable>): void => {
    setVariables((previous) =>
      previous.map((variable, position) =>
        position === index ? { ...variable, ...patch } : variable,
      ),
    );
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{template === null ? t('newTitle') : t('editTitle')}</DialogTitle>
        <DialogDescription>
          {t.rich('description', {
            title: '$title$',
            body: '$body$',
            loop: '$for(...)$',
            code: (chunks) => <code>{chunks}</code>,
          })}
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="template-name">{t('name')}</Label>
          <Input
            id="template-name"
            value={name}
            data-testid="template-name"
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="template-description">{t('templateDescription')}</Label>
          <Input
            id="template-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t('templateDescriptionPlaceholder')}
          />
        </div>

        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={useBuiltIn}
            onCheckedChange={(checked) => setUseBuiltIn(checked === true)}
          />
          {t('useBuiltIn')}
        </label>

        {useBuiltIn ? null : (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="template-source">{t('source')}</Label>
            <Textarea
              id="template-source"
              rows={14}
              value={source}
              data-testid="template-source"
              onChange={(event) => setSource(event.target.value)}
              className="font-mono text-xs"
            />
          </div>
        )}

        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <Label>{t('variables')}</Label>
            <Button
              variant="outline"
              size="sm"
              disabled={variables.length >= RENDER_MAX_VARIABLES}
              onClick={() =>
                setVariables((previous) => [
                  ...previous,
                  {
                    name: `variable-${String(previous.length + 1)}`,
                    label: t('newVariableLabel'),
                    origin: 'MANUAL',
                    property: null,
                    required: false,
                    defaultValue: null,
                  },
                ])
              }
            >
              {t('addVariable')}
            </Button>
          </div>

          {variables.map((variable, index) => (
            <div
              key={index}
              className="flex flex-col gap-2 rounded-md border border-border p-3"
              data-testid="template-variable"
            >
              <div className="flex gap-2">
                <Input
                  value={variable.name}
                  aria-label={t('variableName')}
                  onChange={(event) => patchVariable(index, { name: event.target.value })}
                  className="font-mono"
                />
                <Input
                  value={variable.label}
                  aria-label={t('variableLabel')}
                  onChange={(event) => patchVariable(index, { label: event.target.value })}
                />
              </div>
              <div className="flex gap-2">
                <Select
                  value={variable.origin}
                  onValueChange={(value) =>
                    patchVariable(index, { origin: value as RenderVariableOrigin })
                  }
                >
                  <SelectTrigger aria-label={t('variableOrigin')}>
                    <SelectValue>{() => wording.variableOrigin(variable.origin)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {VARIABLE_ORIGIN_ORDER.map((value) => (
                      <SelectItem key={value} value={value}>
                        {wording.variableOrigin(value)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {variable.origin === 'PROPERTY' ? (
                  <Input
                    value={variable.property ?? ''}
                    aria-label={t('propertyName')}
                    placeholder={t('propertyPlaceholder')}
                    onChange={(event) => patchVariable(index, { property: event.target.value })}
                  />
                ) : null}
              </div>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={variable.required}
                    onCheckedChange={(checked) =>
                      patchVariable(index, { required: checked === true })
                    }
                  />
                  {t('required')}
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  onClick={() =>
                    setVariables((previous) =>
                      previous.filter((_entry, position) => position !== index),
                    )
                  }
                >
                  {t('removeVariable')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </DialogBody>

      {error === null ? null : (
        <Alert variant="destructive">
          <AlertDescription data-testid="template-error">{error}</AlertDescription>
        </Alert>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={onDone}>
          {t('cancel')}
        </Button>
        <Button
          data-testid="template-save"
          disabled={name.trim().length === 0 || create.isPending || update.isPending}
          onClick={() => void save()}
        >
          {t('save')}
        </Button>
      </DialogFooter>
    </>
  );
}

function saveFailureMessage(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError) {
    return cause.message.length > 0 ? cause.message : messageForCode(cause.code);
  }
  return fallback;
}
