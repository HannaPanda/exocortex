'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type ProjectSourceArea } from '@exocortex/contracts';

import { useProjectSourceLookup, useProjectSourcePosition } from '@/lib/api/project-queries';

/**
 * The two directions of SyncTeX, tied to the two panes (issue #53, ADR-027).
 *
 * Both of them are one REST call, and that is the point rather than a shortcut:
 * the map is parsed in the API, so the browser's click and an agent's question
 * reach the same answer through the same route (ADR-025). The alternative --
 * download the map and parse it here -- would have been faster per click and
 * would have given the browser a capability nothing else has.
 */

/**
 * How long the caret has to rest before the PDF is asked where it is.
 *
 * Also what keeps typing cheap: the reported line becomes state only after the
 * pause, so a paragraph typed at speed is one request and one re-render rather
 * than one per keystroke.
 */
const CURSOR_SETTLE_MS = 350;

export interface ProjectSourceSync {
  /** Areas the PDF should mark, for the line the caret rests on. */
  highlights: readonly ProjectSourceArea[];
  /** A click in the PDF: opens the file and line that produced that place. */
  pickSource: (position: { page: number; x: number; y: number }) => void;
  /** Called by the editor whenever the caret moves. */
  reportCursor: (line: number) => void;
  /** True while a click is being answered, so the pane can say it is working. */
  picking: boolean;
  /**
   * Why the last click had no answer, in the reader's language. Null when it had one.
   *
   * A click in a margin, on a page from a class file, or in a build whose map
   * was never written all end here. Saying so is worth a line: silence looks
   * like the feature is broken rather than like the answer is "nothing".
   */
  pickError: string | null;
}

export function useProjectSourceSync(input: {
  buildId: string | null;
  file: string | null;
  openFile: (path: string, line: number | null) => void;
}): ProjectSourceSync {
  const { buildId, file, openFile } = input;
  const t = useTranslations('projects.sourceSync');
  const [settledLine, setSettledLine] = React.useState<number | null>(null);
  const [pickError, setPickError] = React.useState<string | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const reportCursor = React.useCallback((line: number): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSettledLine(line), CURSOR_SETTLE_MS);
  }, []);

  const position = useProjectSourcePosition(buildId, file, settledLine);
  const lookup = useProjectSourceLookup(buildId);
  const { mutate } = lookup;

  const pickSource = React.useCallback(
    (clicked: { page: number; x: number; y: number }): void => {
      if (buildId === null) return;
      setPickError(null);
      mutate(clicked, {
        onSuccess: (result) => {
          if (result.file === null) {
            setPickError(t('outsideProject', { path: result.inputPath }));
            return;
          }
          openFile(result.file, result.line);
        },
        onError: () => {
          setPickError(t('noMapping'));
        },
      });
    },
    [buildId, mutate, openFile, t],
  );

  return {
    highlights: position.data?.areas ?? [],
    pickSource,
    reportCursor,
    picking: lookup.isPending,
    pickError,
  };
}
