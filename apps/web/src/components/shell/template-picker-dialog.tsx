'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { type DocumentTemplate } from '@exocortex/contracts';
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
  EmptyState,
  ErrorState,
  Input,
  Label,
  LoadingState,
} from '@exocortex/ui';

import { DocumentIcon } from '@/components/document/document-icon';
import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import { useInstantiateTemplate, useTemplates } from '@/lib/api/template-queries';
import { documentHref } from '@/lib/document-href';

/**
 * "Neue Seite aus Vorlage" (issue #79, ADR-039).
 *
 * The title field is optional and stays empty by default, because most
 * templates carry a pattern that already answers the question. What is typed
 * here wins over that pattern unless the pattern has a `{{titel}}` for it --
 * a field that is silently ignored is worse than no field.
 */
export function TemplatePickerDialog({
  workspaceId,
  open,
  parentId,
  onOpenChange,
}: {
  workspaceId: string;
  open: boolean;
  /**
   * Where the new page goes. `undefined` leaves the decision to the template's
   * own suggested target, which is the normal case; the tree's context menu
   * passes a page to overrule it.
   */
  parentId?: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [title, setTitle] = React.useState('');
  const templates = useTemplates(open ? workspaceId : undefined);
  const instantiate = useInstantiateTemplate(workspaceId);

  const changeOpen = (next: boolean): void => {
    if (!next) setTitle('');
    onOpenChange(next);
  };

  const use = (template: DocumentTemplate): void => {
    if (instantiate.isPending) return;
    const trimmed = title.trim();
    void instantiate
      .mutateAsync({
        documentId: template.document.id,
        request: {
          ...(trimmed.length > 0 ? { title: trimmed } : {}),
          ...(parentId === undefined ? {} : { parentId }),
        },
      })
      .then((result) => {
        changeOpen(false);
        router.push(documentHref(workspaceId, result.document.id, 'PAGE'));
      })
      .catch(() => {
        // Shown from `instantiate.isError`; the dialog stays open so the
        // template can be picked again once the reason is gone.
      });
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent data-testid="template-picker">
        <DialogHeader>
          <DialogTitle>Neue Seite aus Vorlage</DialogTitle>
          <DialogDescription>
            Der Inhalt der Vorlage wird kopiert. Die neue Seite ist danach eine gewöhnliche Seite
            ohne Verbindung zur Vorlage.
          </DialogDescription>
        </DialogHeader>

        {instantiate.isError ? (
          <Alert variant="destructive" data-testid="template-picker-error">
            <AlertDescription>
              {messageForCode(
                instantiate.error instanceof ApiError ? instantiate.error.code : undefined,
              )}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="template-title">Titel (optional)</Label>
          <Input
            id="template-title"
            value={title}
            placeholder="Sonst entscheidet das Titelmuster der Vorlage"
            data-testid="template-title"
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>

        {templates.isPending ? (
          <LoadingState variant="skeleton" rows={3} label="Vorlagen werden geladen" />
        ) : templates.isError ? (
          <ErrorState onRetry={() => void templates.refetch()} title="Vorlagen nicht geladen" />
        ) : templates.data.templates.length === 0 ? (
          <EmptyState
            title="Noch keine Vorlagen"
            description="Öffne eine Seite, die sich wiederholt, und markiere sie im Seitenmenü als Vorlage."
          />
        ) : (
          <ul className="flex flex-col gap-1" data-testid="template-list">
            {templates.data.templates.map((template) => (
              <li key={template.document.id}>
                <button
                  type="button"
                  disabled={instantiate.isPending}
                  onClick={() => use(template)}
                  data-testid="template-option"
                  className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/60 disabled:opacity-60"
                >
                  <DocumentIcon
                    icon={template.document.icon}
                    iconColor={template.document.iconColor}
                    type="PAGE"
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm">{template.document.title}</span>
                    {template.description === null ? null : (
                      <span className="truncate text-xs text-muted-foreground">
                        {template.description}
                      </span>
                    )}
                    {template.targetParent === null ? null : (
                      <span className="truncate text-xs text-muted-foreground">
                        Landet unter „{template.targetParent.title}“
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => changeOpen(false)}>
            Schließen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
