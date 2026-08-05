'use client';

import * as React from 'react';

import { ALLOWED_ATTACHMENT_MIME_TYPES, type DocumentTreeNode } from '@exocortex/contracts';
import { type BlockPromptKind } from '@exocortex/editor';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Label,
  Textarea,
} from '@exocortex/ui';

import { ApiError } from '@/lib/api/client';
import { uploadAttachment, useDocumentTree } from '@/lib/api/queries';

/** Every `COLLECTION` document in the tree, flattened, for the database picker. */
function collectDatabases(nodes: readonly DocumentTreeNode[]): DocumentTreeNode[] {
  const result: DocumentTreeNode[] = [];
  for (const node of nodes) {
    if (node.type === 'COLLECTION') result.push(node);
    result.push(...collectDatabases(node.children));
  }
  return result;
}

/** What the dialog asks for, and what it does with the answer. */
interface PendingPrompt {
  kind: Exclude<BlockPromptKind, 'none' | 'file'>;
  title: string;
  description: string;
  placeholder: string;
  resolve: (value: string | null) => void;
}

const PROMPT_COPY: Readonly<
  Record<PendingPrompt['kind'], Omit<PendingPrompt, 'kind' | 'resolve'>>
> = {
  url: {
    title: 'Adresse einfügen',
    description: 'Gib die vollständige Adresse ein, zum Beispiel https://exocortex.app/bild.png',
    placeholder: 'https://…',
  },
  latex: {
    title: 'Formel eingeben',
    description: 'LaTeX-Notation, zum Beispiel \\sum_{i=1}^{n} x_i',
    placeholder: 'a^2 + b^2 = c^2',
  },
  page: {
    title: 'Seite verknüpfen',
    description: 'Titel der Seite, auf die verlinkt werden soll.',
    placeholder: 'Seitentitel',
  },
  database: {
    title: 'Datenbank einbetten',
    description: 'Wähle eine bestehende Datenbank aus diesem Arbeitsbereich.',
    placeholder: 'Datenbank suchen …',
  },
};

export interface BlockPromptController {
  /**
   * Asks the user for the extra value a catalog entry needs. Resolves with `null`
   * when the dialog is dismissed or the upload fails.
   */
  ask: (kind: BlockPromptKind) => Promise<string | null>;
  /** The dialog element; render it once next to the editor. */
  element: React.ReactNode;
  /** German message of the last failed upload, or `null`. */
  error: string | null;
}

export interface UseBlockPromptOptions {
  workspaceId: string;
  documentId: string;
}

/**
 * Collects whatever a catalog entry needs before it can run: a URL, a formula, a
 * page title, or an uploaded file.
 *
 * A promise-returning `ask` keeps the call sites readable: an entry with
 * `prompt: 'url'` is executed as `run(editor, await ask('url'))` instead of
 * spreading the flow across three pieces of component state.
 */
export function useBlockPrompt({
  workspaceId,
  documentId,
}: UseBlockPromptOptions): BlockPromptController {
  const [pending, setPending] = React.useState<PendingPrompt | null>(null);
  const [value, setValue] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const fileInput = React.useRef<HTMLInputElement | null>(null);
  const fileResolve = React.useRef<((value: string | null) => void) | null>(null);
  const tree = useDocumentTree(pending?.kind === 'database' ? workspaceId : undefined);
  const databases = React.useMemo(
    () => (tree.data === undefined ? [] : collectDatabases(tree.data.nodes)),
    [tree.data],
  );
  const filteredDatabases = React.useMemo(() => {
    const needle = value.trim().toLowerCase();
    if (needle.length === 0) return databases;
    return databases.filter((database) => database.title.toLowerCase().includes(needle));
  }, [databases, value]);

  const ask = React.useCallback(
    (kind: BlockPromptKind): Promise<string | null> => {
      if (kind === 'none') return Promise.resolve(null);

      if (kind === 'file') {
        setError(null);
        return new Promise<string | null>((resolve) => {
          fileResolve.current = resolve;
          // Resetting the value makes picking the same file twice fire `change`.
          if (fileInput.current !== null) {
            fileInput.current.value = '';
            fileInput.current.click();
          } else {
            resolve(null);
          }
        });
      }

      return new Promise<string | null>((resolve) => {
        setValue('');
        setPending({ kind, ...PROMPT_COPY[kind], resolve });
      });
    },
    [],
  );

  const onFileSelected = async (file: File | undefined): Promise<void> => {
    const resolve = fileResolve.current;
    fileResolve.current = null;
    if (file === undefined || resolve === null) {
      resolve?.(null);
      return;
    }
    try {
      const uploaded = await uploadAttachment({ workspaceId, documentId, file });
      resolve(uploaded.src);
    } catch (uploadError) {
      setError(
        uploadError instanceof ApiError
          ? uploadError.message
          : 'Die Datei konnte nicht hochgeladen werden.',
      );
      resolve(null);
    }
  };

  const finish = (result: string | null): void => {
    pending?.resolve(result);
    setPending(null);
  };

  const submit = (): void => {
    const trimmed = value.trim();
    finish(trimmed.length === 0 ? null : trimmed);
  };

  const element = (
    <>
      {/* One hidden input for every upload; `accept` mirrors the MIME allow list
          of the attachment endpoint (packages/contracts/src/attachments.ts). */}
      <input
        ref={fileInput}
        type="file"
        hidden
        accept={ALLOWED_ATTACHMENT_MIME_TYPES.join(',')}
        data-testid="block-file-input"
        onChange={(event) => void onFileSelected(event.target.files?.[0])}
      />
      {error === null ? null : (
        <p className="mt-2 text-xs text-destructive-text" role="alert">
          {error}
        </p>
      )}
      <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{pending?.title ?? ''}</DialogTitle>
          <DialogDescription>{pending?.description ?? ''}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="block-prompt-value">
            {pending?.kind === 'latex' ? 'Formel' : pending?.kind === 'database' ? 'Suche' : 'Wert'}
          </Label>
          {pending?.kind === 'latex' ? (
            <Textarea
              id="block-prompt-value"
              autoFocus
              rows={3}
              value={value}
              data-testid="block-prompt-input"
              placeholder={pending.placeholder}
              className="font-mono text-sm"
              onChange={(event) => setValue(event.target.value)}
            />
          ) : (
            <Input
              id="block-prompt-value"
              autoFocus
              value={value}
              data-testid="block-prompt-input"
              placeholder={pending?.placeholder ?? ''}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && pending?.kind !== 'database') {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          )}
          {pending?.kind === 'database' ? (
            <ul className="max-h-64 overflow-y-auto rounded-md border border-border">
              {filteredDatabases.length === 0 ? (
                <li>
                  <EmptyState
                    title="Keine Datenbank gefunden"
                    description="Lege zuerst eine Datenbank in diesem Arbeitsbereich an."
                  />
                </li>
              ) : (
                filteredDatabases.map((database) => (
                  <li key={database.id}>
                    <button
                      type="button"
                      data-testid={`database-prompt-option-${database.id}`}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                      onClick={() =>
                        finish(JSON.stringify({ documentId: database.id, title: database.title }))
                      }
                    >
                      {database.title}
                    </button>
                  </li>
                ))
              )}
            </ul>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => finish(null)}>
            Abbrechen
          </Button>
          {pending?.kind === 'database' ? null : (
            <Button data-testid="block-prompt-submit" onClick={submit}>
              Einfügen
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
      </Dialog>
    </>
  );

  return { ask, element, error };
}
