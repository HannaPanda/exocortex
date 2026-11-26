'use client';

import { type Editor } from '@tiptap/react';
import { SparklesIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { collectBlockIdsInRange } from '@exocortex/editor';

import {
  type SelectedPassage,
  useLiveSelection,
  useOptionalAiSelection,
} from '@/components/ai/ai-selection';
import { useLatest, usePaletteContribution } from '@/components/palette/contributions';
import { keywordsOf, type PaletteCommand } from '@/components/palette/palette-command';

/**
 * How long a selection has to stand still before the chip row hears of it.
 * Dragging across a paragraph is dozens of selection changes, and the offer
 * only matters once the hand has stopped.
 */
const SETTLE_MS = 120;

/**
 * The passage marked in `editor`, or `null` when nothing with words in it is.
 *
 * Exported for the bubble menu's "An KI schicken", so both ways into the chat
 * cut the same text and name the same blocks.
 */
export function selectedPassage(editor: Editor, documentId: string): SelectedPassage | null {
  const { from, to, empty } = editor.state.selection;
  if (empty) return null;
  const text = editor.state.doc.textBetween(from, to, '\n', ' ').trim();
  if (text.length === 0) return null;
  return { documentId, blockIds: collectBlockIdsInRange(editor.state.doc, from, to), text };
}

/**
 * Tells the AI panel what is marked in the text right now (issue #249).
 *
 * Renders nothing. It runs on read-only pages too, unlike the bubble menu:
 * somebody reading a page shared with them can still ask about a sentence on
 * it, and the chat that answers is their own (ADR-092). What it reports is an
 * offer in the chip row and a command in the palette, never something that is
 * sent; taking either is what hands the passage over.
 *
 * Clicking into the composer does not withdraw the offer: ProseMirror keeps
 * its selection when the text loses focus, and that is exactly the moment the
 * offer is for. Collapsing the selection in the text does.
 */
export function AiSelectionReporter({
  editor,
  documentId,
}: {
  editor: Editor;
  documentId: string;
}) {
  const t = useTranslations('shell.paletteCommands.page');
  const live = useLiveSelection();
  const handOver = useOptionalAiSelection()?.handOver;
  const report = live?.report;
  const withdraw = live?.withdraw;

  React.useEffect(() => {
    if (report === undefined || withdraw === undefined) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = (): void => {
      timer = null;
      if (editor.isDestroyed) return;
      report(selectedPassage(editor, documentId));
    };
    const settle = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(read, SETTLE_MS);
    };
    editor.on('selectionUpdate', settle);
    read();
    return () => {
      editor.off('selectionUpdate', settle);
      if (timer !== null) clearTimeout(timer);
      withdraw(documentId);
    };
  }, [editor, documentId, report, withdraw]);

  // Offered while something on this page is marked. Keyed on that one fact
  // rather than on the passage, so a moving selection does not rebuild the
  // palette's list on every keystroke; the passage is read when it runs.
  const marked = live?.live?.documentId === documentId;
  const handlers = useLatest({ editor, documentId, handOver });
  const commands = React.useMemo<readonly PaletteCommand[]>(
    () =>
      !marked || handOver === undefined
        ? []
        : [
            {
              id: 'page-selection-to-ai',
              group: 'page',
              label: t('selectionToAi'),
              icon: <SparklesIcon className="size-4 text-muted-foreground" />,
              keywords: keywordsOf(t('selectionToAiKeywords')),
              run: () => {
                const current = handlers.current;
                const passage = selectedPassage(current.editor, current.documentId);
                if (passage !== null) current.handOver?.(passage);
              },
            },
          ],
    [marked, handOver, handlers, t],
  );
  usePaletteContribution('ai-selection', commands);

  return null;
}
