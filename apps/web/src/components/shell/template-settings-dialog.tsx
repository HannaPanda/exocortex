'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import { renderTitlePattern, TEMPLATE_TITLE_PLACEHOLDERS } from '@exocortex/contracts';
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
  Textarea,
} from '@exocortex/ui';

import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import {
  useCreateTemplate,
  useDeleteTemplate,
  useTemplates,
  useUpdateTemplate,
} from '@/lib/api/template-queries';

/**
 * The three mutations behind this dialog, as one object.
 *
 * Marking, changing and unmarking are one decision from where the reader
 * stands, and collapsing them here keeps the component below the branch count
 * that makes a form unreadable.
 */
function useTemplateWriter(input: {
  workspaceId: string;
  documentId: string;
  isTemplate: boolean;
  onDone: () => void;
}) {
  const createTemplate = useCreateTemplate(input.workspaceId);
  const updateTemplate = useUpdateTemplate(input.workspaceId);
  const deleteTemplate = useDeleteTemplate(input.workspaceId);

  const failure = [createTemplate.error, updateTemplate.error, deleteTemplate.error].find(
    (candidate) => candidate !== null,
  );

  return {
    // One code for the form to render, whatever of the three failed. A
    // failure that is not an `ApiError` has no code and falls back to the
    // generic sentence.
    error:
      failure === undefined
        ? undefined
        : failure instanceof ApiError
          ? failure.code
          : 'internal_error',
    pending: createTemplate.isPending || updateTemplate.isPending || deleteTemplate.isPending,
    save: (fields: { description: string | null; titlePattern: string | null }): void => {
      const request = input.isTemplate
        ? updateTemplate.mutateAsync({ documentId: input.documentId, request: fields })
        : createTemplate.mutateAsync({ documentId: input.documentId, ...fields });
      void request.then(input.onDone).catch(() => undefined);
    },
    unmark: (): void => {
      void deleteTemplate
        .mutateAsync(input.documentId)
        .then(input.onDone)
        .catch(() => undefined);
    },
  };
}

/**
 * Making the open page a template, and the two fields that go with it (issue
 * #79, ADR-039).
 *
 * The title pattern gets a live preview. A pattern language without one is a
 * guessing game: `{{kw}}` is either the calendar week or four characters of
 * literal text, and the only honest way to say which is to show the result.
 */
export function TemplateSettingsDialog({
  workspaceId,
  documentId,
  documentTitle,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  documentId: string;
  documentTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('document.templateSettings');
  const templates = useTemplates(open ? workspaceId : undefined);

  const existing =
    templates.data?.templates.find((template) => template.document.id === documentId) ?? null;

  const writer = useTemplateWriter({
    workspaceId,
    documentId,
    isTemplate: existing !== null,
    onDone: () => onOpenChange(false),
  });

  const [description, setDescription] = React.useState('');
  const [titlePattern, setTitlePattern] = React.useState('');
  // Which template the two fields were filled from. Without it the dialog
  // would either overwrite what is being typed on every refetch, or never pick
  // up the values of the page it was opened for.
  const [loadedFor, setLoadedFor] = React.useState<string | null>(null);

  if (open && loadedFor !== documentId && templates.data !== undefined) {
    setLoadedFor(documentId);
    setDescription(existing?.description ?? '');
    setTitlePattern(existing?.titlePattern ?? '');
  }
  if (!open && loadedFor !== null) setLoadedFor(null);

  const preview = renderTitlePattern({
    pattern: titlePattern.trim().length === 0 ? null : titlePattern,
    fallbackTitle: documentTitle,
    now: new Date(),
    // The browser's zone, not the workspace's: this is a preview of what the
    // server will produce, and the two agree wherever somebody works in the
    // zone their workspace is configured for. The real title is rendered on
    // the server, which is the one that counts.
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });

  const save = (): void => {
    writer.save({
      description: description.trim().length === 0 ? null : description.trim(),
      titlePattern: titlePattern.trim().length === 0 ? null : titlePattern.trim(),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="template-settings">
        <DialogHeader>
          <DialogTitle>{existing === null ? t('titleMark') : t('titleEdit')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        {writer.error === undefined ? null : (
          <Alert variant="destructive" data-testid="template-settings-error">
            <AlertDescription>{messageForCode(writer.error)}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="template-description">{t('purpose')}</Label>
            <Textarea
              id="template-description"
              rows={2}
              value={description}
              placeholder={t('purposePlaceholder')}
              data-testid="template-description"
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="template-pattern">{t('pattern')}</Label>
            <Input
              id="template-pattern"
              value={titlePattern}
              placeholder={t('patternPlaceholder', { token: '{{kw}}' })}
              data-testid="template-pattern"
              onChange={(event) => setTitlePattern(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t.rich('preview', {
                preview,
                result: (chunks) => <span className="text-foreground">{chunks}</span>,
              })}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('placeholders', {
                placeholders: Object.keys(TEMPLATE_TITLE_PLACEHOLDERS)
                  .map((name) => `{{${name}}}`)
                  .join(', '),
              })}
            </p>
          </div>
        </div>

        <DialogFooter>
          {existing === null ? null : (
            <Button
              variant="ghost"
              className="mr-auto"
              disabled={writer.pending}
              data-testid="template-unmark"
              onClick={writer.unmark}
            >
              {t('unmark')}
            </Button>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button onClick={save} disabled={writer.pending} data-testid="template-save">
            {existing === null ? t('mark') : t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
