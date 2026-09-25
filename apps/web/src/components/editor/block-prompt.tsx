'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  type DocumentTreeNode,
  type SavedQuery,
} from '@exocortex/contracts';
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
import { uploadAttachment } from '@/lib/api/attachment-queries';
import { ApiError } from '@/lib/api/client';
import { useDocumentTree } from '@/lib/api/document-queries';
import { useSavedQueries } from '@/lib/api/saved-query-queries';

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
const PICKER_KINDS = new Set<BlockPromptKind>(['page', 'database', 'saved-query']);

/** What the dialog asks for, and what it does with the answer. */
interface PendingPrompt {
  kind: Exclude<BlockPromptKind, 'none' | 'file'>;
  resolve: (value: string | null) => void;
}

/** Where each kind's title, description and placeholder live in `editor.prompt`. */
const PROMPT_COPY_KEY = {
  url: 'url',
  latex: 'latex',
  page: 'page',
  database: 'database',
  'saved-query': 'savedQuery',
} as const satisfies Record<PendingPrompt['kind'], string>;

/** A LaTeX sample for the formula prompt; notation, so it is never translated. */
const LATEX_EXAMPLE = '\\sum_{i=1}^{n} x_i';

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
  /** Message of the last failed upload in the reader's language, or `null`. */
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
  const t = useTranslations('editor.prompt');
  const [pending, setPending] = React.useState<PendingPrompt | null>(null);
  const [value, setValue] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const fileInput = React.useRef<HTMLInputElement | null>(null);
  const fileResolve = React.useRef<((value: string | null) => void) | null>(null);
  const isPicker = pending !== null && PICKER_KINDS.has(pending.kind);
  const isSavedQueryPicker = pending?.kind === 'saved-query';
  const tree = useDocumentTree(isPicker && !isSavedQueryPicker ? workspaceId : undefined);
  const savedQueries = useSavedQueries(isSavedQueryPicker ? workspaceId : undefined);

  const candidates = React.useMemo(() => {
    if (tree.data === undefined || pending === null) return [];
    return collectDocuments(tree.data.nodes, pending.kind === 'database' ? 'COLLECTION' : 'any');
  }, [pending, tree.data]);

  const needle = value.trim().toLowerCase();
  const filtered = React.useMemo(() => {
    if (needle.length === 0) return candidates;
    return candidates.filter((entry) => entry.title.toLowerCase().includes(needle));
  }, [candidates, needle]);

  const filteredSavedQueries = React.useMemo(() => {
    const all = savedQueries.data?.savedQueries ?? [];
    if (needle.length === 0) return all;
    return all.filter((entry) => entry.name.toLowerCase().includes(needle));
  }, [needle, savedQueries.data]);

  /**
   * Whether the typed text is a title no page carries. Obsidian's behaviour:
   * naming a page that does not exist yet is a feature, not a typo, so it gets
   * its own option instead of an empty list.
   */
  const isNewTitle =
    pending?.kind === 'page' &&
    needle.length > 0 &&
    !candidates.some((entry) => entry.title.trim().toLowerCase() === needle);

  /** Opens the hidden file input and resolves with whatever it produces. */
  const askForFile = React.useCallback((): Promise<string | null> => {
    setError(null);
    return new Promise<string | null>((resolve) => {
      fileResolve.current = resolve;
      // Resetting the value makes picking the same file twice fire `change`.
      if (fileInput.current === null) {
        resolve(null);
        return;
      }
      fileInput.current.value = '';
      fileInput.current.click();
    });
  }, []);

  const ask = React.useCallback(
    (kind: BlockPromptKind, initialValue?: string): Promise<string | null> => {
      if (kind === 'none') return Promise.resolve(null);
      if (kind === 'file') return askForFile();

      return new Promise<string | null>((resolve) => {
        setValue(initialValue ?? '');
        setPending({ kind, resolve });
      });
    },
    [askForFile],
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
      setError(uploadError instanceof ApiError ? uploadError.message : t('uploadFailed'));
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

  /**
   * Picks a stored question. The block keeps the id, the name it had at the
   * time and its own row limit, which is smaller than the query's: a block in
   * running text shows a handful, the smart view shows the whole answer.
   */
  const chooseSavedQuery = (chosen: SavedQuery): void =>
    finish(
      JSON.stringify({
        savedQueryId: chosen.id,
        name: chosen.name,
        limit: Math.min(chosen.definition.limit, 5),
      }),
    );

  const submit = (): void => {
    const trimmed = value.trim();
    // A page link may be made for a page that does not exist yet; every other
    // kind answers with the raw string it collected.
    if (trimmed.length === 0) finish(null);
    else if (pending?.kind === 'page') finish(JSON.stringify({ documentId: null, title: trimmed }));
    else finish(trimmed);
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
      <BlockPromptDialog
        pending={pending}
        value={value}
        onValueChange={setValue}
        isPicker={isPicker}
        entries={filtered}
        savedQueries={filteredSavedQueries}
        newTitle={isNewTitle ? value.trim() : null}
        onChoose={choose}
        onChooseSavedQuery={chooseSavedQuery}
        onSubmit={submit}
        onCancel={() => finish(null)}
      />
    </>
  );

  return { ask, element, error };
}

/**
 * The page or database picker's list of candidates.
 *
 * `newTitle` is Obsidian's behaviour: naming a page that does not exist yet is
 * a feature, not a typo, so it gets its own option rather than an empty list.
 */
function PickerList({
  kind,
  entries,
  newTitle,
  onChoose,
  onCreate,
}: {
  kind: BlockPromptKind;
  entries: readonly DocumentTreeNode[];
  newTitle: string | null;
  onChoose: (entry: { id: string; title: string }) => void;
  onCreate: () => void;
}) {
  const t = useTranslations('editor.prompt');
  const isPage = kind === 'page';
  return (
    <ul
      className="max-h-64 overflow-y-auto rounded-md border border-border"
      data-testid={isPage ? 'page-prompt-list' : 'database-prompt-list'}
    >
      {entries.length === 0 && newTitle === null ? (
        <li>
          <EmptyState
            title={isPage ? t('noPageTitle') : t('noDatabaseTitle')}
            description={isPage ? t('noPageDescription') : t('noDatabaseDescription')}
          />
        </li>
      ) : (
        entries.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              data-testid={
                isPage ? `page-prompt-option-${entry.id}` : `database-prompt-option-${entry.id}`
              }
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
              onClick={() => onChoose(entry)}
            >
              {isPage ? (
                <DocumentIcon icon={entry.icon} iconColor={entry.iconColor} type={entry.type} />
              ) : null}
              <span className="min-w-0 flex-1 truncate">{entry.title}</span>
            </button>
          </li>
        ))
      )}
      {newTitle === null ? null : (
        <li>
          <button
            type="button"
            data-testid="page-prompt-new"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent"
            onClick={onCreate}
          >
            {t('linkNewTitle', { title: newTitle })}
          </button>
        </li>
      )}
    </ul>
  );
}

/**
 * The list of stored questions (issue #74).
 *
 * Its own list rather than a branch in `PickerList`, because a saved query is
 * not a document: it has no icon of its own to fall back on, and what tells
 * two of them apart is the description rather than the path.
 */
function SavedQueryPickerList({
  entries,
  onChoose,
}: {
  entries: readonly SavedQuery[];
  onChoose: (entry: SavedQuery) => void;
}) {
  const t = useTranslations('editor.prompt');
  return (
    <ul
      className="max-h-64 overflow-y-auto rounded-md border border-border"
      data-testid="saved-query-prompt-list"
    >
      {entries.length === 0 ? (
        <li>
          <EmptyState title={t('noSavedQueryTitle')} description={t('noSavedQueryDescription')} />
        </li>
      ) : (
        entries.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              data-testid={`saved-query-prompt-option-${entry.id}`}
              className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm hover:bg-accent"
              onClick={() => onChoose(entry)}
            >
              <span className="w-full truncate">{entry.name}</span>
              {entry.description === null ? null : (
                <span className="w-full truncate text-xs text-muted-foreground">
                  {entry.description}
                </span>
              )}
            </button>
          </li>
        ))
      )}
    </ul>
  );
}

/** The dialog half of `useBlockPrompt`: one input, optionally a picker below it. */
function BlockPromptDialog({
  pending,
  value,
  onValueChange,
  isPicker,
  entries,
  savedQueries,
  newTitle,
  onChoose,
  onChooseSavedQuery,
  onSubmit,
  onCancel,
}: {
  pending: PendingPrompt | null;
  value: string;
  onValueChange: (next: string) => void;
  isPicker: boolean;
  entries: readonly DocumentTreeNode[];
  savedQueries: readonly SavedQuery[];
  newTitle: string | null;
  onChoose: (entry: { id: string; title: string }) => void;
  onChooseSavedQuery: (entry: SavedQuery) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('editor.prompt');
  const copy = pending === null ? null : PROMPT_COPY_KEY[pending.kind];
  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{copy === null ? '' : t(`${copy}.title`)}</DialogTitle>
          <DialogDescription>
            {copy === null ? '' : t(`${copy}.description`, { example: LATEX_EXAMPLE })}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="block-prompt-value">
            {pending?.kind === 'latex'
              ? t('fieldFormula')
              : isPicker
                ? t('fieldSearch')
                : t('fieldValue')}
          </Label>
          {pending?.kind === 'latex' ? (
            <Textarea
              id="block-prompt-value"
              autoFocus
              rows={3}
              value={value}
              data-testid="block-prompt-input"
              placeholder={t('latex.placeholder')}
              className="font-mono text-sm"
              onChange={(event) => onValueChange(event.target.value)}
            />
          ) : (
            <Input
              id="block-prompt-value"
              autoFocus
              value={value}
              data-testid="block-prompt-input"
              placeholder={copy === null ? '' : t(`${copy}.placeholder`)}
              onChange={(event) => onValueChange(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  pending?.kind !== 'database' &&
                  pending?.kind !== 'saved-query'
                ) {
                  event.preventDefault();
                  onSubmit();
                }
              }}
            />
          )}
          {isPicker && pending !== null ? (
            pending.kind === 'saved-query' ? (
              <SavedQueryPickerList entries={savedQueries} onChoose={onChooseSavedQuery} />
            ) : (
              <PickerList
                kind={pending.kind}
                entries={entries}
                newTitle={newTitle}
                onChoose={onChoose}
                onCreate={onSubmit}
              />
            )
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            {t('cancel')}
          </Button>
          {pending?.kind === 'database' || pending?.kind === 'saved-query' ? null : (
            <Button data-testid="block-prompt-submit" onClick={onSubmit}>
              {t('insert')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
