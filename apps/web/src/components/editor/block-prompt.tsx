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

import { DocumentIcon } from '@/components/document/document-icon';
import { ApiError } from '@/lib/api/client';
import { uploadAttachment, useDocumentTree } from '@/lib/api/queries';

/**
 * Flattens the tree for a picker.
 *
 * `'COLLECTION'` selects databases, `'any'` every page — a page link may point
 * at a database page just as well as at an ordinary one, and the resolution
 * endpoint makes no distinction either.
 */
function collectDocuments(
  nodes: readonly DocumentTreeNode[],
  kind: 'COLLECTION' | 'any',
): DocumentTreeNode[] {
  const result: DocumentTreeNode[] = [];
  for (const node of nodes) {
    if (kind === 'any' || node.type === kind) result.push(node);
    result.push(...collectDocuments(node.children, kind));
  }
  return result;
}

/** Kinds whose dialog is a picker over the workspace rather than a free field. */
const PICKER_KINDS = new Set<BlockPromptKind>(['page', 'database']);

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
    description:
      'Wähle eine Seite aus diesem Arbeitsbereich. Tippst du einen Titel, den es noch nicht ' +
      'gibt, entsteht ein Verweis, der anbietet, die Seite anzulegen.',
    placeholder: 'Seite suchen …',
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
   *
   * `initialValue` pre-fills the field, which is what turns the picker into an
   * editor for a block that already has a target (issue #14).
   */
  ask: (kind: BlockPromptKind, initialValue?: string) => Promise<string | null>;
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
 * page, a database, or an uploaded file.
 *
 * A promise-returning `ask` keeps the call sites readable: an entry with
 * `prompt: 'url'` is executed as `run(editor, await ask('url'))` instead of
 * spreading the flow across three pieces of component state.
 *
 * The two picker kinds answer with JSON (`{ documentId, title }`) rather than a
 * bare string, because a reference to a page is an identity plus a label, not a
 * label alone.
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
  const isPicker = pending !== null && PICKER_KINDS.has(pending.kind);
  const tree = useDocumentTree(isPicker ? workspaceId : undefined);

  const candidates = React.useMemo(() => {
    if (tree.data === undefined || pending === null) return [];
    return collectDocuments(tree.data.nodes, pending.kind === 'database' ? 'COLLECTION' : 'any');
  }, [pending, tree.data]);

  const needle = value.trim().toLowerCase();
  const filtered = React.useMemo(() => {
    if (needle.length === 0) return candidates;
    return candidates.filter((entry) => entry.title.toLowerCase().includes(needle));
  }, [candidates, needle]);

  /**
   * Whether the typed text is a title no page carries. Obsidian's behaviour:
   * naming a page that does not exist yet is a feature, not a typo, so it gets
   * its own option instead of an empty list.
   */
  const isNewTitle =
    pending?.kind === 'page' &&
    needle.length > 0 &&
    !candidates.some((entry) => entry.title.trim().toLowerCase() === needle);

  const ask = React.useCallback(
    (kind: BlockPromptKind, initialValue?: string): Promise<string | null> => {
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
        setValue(initialValue ?? '');
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

  /** Picks an existing page or database: the answer carries the identity. */
  const choose = (chosen: { id: string; title: string }): void =>
    finish(JSON.stringify({ documentId: chosen.id, title: chosen.title }));

  const submit = (): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      finish(null);
      return;
    }
    // A page link may be made for a page that does not exist yet; every other
    // kind answers with the raw string it collected.
    finish(pending?.kind === 'page' ? JSON.stringify({ documentId: null, title: trimmed }) : trimmed);
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
            {pending?.kind === 'latex' ? 'Formel' : isPicker ? 'Suche' : 'Wert'}
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
          {isPicker ? (
            <ul
              className="max-h-64 overflow-y-auto rounded-md border border-border"
              data-testid={pending?.kind === 'page' ? 'page-prompt-list' : 'database-prompt-list'}
            >
              {filtered.length === 0 && !isNewTitle ? (
                <li>
                  <EmptyState
                    title={
                      pending?.kind === 'page' ? 'Keine Seite gefunden' : 'Keine Datenbank gefunden'
                    }
                    description={
                      pending?.kind === 'page'
                        ? 'Tippe einen Titel, um einen Verweis auf eine noch nicht angelegte Seite zu setzen.'
                        : 'Lege zuerst eine Datenbank in diesem Arbeitsbereich an.'
                    }
                  />
                </li>
              ) : (
                filtered.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      data-testid={
                        pending?.kind === 'page'
                          ? `page-prompt-option-${entry.id}`
                          : `database-prompt-option-${entry.id}`
                      }
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                      onClick={() => choose(entry)}
                    >
                      {pending?.kind === 'page' ? (
                        <DocumentIcon
                          icon={entry.icon}
                          iconColor={entry.iconColor}
                          type={entry.type}
                        />
                      ) : null}
                      <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                    </button>
                  </li>
                ))
              )}
              {isNewTitle ? (
                <li>
                  <button
                    type="button"
                    data-testid="page-prompt-new"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted"
                    onClick={submit}
                  >
                    „{value.trim()}“ als noch nicht angelegte Seite verknüpfen
                  </button>
                </li>
              ) : null}
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
